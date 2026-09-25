/**
 * STORAGE ADAPTER — now backed by a real shared database (Vercel KV via
 * /api/storage), not localStorage. Same window.storage.get/set/delete/list
 * interface as before, so index.html needed zero changes for this upgrade —
 * only this file changed.
 *
 * Everyone who opens this URL now reads and writes the same data.
 * ================================================================= */

(function () {
  window.storage = {
    async get(key) {
      const res = await fetch('/api/storage?key=' + encodeURIComponent(key));
      if (res.status === 404) throw new Error('Key not found: ' + key);
      if (!res.ok) throw new Error('Storage get failed: ' + res.status);
      const json = await res.json();
      return { key: json.key, value: json.value, shared: true };
    },

    async set(key, value) {
      const res = await fetch('/api/storage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      if (!res.ok) throw new Error('Storage set failed: ' + res.status);
      const json = await res.json();
      return { key: json.key, value: json.value, shared: true };
    },

    async delete(key) {
      const res = await fetch('/api/storage?key=' + encodeURIComponent(key), { method: 'DELETE' });
      if (!res.ok) throw new Error('Storage delete failed: ' + res.status);
      const json = await res.json();
      return { key: json.key, deleted: json.deleted, shared: true };
    },

    async list(prefix) {
      const qs = prefix ? '&prefix=' + encodeURIComponent(prefix) : '';
      const res = await fetch('/api/storage?list=1' + qs);
      if (!res.ok) throw new Error('Storage list failed: ' + res.status);
      const json = await res.json();
      return { keys: json.keys, prefix, shared: true };
    },
  };
})();
