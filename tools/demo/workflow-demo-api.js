/*
 * In-browser preview of the internal workflow: the real workflow engine (shared/workflow.js) running on
 * SQLite compiled to WebAssembly (sql.js), seeded with a placeholder team and fictional clients.
 * Nothing leaves the browser; reloading the page starts again from the seed.
 */
(function (root) {
  'use strict';
  const W = root.AEWorkflow;

  // node:sqlite surface (prepare().get/all/run, exec) on top of a sql.js database.
  function adapt(raw) {
    const clean = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
    return {
      exec(sql) { raw.exec(sql); },
      prepare(sql) {
        return {
          all(...p) {
            const st = raw.prepare(sql); const out = [];
            try { st.bind(clean(p)); while (st.step()) out.push(st.getAsObject()); } finally { st.free(); }
            return out;
          },
          get(...p) { return this.all(...p)[0]; },
          run(...p) {
            raw.run(sql, clean(p));
            return { changes: raw.getRowsModified(), lastInsertRowid: raw.exec('SELECT last_insert_rowid()')[0].values[0][0] };
          },
        };
      },
    };
  }

  const toBytes = (b64) => { const s = atob(b64); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; };

  const api = { user: null, logins: [] };
  let wf = null; let db = null;

  api.ready = root.initSqlJs({ wasmBinary: toBytes(root.AE_SQLJS_WASM) }).then((SQL) => {
    db = adapt(new SQL.Database());
    db.exec(`
      CREATE TABLE companies (id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, company_id INTEGER, disabled INTEGER NOT NULL DEFAULT 0);`);
    W.install(db);
    wf = W.createWorkflow(db);
    const makeUser = (email, name, role) => {
      const ex = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (ex) return ex;
      db.prepare('INSERT INTO users (email, name, role) VALUES (?, ?, ?)').run(email, name, role);
      return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    };
    const admin = makeUser('admin@assura.demo', 'Assura Admin', 'admin');
    root.AEWorkflowSeed.seed(db, wf, {
      today: new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10),
      admin, makeUser,
      ensureCompany: (code, name) => {
        const ex = db.prepare('SELECT id FROM companies WHERE code = ?').get(code);
        if (ex) return ex.id;
        return Number(db.prepare('INSERT INTO companies (code, name) VALUES (?, ?)').run(code, name).lastInsertRowid);
      },
    });
    const pick = (email, note) => { const u = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email); return { id: u.id, name: u.name, note }; };
    // The associate with the most work waiting on them, so their view has something to do.
    const doer = db.prepare(`SELECT u.email FROM wf_tasks t JOIN users u ON u.id = t.assignee_id JOIN wf_staff s ON s.user_id = u.id
      WHERE t.stage = 'preparation' AND s.level IN ('associate', 'analyst') GROUP BY u.id ORDER BY COUNT(*) DESC, u.id LIMIT 1`).get();
    api.logins = [
      pick('mp@assura.demo', 'Sees both branches; decides flagged matters; consolidated report'),
      pick('branchhead.blr@assura.demo', 'Sees all of Bangalore; corrective actions; consolidated report'),
      pick('tax.head.blr@assura.demo', 'Taxation (direct and indirect tax), Bangalore; weekly report'),
      pick('tax.manager.blr@assura.demo', 'Final approval; sees all work of the juniors'),
      pick('tax.supervisor.blr@assura.demo', 'Quality check; two-day reports from the team'),
      doer ? pick(doer.email, 'Prepares the work allotted to them') : null,
      pick('accounts.associate.blr@assura.demo', 'Accounts: invoices and attendance verification'),
      pick('branchhead.clt@assura.demo', 'Sees all of Calicut'),
      pick('admin@assura.demo', 'System admin; sets up branches and people'),
    ].filter(Boolean);
  });

  api.signIn = (id) => { api.user = db.prepare('SELECT * FROM users WHERE id = ?').get(id); };
  api.signOut = () => { api.user = null; };

  api.request = async (method, url, body) => {
    await api.ready;
    const u = new URL(url, 'http://preview');
    try {
      // Round-trip through JSON, as the server would.
      return JSON.parse(JSON.stringify(wf.call(api.user, `${method} ${u.pathname}`, Object.fromEntries(u.searchParams), body || {})));
    } catch (e) {
      const err = new Error(e.message); err.status = e.status || 500; throw err;
    }
  };

  root.AE_WF_DEMO = api;
})(window);
