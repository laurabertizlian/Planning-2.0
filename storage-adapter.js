/**
 * STORAGE ADAPTER — temporary, browser-only implementation
 * ---------------------------------------------------------------
 * The app (index.html) talks to `window.storage.get/set/delete/list`.
 * Inside Claude.ai, that's Claude's built-in persistence. Outside of
 * it — like here on Vercel — nothing provides that object, so this
 * file stands in for it using the browser's localStorage.
 *
 * IMPORTANT LIMITATION: localStorage is per-browser, per-device.
 * Data typed in on one stylist's laptop will NOT show up on anyone
 * else's. This is fine for testing/demoing the app solo, but it is
 * NOT a substitute for shared team data — everyone will effectively
 * have their own separate copy of the tool.
 *
 * WHEN YOU'RE READY FOR REAL SHARED PERSISTENCE:
 * Replace the four function bodies below with calls to your own
 * backend (e.g. a Vercel Serverless Function backed by Vercel KV,
 * Supabase, Firebase, etc). Keep the same function names, arguments,
 * and return shapes, and index.html requires no other changes.
 *
 * Example swap-in using a Vercel KV-backed API route at /api/storage:
 *
 *   async get(key, shared) {
 *     const res = await fetch(`/api/storage?key=${encodeURIComponent(key)}&shared=${!!shared}`);
 *     if (!res.ok) throw new Error('Key not found: ' + key);
 *     return res.json(); // { key, value, shared }
 *   },
 *   async set(key, value, shared) {
 *     const res = await fetch('/api/storage', {
 *       method: 'POST',
 *       headers: { 'Content-Type': 'application/json' },
 *       body: JSON.stringify({ key, value, shared: !!shared }),
 *     });
 *     return res.json();
 *   },
 *   // ...delete -> DELETE /api/storage, list -> GET /api/storage/list
 *
 * That API route would use @vercel/kv (kv.get / kv.set / kv.del / kv.keys)
 * on the server side. Happy to write that route for you when you're ready.
 * ================================================================= */

(function () {
  const NS_PREFIX = 'studio-ops:';
  const nsKey = (key) => NS_PREFIX + key;

  window.storage = {
    async get(key, shared) {
      const raw = localStorage.getItem(nsKey(key));
      if (raw === null) {
        throw new Error('Key not found: ' + key);
      }
      return { key, value: raw, shared: !!shared };
    },

    async set(key, value, shared) {
      localStorage.setItem(nsKey(key), value);
      return { key, value, shared: !!shared };
    },

    async delete(key, shared) {
      const existed = localStorage.getItem(nsKey(key)) !== null;
      localStorage.removeItem(nsKey(key));
      return { key, deleted: existed, shared: !!shared };
    },

    async list(prefix, shared) {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const fullKey = localStorage.key(i);
        if (fullKey && fullKey.startsWith(NS_PREFIX)) {
          const bareKey = fullKey.slice(NS_PREFIX.length);
          if (!prefix || bareKey.startsWith(prefix)) keys.push(bareKey);
        }
      }
      return { keys, prefix, shared: !!shared };
    },
  };
})();
