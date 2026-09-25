/**
 * CLAUDE RUNTIME ADAPTER — now backed by a real shared database (Vercel KV
 * via /api/contract-db), not localStorage. Same claude.use("db"/"downloads"/
 * "user") interface as before, so index.html needed zero changes for this
 * upgrade — only this file changed.
 *
 * Everyone who opens this URL now reads and writes the same contracts,
 * actuals, and change log. Live updates across different people's browsers
 * work via short polling (every 8s) rather than a true push connection —
 * good enough for this kind of dashboard; nobody needs sub-second updates
 * on contract pacing.
 * ================================================================= */

(function () {
  const API = '/api/contract-db';
  const POLL_MS = 8000;

  async function apiGetCollection(path) {
    const res = await fetch(API + '?op=collection&path=' + encodeURIComponent(path));
    if (!res.ok) throw new Error('contract-db collection fetch failed: ' + res.status);
    return res.json(); // { docs: [{id, data}] }
  }
  async function apiGetDoc(path) {
    const res = await fetch(API + '?op=doc&path=' + encodeURIComponent(path));
    if (!res.ok) throw new Error('contract-db doc fetch failed: ' + res.status);
    return res.json(); // { exists, data }
  }
  async function apiWrite(op, path, data) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, path, data }),
    });
    if (!res.ok) throw new Error('contract-db write failed: ' + res.status);
    return res.json();
  }

  function collectionSnapshotObj(json) {
    return { docs: json.docs.map(d => ({ id: d.id, data: () => d.data })) };
  }
  function docSnapshotObj(json) {
    return { exists: json.exists, data: () => json.data };
  }

  const dbShim = {
    collection(path) {
      let stopped = false, lastJSON = null;
      return {
        onSnapshot(onNext, onError) {
          const tick = async () => {
            if (stopped) return;
            try {
              const json = await apiGetCollection(path);
              const asStr = JSON.stringify(json);
              if (asStr !== lastJSON) { lastJSON = asStr; onNext(collectionSnapshotObj(json)); }
            } catch (e) { if (onError) onError(e); }
          };
          tick();
          const interval = setInterval(tick, POLL_MS);
          return () => { stopped = true; clearInterval(interval); };
        },
      };
    },
    doc(path) {
      let stopped = false, lastJSON = null;
      return {
        onSnapshot(onNext, onError) {
          const tick = async () => {
            if (stopped) return;
            try {
              const json = await apiGetDoc(path);
              const asStr = JSON.stringify(json);
              if (asStr !== lastJSON) { lastJSON = asStr; onNext(docSnapshotObj(json)); }
            } catch (e) { if (onError) onError(e); }
          };
          tick();
          const interval = setInterval(tick, POLL_MS);
          return () => { stopped = true; clearInterval(interval); };
        },
        async set(data) { await apiWrite('set', path, data); },
        async update(patch) { await apiWrite('update', path, patch); },
        async delete() { await apiWrite('delete', path, null); },
      };
    },
  };

  const downloadsShim = {
    async save({ filename, data }) {
      const blob = new Blob([data], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename || 'export.csv';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };

  // Identity is still local-only (no login system yet) — each browser picks
  // its own name once, same as before. This is unrelated to the db upgrade;
  // it's a separate piece to add later if real user accounts matter.
  function getOrCreateMe() {
    let me = localStorage.getItem('contract-desk:me-id');
    if (!me) {
      me = 'local-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('contract-desk:me-id', me);
    }
    let name = localStorage.getItem('contract-desk:me-name');
    if (!name) {
      name = (window.prompt('Your name (shown on your change-log entries):') || 'You').trim() || 'You';
      localStorage.setItem('contract-desk:me-name', name);
    }
    return { id: me, name };
  }

  const userShim = {
    async can() { return true; },
    async id() { return getOrCreateMe().id; },
    async profiles(ids) {
      const me = getOrCreateMe();
      const out = {};
      (ids || []).forEach(id => { if (id === me.id) out[id] = { name: me.name }; });
      return out;
    },
  };

  window.claude = {
    async use(name) {
      if (name === 'db') return dbShim;
      if (name === 'downloads') return downloadsShim;
      if (name === 'user') return userShim;
      return null;
    },
  };
})();
