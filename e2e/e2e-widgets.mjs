// Nuovi tipi di widget delle dashboard: indicatore con soglie, torta, linea temporale, tabella, testo (markdown sicuro),
// mini-mappa. Creazione dalla pagina admin con i campi giusti per tipo e resa nella dashboard del visualizzatore.
import { J, MOCK, crash, launchBrowser, prepare, results, shot, startNginx, waitFor } from "./lib.mjs";

const { check, finish } = results();

const rows = async () => (await J("/__state"))["mapp:dashboards"].features.map((f) => ({ fid: f.id, ...f.properties }));
const asRole = (roles, user = "bob") => J(`/__kc?user=${user}&roles=${encodeURIComponent(roles)}`);
const seed = (list) => fetch(`${MOCK}/__seed?layer=${encodeURIComponent("mapp:dashboards")}`, { method: "POST", body: JSON.stringify(list) }).then((r) => r.json());

const WIDGETS = [
  { id: "g1", type: "gauge", title: "Area totale", layer: "iride:parcels", agg: "sum", valueField: "area", warn: 2000, crit: 3000, w: 1 },
  { id: "g2", type: "gauge", title: "Particelle A", layer: "iride:parcels", agg: "count", cql: "kind = 'A'", warn: 5, crit: 2, higherIsWorse: false, w: 1 },
  { id: "p1", type: "pie", title: "Per tipo", layer: "iride:parcels", field: "kind", agg: "count", w: 1 },
  { id: "l1", type: "line", title: "Rilievi per mese", layer: "iride:parcels", field: "surveyed", agg: "count", granularity: "month", w: 2 },
  { id: "t1", type: "table", title: "Più grandi", layer: "iride:parcels", agg: "count", columns: ["name", "area"], sortField: "area", sortDesc: true, limit: 3, w: 1 },
  { id: "x1", type: "text", title: "Note", layer: "", agg: "count", text: "## Come leggere\nDati **di prova** con un [link](https://example.org/doc) e uno [pericoloso](javascript:alert(1)).\n- primo\n- secondo\n<script>window.__pwned = 1</script>", w: 1 },
  { id: "m1", type: "map", title: "Dove", layer: "iride:parcels", agg: "count", cql: "kind = 'B'", w: 2 },
];

(async () => {
  prepare();
  await J("/__reset");
  const S = startNginx("WG", 8087, {
    AUTH_ENABLED: "true", KEYCLOAK_URL: `${MOCK}/kc`, KEYCLOAK_REALM: "test", KEYCLOAK_CLIENT_ID: "mapp",
    ACCESS_CONTROL: "true", KNOWN_ROLES: "fss-etl-viewer", GEOSERVER_WRITE_PASSTHROUGH: "true",
    GEOSERVER_PROXY_URL: `${MOCK}/geoserver`, GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass",
    BASEMAP_TILES: `${MOCK}/tiles/{z}/{x}/{y}.png`, BASEMAPS: `osm|Mappa|${MOCK}/tiles/{z}/{x}/{y}.png|© test`,
    APP_TITLE: "Test widget", MAP_CENTER_LON: "12.5", MAP_CENTER_LAT: "41.9", MAP_ZOOM: "9", GEOCODER: "off",
  });
  await seed([{ title: "Tutti i widget", description: "", roles: '["fss-etl-viewer"]', definition: JSON.stringify(WIDGETS) }]);
  const browser = await launchBrowser();
  const errors = [];
  const open = async (urlPath, wait = ".header", scheme = "light") => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, colorScheme: scheme });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
    page.on("dialog", (d) => d.accept());
    await page.goto(S.url + urlPath);
    await page.waitForSelector(wait, { timeout: 15000, state: "attached" });
    return page;
  };
  const w = (page, i) => page.locator(".dash-grid .widget").nth(i);

  // ============================================================ resa per il visualizzatore
  console.log("\n== dashboard con tutti i widget ==");
  await asRole("fss-etl-viewer", "bob");
  let page = await open("/d/1", ".dash-grid");
  check("sette widget", (await page.locator(".dash-grid .widget").count()) === 7);
  check("indicatore: somma 2.800 tra attenzione (2000) e critico (3000) = attenzione, con icona e scritta", await waitFor(async () => {
    const t = await w(page, 0).innerText();
    return /2\.800/.test(t) && /attenzione/.test(t) && (await w(page, 0).locator(".gauge.g-warning .g-icon").count()) === 1;
  }));
  check("indicatore: barra 'meter' accessibile con valore e livello", /attenzione/.test(await w(page, 0).locator('[role="meter"]').getAttribute("aria-valuetext")));
  check("indicatore 'più basso = peggio': 3 particelle A sotto l'attenzione (5) ma sopra il critico (2)", await waitFor(async () => (await w(page, 1).locator(".gauge.g-warning").count()) === 1 && /\b3\b/.test(await w(page, 1).locator(".k-value").innerText())));
  check("torta: tre spicchi A/B/C con legenda, valori e percentuali", await waitFor(async () => (await w(page, 2).locator(".pie-slice").count()) === 3) &&
    JSON.stringify(await w(page, 2).locator(".pie-label").allInnerTexts()) === JSON.stringify(["A", "B", "C"]) && /42,9%/.test(await w(page, 2).locator(".pie-legend").innerText()));
  check("linea: un periodo per mese (gennaio, febbraio, marzo) da sinistra a destra", await waitFor(async () => (await w(page, 3).locator(".line-axis").innerText()).replace(/\s+/g, " ") === "2026-01 2026-03"));
  const plot = w(page, 3).locator(".line-plot svg");
  const box = await plot.boundingBox();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
  check("linea: al passaggio del mouse cursore, punto e valore del periodo", await waitFor(async () => /2026-03/.test(await w(page, 3).locator(".line-tip").innerText())) && (await w(page, 3).locator(".line-marker").count()) === 1);
  check("tabella: colonne scelte, ordinata per area decrescente, prime 3 di 7", await waitFor(async () => {
    const heads = await w(page, 4).locator("th").allInnerTexts();
    const cells = await w(page, 4).locator("tbody tr td:first-child").allInnerTexts();
    return JSON.stringify(heads) === JSON.stringify(["name", "area ▼"]) && JSON.stringify(cells) === JSON.stringify(["Particella 7", "Particella 6", "Particella 5"]) && /prime 3 righe di 7/.test(await w(page, 4).innerText());
  }));
  const md = w(page, 5).locator(".md");
  check("testo: titolo, grassetto, elenco e link sicuro in una nuova scheda", (await md.locator("h5").innerText()) === "Come leggere" && (await md.locator("strong").innerText()) === "di prova" &&
    (await md.locator("li").count()) === 2 && (await md.locator('a[href="https://example.org/doc"][target="_blank"]').count()) === 1);
  check("testo: niente HTML né link javascript:", (await md.locator("script").count()) === 0 && (await md.locator('a[href^="javascript"]').count()) === 0 &&
    /<script>/.test(await md.innerText()) && !(await page.evaluate(() => window.__pwned)));
  check("testo: niente 'Apri sulla mappa'", (await w(page, 5).locator('button:has-text("Apri sulla mappa")').count()) === 0);
  check("mini-mappa: mappa disegnata con il layer filtrato (GetMap con il CQL del widget)", await waitFor(async () => (await w(page, 6).locator(".w-map canvas").count()) === 1 &&
    (await J("/__log")).some((l) => /GetMap/i.test(l.query) && /layers=iride%3Aparcels/.test(l.query) && decodeURIComponent(l.query).includes("kind = 'B'")), 15000));
  await page.waitForTimeout(800);
  await page.screenshot({ path: shot("widgets-light.png"), fullPage: true });
  await w(page, 2).locator('.pie-item:has-text("B")').click();
  check("torta: clic su uno spicchio apre la mappa con il filtro della categoria", await waitFor(async () => page.url().includes("/#s=") && decodeURIComponent(page.url()).includes("kind = 'B'")));
  await page.close();
  page = await open("/d/1", ".dash-grid", "dark");
  await waitFor(async () => (await page.locator(".pie-slice").count()) === 3);
  await page.waitForTimeout(800);
  await page.screenshot({ path: shot("widgets-dark.png"), fullPage: true });
  await page.close();

  // ============================================================ admin: campi per tipo
  console.log("\n== admin: campi per tipo ==");
  await asRole("fss-etl-admin", "alice");
  page = await open("/admin/dashboards", ".dash-editor");
  await page.locator('.dash-editor > .form-grid label:has(> span:text-is("Titolo")) input').fill("Nuova con indicatore");
  await page.locator('.dash-editor .check:has-text("fss-etl-viewer") input').check();
  await page.locator('button:has-text("+ Aggiungi widget")').click();
  const f0 = page.locator(".widget-form").nth(0);
  const sel = (form, label) => form.locator(`label:has(> span:text-is("${label}")) select`);
  const inp = (form, label) => form.locator(`label:has(> span:text-is("${label}")) input`);
  check("tipi disponibili nel menu", JSON.stringify(await sel(f0, "Tipo").locator("option").allInnerTexts()) === JSON.stringify(["KPI (numero)", "Indicatore con soglie", "Barre per categoria", "Torta (quote per categoria)", "Istogramma (campo numerico)", "Colonne per mese (campo data)", "Linea temporale (campo data)", "Tabella", "Mini-mappa", "Testo"]));
  await sel(f0, "Tipo").selectOption("gauge");
  await sel(f0, "Layer").selectOption("iride:parcels");
  check("indicatore senza soglie: problema segnalato", /indica le due soglie/.test(await page.locator(".problems").innerText()));
  await inp(f0, "Soglia di attenzione").fill("10");
  await inp(f0, "Soglia critica").fill("5");
  check("soglie in ordine sbagliato: problema", /la soglia critica deve venire dopo/.test(await page.locator(".problems").innerText()));
  await sel(f0, "Direzione").selectOption("low");
  check("'più basso = peggio': soglie valide", await waitFor(async () => (await page.locator(".problems").count()) === 0));
  await page.locator('button:has-text("+ Aggiungi widget")').click();
  const f1 = page.locator(".widget-form").nth(1);
  await sel(f1, "Tipo").selectOption("text");
  check("testo: niente layer né filtro, campo di testo", (await sel(f1, "Layer").count()) === 0 && (await f1.locator('textarea[aria-label="Testo del widget"]').count()) === 1 && /scrivi il testo/.test(await page.locator(".problems").innerText()));
  await f1.locator('textarea[aria-label="Testo del widget"]').fill("**Benvenuti**");
  await page.locator('button:has-text("+ Aggiungi widget")').click();
  const f2 = page.locator(".widget-form").nth(2);
  await sel(f2, "Tipo").selectOption("table");
  await sel(f2, "Layer").selectOption("iride:parcels");
  check("tabella: senza colonne è un problema", await waitFor(async () => /almeno una colonna/.test(await page.locator(".problems").innerText())));
  await f2.locator('.wf-columns .check:has-text("name") input').check();
  await sel(f2, "Ordina per").selectOption("name");
  check("anteprima: indicatore, testo e tabella disegnati", await waitFor(async () => (await page.locator(".dash-grid .gauge").count()) === 1 && (await page.locator(".dash-grid .md strong").innerText()) === "Benvenuti" && (await page.locator(".dash-grid .w-table tbody tr").count()) > 0));
  await page.locator('button:text-is("Pubblica")').click();
  check("salvata con le opzioni dei nuovi tipi", await waitFor(async () => {
    const d = (await rows()).find((r) => r.title === "Nuova con indicatore");
    if (!d) return false;
    const ws = JSON.parse(d.definition);
    return ws[0].type === "gauge" && ws[0].warn === 10 && ws[0].crit === 5 && ws[0].higherIsWorse === false && ws[1].type === "text" && ws[1].layer === "" && ws[2].columns.join() === "name" && ws[2].sortField === "name";
  }));
  await page.close();

  check("nessun errore JS/console durante i test", errors.length === 0, errors.slice(0, 5).join(" | "));
  await browser.close();
  finish();
})().catch(crash);
