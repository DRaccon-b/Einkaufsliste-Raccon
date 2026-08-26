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
  check("Versions-Tag wird aus app.js?v= gesetzt", version === "v1.17.0", "gelesen: " + version);

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

  // 5. datalist filled
  const opts = await page.$$eval("#category-list option", (els) => els.map((e) => e.value));
  check("Datalist enthält Kategorien", opts.includes("Obst und Gemüse"), opts.join(", "));

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
