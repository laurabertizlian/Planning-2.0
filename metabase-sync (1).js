// Runs on a schedule (see vercel.json). For each client with a Metabase
// Account mapping and a Feed Sync Time, once that time has passed for today
// (and only once per day — tracked via a small "already synced today" marker
// in KV), pulls that client's current number from Metabase and writes it as
// today's Starting Target on the Styling task.
//
// Supports MULTIPLE Metabase sources — different Questions, different
// Dashboards, even entirely different Metabase instances/URLs — configured
// via the METABASE_SOURCES environment variable (see parseSources below).
// Each source is queried independently and the results are merged.
//
// ASSUMPTIONS I had to make without a live Metabase instance to test against —
// check these first if something doesn't work:
//   1. Auth: this calls Metabase with an `x-api-key` header (Metabase's newer
//      API-key auth). If your instance is older and uses session-token auth
//      instead, this fetch call needs to change to a login step first.
//   2. Each configured Question returns two columns — an account name/ID and
//      a number — one row per account, representing the CURRENT value to use
//      as today's Starting Target (not a historical series).
//   3. This applies to the Styling task type only (the type this whole
//      Metabase conversation started with). OOS/STM aren't touched here —
//      ask if you want those wired up too.
//   4. The monthly-goal cap ("Capped to Monthly Goal" clients) is NOT
//      enforced by this function yet — that logic currently only runs when a
//      person edits a task through the app itself. A capped client's number
//      will be written as-is here; flag it if you want this closed too.

import { Redis } from '@upstash/redis';

const kv = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

const dataKey = (k) => 'studio-ops:data:' + k;

async function readAppValue(key) {
  const rec = await kv.get(dataKey(key));
  if (rec === null || rec === undefined) return null;
  try { return JSON.parse(rec.data); } catch (e) { return null; }
}
async function writeAppValue(key, value) {
  await kv.set(dataKey(key), { data: JSON.stringify(value) });
}

function fmtDateUTC(d) {
  return d.toISOString().slice(0, 10);
}
function isWeekendUTC(d) {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}
function findCol(cols, candidates) {
  const names = cols.map((c) => String(c.name || c.display_name || '').toLowerCase());
  for (const cand of candidates) {
    const i = names.findIndex((n) => n.includes(cand));
    if (i !== -1) return i;
  }
  return -1;
}

async function queryOneSource(source) {
  const url = `${source.url}/api/card/${source.questionId}/query`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': source.apiKey,
      'Content-Type': 'application/json',
    },
  });
  if (!resp.ok) throw new Error(`Metabase query failed for ${source.url} (question ${source.questionId}): ${resp.status} ${await resp.text()}`);
  const json = await resp.json();
  const cols = json.data.cols;
  const rows = json.data.rows;
  const accountIdx = findCol(cols, ['account', 'client', 'name']);
  const valueIdx = findCol(cols, ['value', 'items', 'target', 'count']);
  if (accountIdx === -1 || valueIdx === -1) {
    throw new Error(`Could not find account/value columns for ${source.url} (question ${source.questionId}). Columns seen: ${cols.map((c) => c.name).join(', ')}`);
  }
  const byAccount = new Map();
  for (const row of rows) {
    const acc = String(row[accountIdx] ?? '').trim().toLowerCase();
    const val = Number(row[valueIdx]);
    if (acc && isFinite(val)) byAccount.set(acc, val);
  }
  return byAccount;
}

// Reads METABASE_SOURCES — a JSON array of {url, apiKey, questionId} — so
// this can pull from several different questions, dashboards, or even
// entirely separate Metabase instances and merge them into one combined
// lookup. If the same account name shows up in more than one source, the
// LAST source in the array wins for that account — order sources so any
// overlap resolves the way you want, or better, keep account sets
// non-overlapping across sources so this never comes up.
function parseSources() {
  const raw = process.env.METABASE_SOURCES;
  if (!raw) throw new Error('METABASE_SOURCES environment variable is not set');
  let sources;
  try { sources = JSON.parse(raw); } catch (e) { throw new Error('METABASE_SOURCES is not valid JSON: ' + e.message); }
  if (!Array.isArray(sources) || sources.length === 0) throw new Error('METABASE_SOURCES must be a non-empty JSON array');
  return sources;
}

async function queryMetabase() {
  const sources = parseSources();
  const combined = new Map();
  const errors = [];
  for (const source of sources) {
    try {
      const byAccount = await queryOneSource(source);
      byAccount.forEach((val, acc) => combined.set(acc, val)); // later sources overwrite on collision
    } catch (e) {
      errors.push(String((e && e.message) || e));
    }
  }
  if (combined.size === 0 && errors.length > 0) {
    throw new Error('All Metabase sources failed: ' + errors.join(' | '));
  }
  return { combined, errors };
}

// Mirrors the app's own applyDayStartingTarget: keeps each existing piece's
// relative share of the day if it's already been split across stylists.
function applyDayStartingTarget(pieces, dayTotal) {
  if (pieces.length === 1) {
    const t = pieces[0];
    t.startingTarget = dayTotal;
    const rate = parseFloat(t.rate);
    if (!isNaN(rate) && rate !== 0) t.estimatedHours = Math.round((dayTotal / rate) * 100) / 100;
    return;
  }
  const oldTotal = pieces.reduce((s, t) => s + (parseFloat(t.startingTarget) || 0), 0);
  let remaining = dayTotal;
  pieces.forEach((t, idx) => {
    const isLast = idx === pieces.length - 1;
    const ratio = oldTotal > 0 ? (parseFloat(t.startingTarget) || 0) / oldTotal : 1 / pieces.length;
    const piece = isLast ? remaining : Math.round(dayTotal * ratio);
    remaining -= piece;
    t.startingTarget = piece;
    const rate = parseFloat(t.rate);
    if (!isNaN(rate) && rate !== 0) t.estimatedHours = Math.round((piece / rate) * 100) / 100;
  });
}

export default async function handler(req, res) {
  // Vercel automatically sends this header for scheduled invocations when
  // CRON_SECRET is set — this keeps the route from being triggered by anyone
  // who finds the URL.
  if (process.env.CRON_SECRET) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  try {
    const clients = (await readAppValue('clients')) || [];
    const now = new Date();
    const today = fmtDateUTC(now);
    const nowHM = now.toISOString().slice(11, 16); // "HH:MM" in UTC

    const eligible = clients.filter((c) => c.metabaseAccount && c.feedSyncTime && c.feedSyncTime <= nowHM);
    if (eligible.length === 0) {
      return res.status(200).json({ ok: true, message: 'No clients due for a sync check right now.', checked: 0 });
    }

    const alreadySyncedMap = (await readAppValue('metabase_sync_dates')) || {};
    const due = eligible.filter((c) => alreadySyncedMap[c.id] !== today);
    if (due.length === 0) {
      return res.status(200).json({ ok: true, message: 'Everyone due today has already synced.', checked: eligible.length });
    }

    let metabaseData, sourceErrors;
    try {
      const result = await queryMetabase();
      metabaseData = result.combined;
      sourceErrors = result.errors;
    } catch (e) {
      return res.status(502).json({ error: 'Metabase query failed', detail: String((e && e.message) || e) });
    }

    const results = [];
    for (const client of due) {
      const value = metabaseData.get(String(client.metabaseAccount).trim().toLowerCase());
      if (value === undefined) {
        results.push({ client: client.name, status: 'no matching account in Metabase results' });
        continue;
      }
      if (isWeekendUTC(now)) {
        results.push({ client: client.name, status: 'skipped — weekend' });
        alreadySyncedMap[client.id] = today;
        continue;
      }

      const tasks = (await readAppValue('tasks:' + client.id)) || [];
      const pieces = tasks.filter((t) => t.taskType === 'Styling' && t.dueDate === today);
      if (pieces.length === 0) {
        results.push({ client: client.name, status: 'no Styling task found for today' });
        continue;
      }

      applyDayStartingTarget(pieces, value);
      await writeAppValue('tasks:' + client.id, tasks);
      alreadySyncedMap[client.id] = today;
      results.push({ client: client.name, status: 'updated', startingTarget: value });
    }

    await writeAppValue('metabase_sync_dates', alreadySyncedMap);
    const response = { ok: true, checked: eligible.length, updated: results };
    if (sourceErrors && sourceErrors.length > 0) response.sourceErrors = sourceErrors;
    return res.status(200).json(response);
  } catch (e) {
    console.error('metabase-sync error', e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
