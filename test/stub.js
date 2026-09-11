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
  activity_log: [],
};
window.__log = { errors: [], alerts: [], writes: [] };

window.alert = (m) => window.__log.alerts.push(m);
window.confirm = () => true;

(function () {
  const store = window.__store;
  const channels = [];

  // Generic multi-key sort driven by whatever .order(...) calls the query
  // actually made, so it works for any table (shopping_items, activity_log,
  // ...) instead of hardcoding one table's column set.
  function sortByOrders(rows, orders) {
    if (!orders.length) return rows;
    return [...rows].sort((a, r) => {
      for (const { col, ascending, nullsFirst } of orders) {
        const av = a[col], bv = r[col];
        const aNull = av === null || av === undefined;
        const bNull = bv === null || bv === undefined;
        if (aNull || bNull) {
          if (aNull && bNull) continue;
          if (aNull) return nullsFirst ? -1 : 1;
          return nullsFirst ? 1 : -1;
        }
        let c;
        if (typeof av === "string") c = av.localeCompare(bv, "de");
        else c = av < bv ? -1 : av > bv ? 1 : 0;
        if (c !== 0) return ascending ? c : -c;
      }
      return 0;
    });
  }

  function dispatch(table, eventType, row, oldRow) {
    const listId = (row || oldRow).list_id;
    for (const ch of channels) {
      // Real Postgres realtime scopes a subscription to one table; matching
      // on filter alone let an activity_log insert (same list_id) spuriously
      // fire the shopping_items channel too.
      if (ch.table === table && ch.filter === `list_id=eq.${listId}`) {
        ch.cb({ eventType, new: row ? { ...row } : null, old: oldRow ? { ...oldRow } : null });
      }
    }
  }

  function builder(table) {
    const b = {
      _op: "select", _filters: [], _single: false, _payload: null, _orders: [], _limit: null,
      select() { return b; },
      insert(p) { b._op = "insert"; b._payload = p; return b; },
      update(p) { b._op = "update"; b._payload = p; return b; },
      delete() { b._op = "delete"; return b; },
      eq(col, val) { b._filters.push([col, val]); return b; },
      order(col, opts) {
        b._orders.push({
          col,
          ascending: !opts || opts.ascending !== false,
          nullsFirst: !!(opts && opts.nullsFirst),
        });
        return b;
      },
      limit(n) { b._limit = n; return b; },
      single() { b._single = true; return b; },
      then(res, rej) { return run().then(res, rej); },
    };

    function matches(row) {
      return b._filters.every(([c, v]) => row[c] === v);
    }

    // shopping_items.position/category_order are Postgres `integer` (32-bit)
    // columns — mirror that constraint so a value like Date.now() (13
    // digits) fails here exactly like it would against the real database,
    // instead of silently "working" against this in-memory stub.
    const PG_INT4_MAX = 2147483647;
    const PG_INT4_MIN = -2147483648;
    function pgIntegerRangeError(payload) {
      if (table !== "shopping_items") return null;
      for (const field of ["position", "category_order"]) {
        const value = payload[field];
        if (typeof value === "number" && (value > PG_INT4_MAX || value < PG_INT4_MIN)) {
          return { message: `value "${value}" is out of range for type integer` };
        }
      }
      return null;
    }

    async function run() {
      const rows = store[table];
      if (b._op === "select") {
        let found = sortByOrders(rows.filter(matches), b._orders).map((r) => ({ ...r }));
        if (typeof b._limit === "number") found = found.slice(0, b._limit);
        return { data: b._single ? found[0] || null : found, error: null };
      }
      if (b._op === "insert") {
        const rangeError = pgIntegerRangeError(b._payload);
        if (rangeError) return { data: null, error: rangeError };
        // Tests can set window.__store.__insertDelayMs to simulate a slow
        // network and verify the app doesn't just sit there waiting.
        if (store.__insertDelayMs) await new Promise((r) => setTimeout(r, store.__insertDelayMs));
        // Monotonic clock so rapid-fire inserts (e.g. several activity_log
        // rows within the same test) still get strictly increasing
        // timestamps, even if the real clock's resolution can't tell them apart.
        store.__clockTick = (store.__clockTick || 0) + 1;
        const row = {
          id: "new-" + Math.random().toString(36).slice(2, 8),
          checked: false,
          important: false,
          quantity: null,
          unit: null,
          category_order: null,
          created_at: new Date(Date.now() + store.__clockTick).toISOString(),
          ...b._payload,
        };
        rows.push(row);
        dispatch(table, "INSERT", row, null);
        return { data: b._single ? { ...row } : [{ ...row }], error: null };
      }
      if (b._op === "update") {
        const rangeError = pgIntegerRangeError(b._payload);
        if (rangeError) return { data: null, error: rangeError };
        // Tests can set window.__store.__failUpdatesRemaining to simulate a
        // flaky backend without mutating any data, to exercise retry/revert.
        if (store.__failUpdatesRemaining > 0) {
          store.__failUpdatesRemaining--;
          window.__log.writes.push({ table, payload: b._payload, count: 0, failed: true });
          return { data: null, error: { message: "stub-forced-failure" } };
        }
        const hit = rows.filter(matches);
        window.__log.writes.push({ table, payload: b._payload, count: hit.length });
        for (const row of hit) {
          Object.assign(row, b._payload);
          dispatch(table, "UPDATE", row, null);
        }
        return { data: null, error: null };
      }
      if (b._op === "delete") {
        const hit = rows.filter(matches);
        store[table] = rows.filter((r) => !matches(r));
        for (const row of hit) dispatch(table, "DELETE", null, row);
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
            table: null,
            cb: null,
            on(_evt, opts, cb) { ch.filter = opts.filter; ch.table = opts.table; ch.cb = cb; return ch; },
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
