/**
 * STORAGE ADAPTER — shared database (Upstash Redis via /api/storage).
 * Same window.storage.get/set/delete/list interface index.html uses.
 *
 * Now sends the signed-in person's Clerk session token with every request, so the
 * server can check who they are and what their role allows. The token comes from
 * index.html (window.__getAuthToken) once Clerk has loaded.
 * ================================================================= */

(function () {
  async function authHeaders(extra) {
    const h = Object.assign({}, extra || {});
    try {
      if (typeof window.__getAuthToken === 'function') {
        const t = await window.__getAuthToken();
        if (t) h['Authorization'] = 'Bearer ' + t;
      }
    } catch (e) { /* not signed in yet */ }
    return h;
  }
  async function fail(res, what) {
    let msg = '';
    try { msg = (await res.json()).error || ''; } catch (e) {}
    const err = new Error('Storage ' + what + ' failed: ' + res.status + (msg ? ' — ' + msg : ''));
    err.status = res.status; err.reason = msg;
    throw err;
  }

  window.storage = {
    async get(key) {
      const res = await fetch('/api/storage?key=' + encodeURIComponent(key), { headers: await authHeaders() });
      if (res.status === 404) throw new Error('Key not found: ' + key);
      if (!res.ok) await fail(res, 'get');
      const json = await res.json();
      return { key: json.key, value: json.value, shared: true };
    },

    async set(key, value) {
      const res = await fetch('/api/storage', {
        method: 'POST',
        headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ key, value }),
      });
      if (!res.ok) await fail(res, 'set');
      const json = await res.json();
      return { key: json.key, value: json.value, shared: true };
    },

    async delete(key) {
      const res = await fetch('/api/storage?key=' + encodeURIComponent(key), { method: 'DELETE', headers: await authHeaders() });
      if (!res.ok) await fail(res, 'delete');
      const json = await res.json();
      return { key: json.key, deleted: json.deleted, shared: true };
    },

    async list(prefix) {
      const qs = prefix ? '&prefix=' + encodeURIComponent(prefix) : '';
      const res = await fetch('/api/storage?list=1' + qs, { headers: await authHeaders() });
      if (!res.ok) await fail(res, 'list');
      const json = await res.json();
      return { keys: json.keys, prefix, shared: true };
    },
  };
})();
