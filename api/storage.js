// Shared backend for the planner (Upstash Redis). Same get/set/delete/list contract
// storage-adapter.js expects — now with sign-in and role checks.
//
// • Every request must carry a valid Clerk session token (sent by storage-adapter.js).
// • Anyone signed in can READ (the app needs the shared data to work).
// • WRITES are checked against the person's role and the Permissions set in
//   Settings: e.g. only admins can change permissions or other people's accounts,
//   nobody can make themselves an admin, and a Stylist can't change goals or rates.
//
// If CLERK_SECRET_KEY isn't set in Vercel yet, this behaves exactly like before
// (no checks) so nothing breaks mid-rollout — a warning is logged instead.
//
// Values: the app always sends an already-JSON-stringified string as `value`. Each
// value is wrapped as { data: value } before it's written so the shape is unambiguous.

import { Redis } from '@upstash/redis';
import { verifyToken, createClerkClient } from '@clerk/backend';

const kv = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
const SECRET = process.env.CLERK_SECRET_KEY || '';

const ALL_KEYS_SET = 'studio-ops:all-keys';
const dataKey = (k) => 'studio-ops:data:' + k;

// Keep in step with OWNER_EMAIL / AUTO_ADMIN_EMAILS in index.html.
const OWNER_EMAIL = 'laura.bertizlian@stylitics.com';
const AUTO_ADMIN_EMAILS = ['mila.damchevska@stylitics.com'];

/* ---------------- permission rules (mirrors Settings → Permissions) ---------------- */
const OPS_ROLES = ['ops_lead', 'ops_assistant'];
const STYLING_ROLES = ['stylist', 'styling_lead', 'styling_manager'];
const PAGES = ['mydashboard','ptocalendar','clients','workload','all','reports','analytics','training','goalplan','recurring','rates','settings','contract'];
function defaultPermissions() {
  const make = (pages) => Object.fromEntries(PAGES.map((k) => [k, { see: pages.includes(k), edit: pages.includes(k) }]));
  const styling = make(['mydashboard', 'ptocalendar']);
  const ops = make(PAGES.filter((k) => !['training', 'goalplan', 'workload', 'settings'].includes(k)));
  ops.rates = { see: true, edit: false };
  return { stylist: styling, styling_lead: styling, styling_manager: styling, ops_lead: ops, ops_assistant: ops };
}
// Which page(s) a shared key is edited from. Having edit access to any of them allows the write.
const KEY_PAGES = {
  clients: ['clients', 'goalplan', 'reports', 'training'],
  training_matrix: ['training'],
  monthly_goals: ['goalplan', 'reports'],
  daily_amounts: ['goalplan'],
  recurring_rules: ['recurring'],
  client_rates: ['rates'], task_defaults: ['rates', 'goalplan'],
  stylists: ['settings'], ops_leads: ['settings'], method_options: ['settings'], additional_types: ['settings'],
  holidays_us: ['settings'], holidays_macedonia: ['settings'], auto_split_threshold: ['settings'],
  announcements: ['settings'], custom_fields: ['settings', 'all'],
};
const ADMIN_ONLY_KEYS = ['permissions', 'field_permissions'];
const ANY_MEMBER_KEYS = ['rolling_tasks_extended_on']; // housekeeping the app writes on load

function canEditPage(role, page, savedPerms) {
  if (role === 'admin') return true;
  const def = defaultPermissions()[role];
  if (!def) return false;
  const saved = savedPerms && savedPerms[role] && savedPerms[role][page];
  const p = saved ? { see: !!saved.see, edit: !!saved.see && !!saved.edit } : def[page];
  return !!(p && p.edit);
}

// Pure decision function (exported for testing). Returns null if allowed, or a reason string.
export function checkWrite({ uid, email, rec }, key, newVal, oldVal, savedPerms) {
  const isAdmin = !!(rec && rec.isAdmin) || email === OWNER_EMAIL;
  const role = isAdmin ? 'admin' : (rec && rec.role) || '';
  const k = String(key);

  if (k.startsWith('user:')) {
    const target = k.slice(5);
    if (isAdmin) return null;
    if (target !== uid) return "You can only change your own account.";
    if (newVal === null) return "Only an admin can remove accounts.";
    if (!newVal || newVal.id !== uid) return "Invalid account record.";
    const autoAdmin = email === OWNER_EMAIL || AUTO_ADMIN_EMAILS.includes(email);
    if (!oldVal) {
      if (newVal.isAdmin || newVal.role) { if (!(autoAdmin && newVal.isAdmin)) return "New accounts start pending — an admin approves the role."; }
      return null;
    }
    const same = (f) => JSON.stringify(oldVal[f] ?? null) === JSON.stringify(newVal[f] ?? null);
    for (const f of ['role', 'isAdmin', 'linkedStylistId', 'linkedOpsLeadId', 'approvedAt']) if (!same(f)) return "Only an admin can change roles or linked names.";
    return null;
  }
  if (k === 'user_index') {
    if (isAdmin) return null;
    const before = Array.isArray(oldVal) ? oldVal : [], after = Array.isArray(newVal) ? newVal : [];
    return before.every((id) => after.includes(id)) ? null : "Only an admin can remove accounts.";
  }
  if (!rec && !isAdmin) return "Finish setting up your account first.";
  if (ADMIN_ONLY_KEYS.includes(k)) return isAdmin ? null : "Only an admin can change permissions.";
  if (isAdmin) return null;
  if (k.startsWith('tasks:') || k.startsWith('archive:')) return null; // field-level limits are applied in the app
  if (k.startsWith('migration_') || ANY_MEMBER_KEYS.includes(k)) return null;
  const pages = KEY_PAGES[k];
  if (pages) return pages.some((p) => canEditPage(role, p, savedPerms)) ? null : "Your role can't change this.";
  return OPS_ROLES.includes(role) ? null : "Your role can't change this.";
}

/* ---------------- helpers ---------------- */
async function readValue(key) {
  const rec = await kv.get(dataKey(key));
  if (rec === null || rec === undefined) return null;
  try { return typeof rec.data === 'string' ? JSON.parse(rec.data) : rec.data; } catch { return rec.data; }
}
let clerk = null;
async function emailFor(uid) {
  try {
    clerk = clerk || createClerkClient({ secretKey: SECRET });
    const u = await clerk.users.getUser(uid);
    const primary = (u.emailAddresses || []).find((e) => e.id === u.primaryEmailAddressId) || (u.emailAddresses || [])[0];
    return primary ? String(primary.emailAddress).toLowerCase() : '';
  } catch { return ''; }
}
async function getCaller(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  try {
    const payload = await verifyToken(token, { secretKey: SECRET });
    return { uid: payload.sub };
  } catch { return null; }
}

/* ---------------- handler ---------------- */
export default async function handler(req, res) {
  try {
    let caller = null;
    if (SECRET) {
      caller = await getCaller(req);
      if (!caller) return res.status(401).json({ error: 'Please sign in again.' });
    } else {
      console.warn('api/storage: CLERK_SECRET_KEY is not set — requests are not being checked.');
    }

    if (req.method === 'GET') {
      const { key, list, prefix } = req.query;
      if (list !== undefined) {
        const allKeys = (await kv.smembers(ALL_KEYS_SET)) || [];
        const filtered = prefix ? allKeys.filter((k) => k.startsWith(prefix)) : allKeys;
        return res.status(200).json({ keys: filtered });
      }
      if (!key) return res.status(400).json({ error: 'key is required' });
      const rec = await kv.get(dataKey(key));
      if (rec === null || rec === undefined) return res.status(404).json({ error: 'not found' });
      return res.status(200).json({ key, value: rec.data });
    }

    if (req.method === 'POST' || req.method === 'DELETE') {
      const key = req.method === 'POST' ? (req.body || {}).key : req.query.key;
      if (!key) return res.status(400).json({ error: 'key is required' });
      const value = req.method === 'POST' ? (req.body || {}).value : undefined;

      if (SECRET) {
        const rec = await readValue('user:' + caller.uid);
        const needsEmail = String(key).startsWith('user:') || !rec;
        const email = needsEmail ? await emailFor(caller.uid) : (rec.email || '');
        let newVal = null;
        if (req.method === 'POST') { try { newVal = typeof value === 'string' ? JSON.parse(value) : value; } catch { newVal = value; } }
        const oldVal = (String(key).startsWith('user') ) ? await readValue(key) : null;
        const perms = await readValue('permissions');
        const reason = checkWrite({ uid: caller.uid, email, rec }, key, newVal, oldVal, perms);
        if (reason) return res.status(403).json({ error: reason });
      }

      if (req.method === 'POST') {
        await kv.set(dataKey(key), { data: value });
        await kv.sadd(ALL_KEYS_SET, key);
        return res.status(200).json({ key, value });
      }
      await kv.del(dataKey(key));
      await kv.srem(ALL_KEYS_SET, key);
      return res.status(200).json({ key, deleted: true });
    }

    res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('api/storage error', e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
