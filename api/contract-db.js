// Real shared backend for Contract Tracking, replacing localStorage. Mimics
// the collection/doc shape the artifact's original db capability used, so
// contract-tracking-adapter.js only has to change how it reaches this API,
// not how it calls it.

import { Redis } from '@upstash/redis';

const kv = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

const docKey = (path) => 'contract-desk:doc:' + path;
const indexKey = (collection) => 'contract-desk:index:' + collection;

function splitPath(path) {
  const i = path.indexOf('/');
  return i === -1 ? { collection: path, id: '' } : { collection: path.slice(0, i), id: path.slice(i + 1) };
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { op, path } = req.query;
      if (!path) return res.status(400).json({ error: 'path is required' });

      if (op === 'collection') {
        const ids = (await kv.smembers(indexKey(path))) || [];
        const docs = [];
        for (const id of ids) {
          const data = await kv.get(docKey(path + '/' + id));
          if (data !== null && data !== undefined) docs.push({ id, data });
        }
        return res.status(200).json({ docs });
      }

      if (op === 'doc') {
        const data = await kv.get(docKey(path));
        return res.status(200).json({ exists: data !== null && data !== undefined, data: data ?? null });
      }

      return res.status(400).json({ error: 'op must be "collection" or "doc"' });
    }

    if (req.method === 'POST') {
      const { op, path, data } = req.body || {};
      if (!path) return res.status(400).json({ error: 'path is required' });
      const { collection, id } = splitPath(path);

      if (op === 'set') {
        await kv.set(docKey(path), data);
        if (id) await kv.sadd(indexKey(collection), id);
        return res.status(200).json({ ok: true });
      }

      if (op === 'update') {
        const current = (await kv.get(docKey(path))) || {};
        const merged = Object.assign({}, current, data);
        await kv.set(docKey(path), merged);
        if (id) await kv.sadd(indexKey(collection), id);
        return res.status(200).json({ ok: true });
      }

      if (op === 'delete') {
        await kv.del(docKey(path));
        if (id) await kv.srem(indexKey(collection), id);
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'op must be "set", "update" or "delete"' });
    }

    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('api/contract-db error', e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
