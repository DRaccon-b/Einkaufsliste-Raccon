const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const STUB = fs.readFileSync(path.join(__dirname, "stub.js"), "utf8");

// Use an explicitly provided Chromium if there is one, otherwise let
// Playwright resolve its own download.
function launchOptions() {
  const explicit = process.env.CHROMIUM_PATH;
  if (explicit && fs.existsSync(explicit)) return { executablePath: explicit };
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && fs.existsSync(root)) {
    const dir = fs.readdirSync(root).find((d) => /^chromium-\d+$/.test(d));
    const bin = dir && path.join(root, dir, "chrome-linux", "chrome");
    if (bin && fs.existsSync(bin)) return { executablePath: bin };
  }
  return {};
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? "  — " + detail : ""));
}

(async () => {
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.addInitScript(STUB);

  // Serve the repo from disk; block every external request so nothing can
  // reach the real Supabase project or a CDN.
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "http:" && url.hostname === "local.test") {
      const file = path.join(REPO, url.pathname === "/" ? "index.html" : url.pathname);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
      const ext = path.extname(file);
      const type = ext === ".html" ? "text/html" : ext === ".css" ? "text/css" : "application/javascript";
      let body = fs.readFileSync(file, "utf8");
      // config.js holds real credentials; feed the app harmless placeholders.
      if (path.basename(file) === "config.js") {
        body = 'window.SUPABASE_CONFIG={url:"http://stub.local",anonKey:"stub"};';
      }
      return route.fulfill({ status: 200, contentType: type, body });
    }
    return route.abort(); // CDN scripts (supabase-js, sortablejs) never load
  });

  await page.goto("http://local.test/index.html?list=LIST-A", { waitUntil: "load" });
  await page.waitForTimeout(600);

  // 1. version tag is derived from the app.js query param
  const version = await page.textContent(".version-tag");
  check("Versions-Tag wird aus app.js?v= gesetzt", version === "v1.21.0", "gelesen: " + version);

  // 2. list A rendered its own categories
  const catsA = await page.$$eval("#categories details.category", (els) => els.map((e) => e.dataset.category));
  check("Liste A rendert eigene Kategorien", catsA.includes("Obst und Gemüse") && catsA.includes("Haushalt"), catsA.join(", "));

  // 3. mirror category from list B appears on page A, with only unchecked rows
  const mirrorRows = await page.$$eval(
    '#categories details[data-category="Reste vom Rewe"] li .item-text',
    (els) => els.map((e) => e.textContent)
  );
  check("Mirror 'Reste vom Rewe' zeigt nur offene Artikel aus Liste B",
    mirrorRows.length === 1 && mirrorRows[0] === "Nachos", JSON.stringify(mirrorRows));

  // 4. category counts
  const count = await page.textContent('#categories details[data-category="Obst und Gemüse"] .count');
  check("Kategorie-Zähler stimmt", count === "0/2", "gelesen: " + count);

  // 5. category <select> is populated with a native dropdown (works on iOS
  // Safari, unlike a plain <input list="..."> datalist)
  const opts = await page.$$eval("#item-category option", (els) => els.map((e) => e.value));
  check("Kategorie-Auswahl enthält vorhandene Kategorien", opts.includes("Obst und Gemüse"), opts.join(", "));
  check("Kategorie-Auswahl bietet eine Option für neue Kategorien", opts.includes("__new__"), opts.join(", "));

  // 6. toggling an item marks the row and persists after the debounce
  await page.click('#categories li[data-id="a1"] .switch');
  await page.waitForTimeout(150);
  const immediate = await page.getAttribute('#categories li[data-id="a1"]', "class");
  check("Zeile wird sofort optimistisch markiert", immediate.includes("checked"), "class=" + immediate);

  await page.waitForTimeout(900);
  const stored = await page.evaluate(() => window.__store.shopping_items.find((i) => i.id === "a1").checked);
  check("Änderung landet im Store", stored === true);

  const stillChecked = await page.getAttribute('#categories li[data-id="a1"]', "class");
  check("Zeile bleibt nach Realtime-Echo markiert (kein Flackern)", stillChecked.includes("checked"), "class=" + stillChecked);

  // 7. one write per toggle, not a burst
  const writeCount = await page.evaluate(() => window.__log.writes.filter((w) => w.payload && "checked" in w.payload).length);
  check("Genau ein Write pro Toggle", writeCount === 1, "writes=" + writeCount);

  // 8. checking a mirrored row on page B removes it there and updates list A's owner row
  await page.click('#categories-b details[data-category="Reste von Aldi"] li[data-id="a2"] .switch');
  await page.waitForTimeout(900);
  const b2gone = await page.$('#categories-b details[data-category="Reste von Aldi"] li[data-id="a2"]');
  const a2stored = await page.evaluate(() => window.__store.shopping_items.find((i) => i.id === "a2").checked);
  check("Mirror-Toggle auf Seite B schreibt in die Quellzeile", a2stored === true);
  check("Abgehakter Mirror-Artikel verschwindet aus der Mirror-Kategorie", b2gone === null);
  const a2onA = await page.getAttribute('#categories li[data-id="a2"]', "class");
  check("Quellliste A übernimmt den Zustand", (a2onA || "").includes("checked"), "class=" + a2onA);

  // 9. search filters
  await page.fill("#search-input", "klopapier");
  await page.waitForTimeout(200);
  const visible = await page.$$eval("#categories li .item-text", (els) => els.map((e) => e.textContent));
  check("Suche filtert", visible.length === 1 && visible[0] === "Klopapier", JSON.stringify(visible));
  await page.fill("#search-input", "");
  await page.waitForTimeout(200);

  // 10. delete removes row and store entry
  await page.click('#categories li[data-id="a3"] .delete-btn');
  await page.waitForTimeout(500);
  const a3gone = await page.evaluate(() => !window.__store.shopping_items.some((i) => i.id === "a3"));
  check("Löschen entfernt den Artikel", a3gone);

  // 11. rapid repeated toggling must settle correctly and coalesce into one write
  await page.evaluate(() => (window.__log.writes.length = 0));
  const sw = '#categories li[data-id="a1"] .switch';
  for (let i = 0; i < 5; i++) {
    await page.click(sw);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(1200);
  const domChecked = await page.$eval('#categories li[data-id="a1"] .item-checkbox', (e) => e.checked);
  const storeChecked = await page.evaluate(() => window.__store.shopping_items.find((i) => i.id === "a1").checked);
  const burst = await page.evaluate(() => window.__log.writes.filter((w) => w.payload && "checked" in w.payload).length);
  check("Schnelles 5x Tippen: UI und Store stimmen überein", domChecked === storeChecked,
    "dom=" + domChecked + " store=" + storeChecked);
  check("Schnelles 5x Tippen erzeugt nur einen Write", burst === 1, "writes=" + burst);

  // 12. checking an item while "nur unerledigte anzeigen" is on must hide it
  // immediately, not only after the write round-trip / realtime echo lands.
  await page.check("#hide-checked-filter");
  await page.waitForTimeout(100);
  const filterTargetLi = await page.$("#categories li:not(.checked)");
  const filterTargetId = await filterTargetLi.evaluate((li) => li.dataset.id);
  const filterTargetSwitch = await filterTargetLi.$(".switch");
  await filterTargetSwitch.click();
  await page.waitForTimeout(80); // well under the 250ms write debounce
  const hiddenImmediately = await page.$(`#categories li[data-id="${filterTargetId}"]`);
  check("Abhaken mit aktivem Filter blendet den Artikel sofort aus", hiddenImmediately === null, "id=" + filterTargetId);
  await page.uncheck("#hide-checked-filter");
  await page.waitForTimeout(150);

  // 13. optimistic add: the new item appears immediately, well before the
  // simulated slow insert resolves, and settles onto the real row afterward
  // without ever leaving a duplicate.
  await page.evaluate(() => { window.__store.__insertDelayMs = 400; });
  await page.fill("#item-text", "Optimistisch");
  await page.click('#add-item-form button[type="submit"]');
  await page.waitForTimeout(80);
  const immediateAdd = await page.$$eval("#categories li .item-text", (els) => els.map((e) => e.textContent));
  check("Neuer Artikel erscheint sofort, ohne auf den Server zu warten",
    immediateAdd.includes("Optimistisch"), JSON.stringify(immediateAdd));

  await page.waitForTimeout(600);
  const afterSettle = await page.$$eval("#categories li .item-text", (els) => els.map((e) => e.textContent));
  const occurrences = afterSettle.filter((t) => t === "Optimistisch").length;
  check("Nach dem Settle steht der Artikel genau einmal da (kein Duplikat)",
    occurrences === 1, JSON.stringify(afterSettle));
  await page.evaluate(() => { window.__store.__insertDelayMs = 0; });

  // 14. picking an existing category from the dropdown fills the field
  // without typing, and choosing "+ Neue Kategorie…" reveals a text input
  // for a category name that collides with the mirror category — which is
  // rejected client-side so a real item can never be hidden behind mirrored
  // ones.
  await page.selectOption("#item-category", "Obst und Gemüse");
  check("Vorhandene Kategorie ist per Dropdown wählbar",
    (await page.$eval("#item-category", (el) => el.value)) === "Obst und Gemüse");

  const beforeReserved = await page.evaluate(() => window.__store.shopping_items.length);
  await page.fill("#item-text", "Sollte nicht ankommen");
  await page.selectOption("#item-category", "__new__");
  const customVisible = await page.getAttribute("#item-category-custom", "hidden");
  check("'+ Neue Kategorie' blendet ein Textfeld ein", customVisible === null);
  await page.fill("#item-category-custom", "Reste vom Rewe");
  await page.click('#add-item-form button[type="submit"]');
  await page.waitForTimeout(200);
  const afterReserved = await page.evaluate(() => window.__store.shopping_items.length);
  check("Artikel mit reserviertem Kategorienamen wird nicht angelegt",
    afterReserved === beforeReserved, `vorher=${beforeReserved} nachher=${afterReserved}`);
  const reservedToast = await page.textContent("#toast");
  check("Hinweis-Toast erklärt die Ablehnung", /reserviert/i.test(reservedToast || ""), "toast=" + reservedToast);
  await page.fill("#item-text", "");
  await page.fill("#item-category-custom", "");
  await page.selectOption("#item-category", "");

  // Happy path: a genuinely new category goes through, appears on the item,
  // the picker resets to the placeholder, and the new category later shows
  // up as a selectable option once the list re-renders.
  await page.fill("#item-text", "Kerzen");
  await page.selectOption("#item-category", "__new__");
  await page.fill("#item-category-custom", "Deko");
  await page.click('#add-item-form button[type="submit"]');
  await page.waitForTimeout(200);
  const newItemCategory = await page.evaluate(() =>
    window.__store.shopping_items.find((i) => i.text === "Kerzen")?.category
  );
  check("Neue Kategorie über '+ Neue Kategorie' wird übernommen", newItemCategory === "Deko", "category=" + newItemCategory);
  const resetSelectValue = await page.$eval("#item-category", (el) => el.value);
  const customHiddenAgain = await page.getAttribute("#item-category-custom", "hidden");
  check("Auswahl setzt sich nach dem Anlegen zurück",
    resetSelectValue === "" && customHiddenAgain !== null, `value=${resetSelectValue}`);
  const decoNowSelectable = await page.$$eval("#item-category option", (els) => els.some((o) => o.value === "Deko"));
  check("Die neue Kategorie erscheint danach selbst im Dropdown", decoNowSelectable);

  // 15. bulk check-all/uncheck-all still goes through the shared override
  // helpers after the refactor (setAllChecked used to clear its overrides
  // immediately instead of using the same 4s grace period as single
  // toggles — this only re-checks the write still lands correctly; the
  // timing guarantee itself needs a real, lagging backend to observe).
  await page.click("#check-all-btn"); // window.confirm is stubbed to always return true
  await page.waitForTimeout(700);
  // Scoped to list A's own rows: the mirror category shows list B's items
  // (untouched by list A's check-all) inside the same #categories container.
  const bulkPersisted = await page.evaluate(() =>
    window.__store.shopping_items.filter((i) => i.list_id === "LIST-A").every((i) => i.checked)
  );
  const bulkRendered = await page.$$eval(
    '#categories details:not([data-category="Reste vom Rewe"]) li:not(.checked)',
    (els) => els.length
  );
  check("Alles-abhaken schreibt alle Artikel durch und die UI zeigt es", bulkPersisted && bulkRendered === 0);

  // 16. concurrent edit during an active drag must not disturb it: an insert
  // arriving mid-drag should only appear once the drag has ended.
  const dragUlSelector = '#categories details[data-category="Obst und Gemüse"] ul';
  await page.evaluate((sel) => { document.querySelector(sel)._dragging = true; }, dragUlSelector);
  await page.evaluate(async () => {
    // The stub's query builder is a thenable — it only actually runs once
    // awaited or `.then()`'d, so this must be awaited to take effect.
    await window.supabase.createClient().from("shopping_items").insert({
      id: "drag-test-1", list_id: "LIST-A", category: "Obst und Gemüse", category_order: 0,
      position: 99, text: "Mid-Drag-Artikel", checked: false, important: false, quantity: null, unit: null,
    });
  });
  await page.waitForTimeout(200);
  const midDragVisible = await page.$('#categories li[data-id="drag-test-1"]');
  check("Während eines Drags bleibt ein neu eintreffender Artikel unsichtbar (kein Ruckeln)", midDragVisible === null);
  const midDragInMemory = await page.evaluate(() => window.__store.shopping_items.some((i) => i.id === "drag-test-1"));
  check("...obwohl er im Hintergrund bereits eingetroffen ist (kein Datenverlust)", midDragInMemory === true);

  await page.evaluate((sel) => { document.querySelector(sel)._dragging = false; }, dragUlSelector);
  await page.evaluate(async () => {
    await window.supabase.createClient().from("shopping_items").update({ important: false }).eq("id", "a2");
  });
  await page.waitForTimeout(200);
  const afterDragVisible = await page.$('#categories li[data-id="drag-test-1"]');
  check("Nach Drag-Ende erscheint der zwischenzeitlich eingetroffene Artikel", afterDragVisible !== null);

  // 17. a write that fails transiently (flaky connection) must retry and
  // still land, without the user having to notice or retry manually.
  const dragSwitch = await page.$('#categories li[data-id="drag-test-1"] .switch');
  await page.evaluate(() => { window.__store.__failUpdatesRemaining = 2; });
  await dragSwitch.click(); // optimistic checked: false -> true
  await page.waitForTimeout(80);
  const optimisticDespiteUpcomingFailure = await page.$eval(
    '#categories li[data-id="drag-test-1"]', (li) => li.className
  );
  check("Optimistischer Wert erscheint sofort, obwohl der Schreibversuch gleich scheitert",
    optimisticDespiteUpcomingFailure.includes("checked"));

  await page.waitForTimeout(2600); // 250ms debounce + two backoffs (600ms, 1200ms) before the 3rd attempt
  const recoveredStore = await page.evaluate(() => window.__store.shopping_items.find((i) => i.id === "drag-test-1").checked);
  const recoveredDom = await page.$eval('#categories li[data-id="drag-test-1"] .item-checkbox', (e) => e.checked);
  check("Nach zwei Fehlversuchen setzt sich der dritte Schreibversuch durch",
    recoveredStore === true && recoveredDom === true, `store=${recoveredStore} dom=${recoveredDom}`);

  // 18. a write that keeps failing must give up, tell the user, and roll the
  // UI back to the last confirmed server value instead of showing a value
  // that was never actually saved.
  await page.evaluate(() => { window.__store.__failUpdatesRemaining = 99; });
  await dragSwitch.click(); // optimistic checked: true -> false, but this write will never succeed
  await page.waitForTimeout(2600);
  const revertedStore = await page.evaluate(() => window.__store.shopping_items.find((i) => i.id === "drag-test-1").checked);
  const revertedDom = await page.$eval('#categories li[data-id="drag-test-1"] .item-checkbox', (e) => e.checked);
  check("Bei dauerhaftem Fehlschlag bleibt der zuletzt bestätigte Serverwert erhalten",
    revertedStore === true && revertedDom === true, `store=${revertedStore} dom=${revertedDom}`);
  const failToast = await page.textContent("#toast");
  check("Fehler-Toast informiert über den dauerhaften Schreibfehler",
    /Konnte Status nicht/i.test(failToast || ""), "toast=" + failToast);
  await page.evaluate(() => { window.__store.__failUpdatesRemaining = 0; });

  // 19. settings gear opens the color panel; picking a theme applies and
  // persists it; the home button closes the panel again.
  const panelHiddenInitially = await page.getAttribute("#settings-panel", "hidden");
  check("Optionen-Panel ist initial geschlossen", panelHiddenInitially !== null);

  // Reproduce a long real-world list: with many items, the gear sits far
  // down the page — the panel must scroll into view on open, or opening it
  // is indistinguishable from nothing happening.
  await page.evaluate(async () => {
    for (let i = 0; i < 25; i++) {
      await window.supabase.createClient().from("shopping_items").insert({
        id: "filler-" + i, list_id: "LIST-A", category: "Haushalt", category_order: 5,
        position: 200 + i, text: "Füllartikel " + i, checked: false, important: false, quantity: null, unit: null,
      });
    }
  });
  await page.waitForTimeout(200);
  // Scroll exactly as far as a real user would: just enough to bring the
  // gear button into view, mirroring the reported case (long list, button
  // reached by scrolling, tap appears to do nothing).
  await page.$eval(".page-a", (pageEl) => {
    const btn = document.getElementById("settings-btn");
    pageEl.scrollTop += btn.getBoundingClientRect().bottom - pageEl.getBoundingClientRect().bottom;
  });
  await page.evaluate(() => document.getElementById("settings-btn").click());
  await page.waitForTimeout(500); // let the smooth scrollIntoView settle
  const panelOpen = await page.getAttribute("#settings-panel", "hidden");
  const expandedAttr = await page.getAttribute("#settings-btn", "aria-expanded");
  check("Zahnrad öffnet das Optionen-Panel", panelOpen === null && expandedAttr === "true");

  const panelInViewport = await page.$eval(".page-a", (pageEl) => {
    const panel = document.getElementById("settings-panel");
    const panelRect = panel.getBoundingClientRect();
    const pageRect = pageEl.getBoundingClientRect();
    return panelRect.top >= pageRect.top - 1 && panelRect.bottom <= pageRect.bottom + 1;
  });
  check("Panel scrollt bei langer Liste automatisch ins Blickfeld", panelInViewport);

  await page.click('.theme-swatch[data-theme-color="ocean"]');
  const themeAttr = await page.evaluate(() => document.documentElement.dataset.themeColor);
  const persisted = await page.evaluate(() => localStorage.getItem("einkaufsliste:themeColor"));
  const activeSwatchLabel = await page.$eval(".theme-swatch.active", (el) => el.dataset.themeColor);
  check("Farbwahl wird angewendet und gespeichert",
    themeAttr === "ocean" && persisted === "ocean" && activeSwatchLabel === "ocean",
    `attr=${themeAttr} stored=${persisted} active=${activeSwatchLabel}`);

  // Each theme recolors both lists with a matching but distinct palette —
  // list B must actually change, and to a different color than list A.
  const [pageAAccent, pageBAccent] = await page.evaluate(() => [
    getComputedStyle(document.querySelector(".page-a")).getPropertyValue("--accent").trim(),
    getComputedStyle(document.querySelector(".page-b")).getPropertyValue("--accent").trim(),
  ]);
  check("Die zweite Liste bekommt beim Theme-Wechsel eine eigene, passende Farbe",
    pageBAccent !== "#b25a45" && pageBAccent !== pageAAccent,
    `A=${pageAAccent} B=${pageBAccent}`);

  await page.click("#home-btn");
  const panelClosedAfterHome = await page.getAttribute("#settings-panel", "hidden");
  const expandedAfterHome = await page.getAttribute("#settings-btn", "aria-expanded");
  check("Haus schließt das Panel wieder", panelClosedAfterHome !== null && expandedAfterHome === "false");

  // Selecting "warm" clears the override back to the default palette, and
  // list B goes back to its original red exactly.
  await page.click("#settings-btn");
  await page.click('.theme-swatch[data-theme-color="warm"]');
  const clearedAttr = await page.evaluate(() => document.documentElement.dataset.themeColor);
  check("Zurück zu 'Warm' entfernt das Theme-Attribut wieder", clearedAttr === undefined, "attr=" + clearedAttr);
  const pageBAccentAfterWarm = await page.$eval(".page-b", (el) => getComputedStyle(el).getPropertyValue("--accent").trim());
  check("'Warm' stellt das ursprüngliche Rot der zweiten Liste wieder her",
    pageBAccentAfterWarm === "#b25a45", "accent=" + pageBAccentAfterWarm);
  await page.click("#home-btn");

  // 12. no runtime errors, no alerts (blocked CDN requests are expected)
  const appLog = await page.evaluate(() => window.__log);
  const realErrors = [...consoleErrors, ...appLog.errors].filter((e) => !/ERR_FAILED|Failed to load resource/.test(e));
  check("Keine JS-Fehler", realErrors.length === 0, JSON.stringify(realErrors.slice(0, 3)));
  check("Keine alert()-Dialoge", appLog.alerts.length === 0, JSON.stringify(appLog.alerts));

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " Checks bestanden");
  process.exit(failed.length ? 1 : 0);
})();
