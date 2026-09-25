// Real shared backend for the planner, replacing localStorage. Keeps the exact
// same get/set/delete/list contract storage-adapter.js already expects.
//
// The app always sends an already-JSON-stringified string as `value` (see
// storeSet in the planner). To avoid any ambiguity around Upstash Redis's own
// automatic (de)serialization of plain strings, every value is wrapped in a
// small object ({ data: value }) before being written — that keeps the shape
// unambiguous on the way back out, regardless of what Redis does internally
// with bare strings.

import { Redis } from '@upstash/redis';

const kv = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

const ALL_KEYS_SET = 'studio-ops:all-keys';
const dataKey = (k) => 'studio-ops:data:' + k;

export default async function handler(req, res) {
  try {
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

    if (req.method === 'POST') {
      const { key, value } = req.body || {};
      if (!key) return res.status(400).json({ error: 'key is required' });
      await kv.set(dataKey(key), { data: value });
      await kv.sadd(ALL_KEYS_SET, key);
      return res.status(200).json({ key, value });
    }

    if (req.method === 'DELETE') {
      const { key } = req.query;
      if (!key) return res.status(400).json({ error: 'key is required' });
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
