// Fake Supabase client: in-memory store + realtime dispatch.
// Injected before app.js runs so no real network call is ever made.
window.__store = {
  shopping_lists: [{ id: "LIST-A", secondary_list_id: "LIST-B" }],
  shopping_items: [
    { id: "a1", list_id: "LIST-A", category: "Obst und Gemüse", category_order: 0, position: 0, text: "Äpfel", quantity: "2", unit: "Stk", checked: false, important: false },
    { id: "a2", list_id: "LIST-A", category: "Obst und Gemüse", category_order: 0, position: 1, text: "Bananen", quantity: null, unit: null, checked: false, important: false },
    { id: "a3", list_id: "LIST-A", category: "Haushalt", category_order: 5, position: 0, text: "Klopapier", quantity: null, unit: null, checked: true, important: false },
    { id: "b1", list_id: "LIST-B", category: "Snacks", category_order: 3, position: 0, text: "Nachos", quantity: null, unit: null, checked: false, important: false },
    { id: "b2", list_id: "LIST-B", category: "Snacks", category_order: 3, position: 1, text: "Popcorn", quantity: null, unit: null, checked: true, important: false },
  ],
};
window.__log = { errors: [], alerts: [], writes: [] };

window.alert = (m) => window.__log.alerts.push(m);
window.confirm = () => true;

(function () {
  const store = window.__store;
  const channels = [];

  function cmp(a, b) {
    const ao = a.category_order ?? Infinity, bo = b.category_order ?? Infinity;
    if (ao !== bo) return ao - bo;
    const c = (a.category || "").localeCompare(b.category || "", "de");
    if (c !== 0) return c;
    const ap = a.position ?? Infinity, bp = b.position ?? Infinity;
    if (ap !== bp) return ap - bp;
    return (a.text || "").localeCompare(b.text || "", "de");
  }

  function dispatch(eventType, row, oldRow) {
    const listId = (row || oldRow).list_id;
    for (const ch of channels) {
      if (ch.filter === `list_id=eq.${listId}`) {
        ch.cb({ eventType, new: row ? { ...row } : null, old: oldRow ? { ...oldRow } : null });
      }
    }
  }

  function builder(table) {
    const b = {
      _op: "select", _filters: [], _single: false, _payload: null,
      select() { return b; },
      insert(p) { b._op = "insert"; b._payload = p; return b; },
      update(p) { b._op = "update"; b._payload = p; return b; },
      delete() { b._op = "delete"; return b; },
      eq(col, val) { b._filters.push([col, val]); return b; },
      order() { return b; },
      single() { b._single = true; return b; },
      then(res, rej) { return run().then(res, rej); },
    };

    function matches(row) {
      return b._filters.every(([c, v]) => row[c] === v);
    }

    async function run() {
      const rows = store[table];
      if (b._op === "select") {
        const found = rows.filter(matches).sort(cmp).map((r) => ({ ...r }));
        return { data: b._single ? found[0] || null : found, error: null };
      }
      if (b._op === "insert") {
        const row = { id: "new-" + Math.random().toString(36).slice(2, 8), checked: false, important: false, quantity: null, unit: null, category_order: null, ...b._payload };
        rows.push(row);
        dispatch("INSERT", row, null);
        return { data: b._single ? { ...row } : [{ ...row }], error: null };
      }
      if (b._op === "update") {
        const hit = rows.filter(matches);
        window.__log.writes.push({ table, payload: b._payload, count: hit.length });
        for (const row of hit) {
          Object.assign(row, b._payload);
          dispatch("UPDATE", row, null);
        }
        return { data: null, error: null };
      }
      if (b._op === "delete") {
        const hit = rows.filter(matches);
        store[table] = rows.filter((r) => !matches(r));
        for (const row of hit) dispatch("DELETE", null, row);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }

    return b;
  }

  window.supabase = {
    createClient() {
      return {
        from: (table) => builder(table),
        channel(name) {
          const ch = {
            name,
            filter: null,
            cb: null,
            on(_evt, opts, cb) { ch.filter = opts.filter; ch.cb = cb; return ch; },
            subscribe(statusCb) {
              channels.push(ch);
              if (statusCb) setTimeout(() => statusCb("SUBSCRIBED"), 0);
              return ch;
            },
          };
          return ch;
        },
      };
    },
  };
})();

window.addEventListener("error", (e) => window.__log.errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => window.__log.errors.push("rejection: " + e.reason));
