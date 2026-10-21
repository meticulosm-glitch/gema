// Filtri globali delle dashboard: periodo e area per tutti i widget, stato nell'indirizzo, widget non filtrabili
// segnalati, "Apri sulla mappa" con i filtri, area del ruolo, configurazione dalla pagina admin.
import { J, MOCK, crash, launchBrowser, prepare, results, shot, startNginx, waitFor } from "./lib.mjs";

const { check, finish } = results();

const asRole = (roles, user = "bob") => J(`/__kc?user=${user}&roles=${encodeURIComponent(roles)}`);
const seed = (layer, list) => fetch(`${MOCK}/__seed?layer=${encodeURIComponent(layer)}`, { method: "POST", body: JSON.stringify(list) }).then((r) => r.json());
const rows = async () => (await J("/__state"))["mapp:dashboards"].features.map((f) => ({ fid: f.id, ...f.properties }));
const K = (id, layer, title, extra = {}) => ({ id, type: "kpi", title, layer, agg: "count", w: 1, ...extra });

(async () => {
  prepare();
  await J("/__reset");
  const F = startNginx("FL", 8086, {
    AUTH_ENABLED: "true", KEYCLOAK_URL: `${MOCK}/kc`, KEYCLOAK_REALM: "test", KEYCLOAK_CLIENT_ID: "mapp",
    ACCESS_CONTROL: "true", KNOWN_ROLES: "fss-etl-viewer", GEOSERVER_WRITE_PASSTHROUGH: "true",
    GEOSERVER_PROXY_URL: `${MOCK}/geoserver`, GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass",
    BASEMAP_TILES: `${MOCK}/tiles/{z}/{x}/{y}.png`, BASEMAPS: `osm|Mappa|${MOCK}/tiles/{z}/{x}/{y}.png|© test`,
    APP_TITLE: "Test filtri", MAP_CENTER_LON: "12.5", MAP_CENTER_LAT: "41.9", MAP_ZOOM: "9", GEOCODER: "off",
  });
  await seed("mapp:dashboards", [{
    title: "Con filtri", description: "", roles: '["fss-etl-viewer"]',
    definition: JSON.stringify({
      widgets: [K("a", "iride:parcels", "Particelle"), K("b", "iride:sensors", "Sensori"), K("c", "demo:roads", "Strade"), { id: "t", type: "text", title: "", layer: "", agg: "count", w: 1, text: "Note" }],
      filters: { date: { fields: { "iride:parcels": "surveyed", "iride:sensors": "obs" }, preset: "all" }, area: true },
    }),
  }]);
  await seed("mapp:role_views", [{ role: "fss-etl-viewer", bbox: "12.39,41.84,12.52,41.91", basemap: "", layers: "[]" }]);
  const browser = await launchBrowser();
  const errors = [];
  const open = async (urlPath, wait = ".dash-grid") => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
    await page.goto(F.url + urlPath);
    await page.waitForSelector(wait, { timeout: 15000, state: "attached" });
    return page;
  };
  const kpi = (page, title) => page.locator(`.widget:has(h3:text-is("${title}")) .k-value`).innerText();
  const counts = async (page) => [await kpi(page, "Particelle"), await kpi(page, "Sensori"), await kpi(page, "Strade")].join("/");

  // ============================================================ periodo
  console.log("\n== periodo ==");
  await asRole("fss-etl-viewer", "bob");
  let page = await open("/d/1");
  check("barra dei filtri con periodo e area", (await page.locator('.dash-filters select[aria-label="Periodo"]').count()) === 1 && /tutta/.test(await page.locator(".df-area").innerText()));
  check("senza filtri: tutti gli oggetti (7 particelle, 5 sensori, 3 strade)", await waitFor(async () => (await counts(page)) === "7/5/3"));
  await page.fill('input[aria-label="Dal"]', "2026-02-01");
  await page.fill('input[aria-label="Al"]', "2026-02-28");
  check("febbraio: 2 particelle e 2 sensori; le strade non hanno un campo data e restano 3", await waitFor(async () => (await counts(page)) === "2/2/3"));
  check("WFS: campo data di ciascun layer, fine compresa (< giorno dopo)", (await J("/__log")).some((l) => decodeURIComponent(l.query).includes("surveyed >= '2026-02-01' AND surveyed < '2026-03-01'")) &&
    (await J("/__log")).some((l) => decodeURIComponent(l.query).includes("obs >= '2026-02-01'")));
  check("widget non filtrabile per data: lo dice", /Non filtrato per data/.test(await page.locator('.widget:has(h3:text-is("Strade"))').innerText()));
  check("il testo non ha note di filtro", (await page.locator(".widget.wt-text .w-filter-note").count()) === 0);
  check("periodo nell'indirizzo", await waitFor(async () => new URL(page.url()).search === "?dal=2026-02-01&al=2026-02-28"));
  await page.reload();
  await page.waitForSelector(".dash-grid");
  check("ricaricando: stesso periodo e stessi numeri", (await page.locator('input[aria-label="Dal"]').inputValue()) === "2026-02-01" && await waitFor(async () => (await counts(page)) === "2/2/3"));

  // ============================================================ area
  console.log("\n== area ==");
  await page.locator('button:has-text("La mia area")').click();
  check("'La mia area': riquadro del ruolo, una sola particella di febbraio dentro, nessun sensore", await waitFor(async () => (await counts(page)) === "1/0/2") && /12\.39, 41\.84, 12\.52, 41\.91/.test(await page.locator(".df-area").innerText()));
  check("WFS: BBOX sulla colonna geometrica di ciascun layer", (await J("/__log")).some((l) => decodeURIComponent(l.query).includes("BBOX(the_geom, 12.39, 41.84, 12.52, 41.91)")) && (await J("/__log")).some((l) => decodeURIComponent(l.query).includes("BBOX(geom, 12.39")));
  check("area nell'indirizzo", /area=12.39%2C41.84%2C12.52%2C41.91/.test(page.url()));
  await page.screenshot({ path: shot("filters-viewer.png"), fullPage: true });
  await page.locator('.widget:has(h3:text-is("Particelle")) button:has-text("Apri sulla mappa")').click();
  check("'Apri sulla mappa' porta con sé periodo e area", await waitFor(async () => { const u = decodeURIComponent(page.url()); return u.includes("surveyed >= '2026-02-01'") && u.includes("BBOX(geom, 12.39"); }));
  await page.goBack();
  await page.waitForSelector(".dash-grid");
  await page.locator('button:has-text("Scegli sulla mappa")').click();
  await page.locator(".df-picker .bbox-map canvas").waitFor({ timeout: 15000 });
  await page.waitForTimeout(500);
  await page.locator('.df-picker button:has-text("Usa questa inquadratura")').click();
  check("area scelta sulla mappa (vista iniziale: l'area già scelta)", await waitFor(async () => /12\.\d\d, 41\.\d\d, 12\.\d\d, 41\.\d\d/.test(await page.locator(".df-area").innerText())));
  await page.locator('button:has-text("Ripristina")').click();
  check("ripristina: niente filtri, indirizzo pulito", await waitFor(async () => (await counts(page)) === "7/5/3") && new URL(page.url()).search === "");
  await page.close();

  // ============================================================ admin
  console.log("\n== admin: configurazione ==");
  await asRole("fss-etl-admin", "alice");
  page = await open("/admin/dashboards", ".dash-editor");
  await page.locator('.dash-editor > .form-grid label:has(> span:text-is("Titolo")) input').fill("Ultimo mese");
  await page.locator('.dash-editor .check-row .check:has-text("fss-etl-viewer") input').check();
  await page.locator('button:has-text("+ Aggiungi widget")').click();
  await page.locator('button:has-text("+ Aggiungi widget")').click();
  await page.locator(".widget-form").nth(1).locator('label:has(> span:text-is("Layer")) select').selectOption("demo:roads");
  await page.locator('.filters-form .check:has-text("Periodo") input').check();
  check("periodo: campo data proposto per il layer che ne ha uno, nessuno per le strade", await waitFor(async () =>
    (await page.locator('select[aria-label="Campo data di iride:parcels"]').inputValue()) === "surveyed" && (await page.locator('select[aria-label="Campo data di demo:roads"]').inputValue()) === ""));
  await page.locator('.ff-date label:has(> span:text-is("Periodo iniziale")) select').selectOption("30d");
  await page.locator('.filters-form .check:has-text("Area") input').check();
  await page.locator('button:text-is("Pubblica")').click();
  check("salvata con i filtri nella definizione", await waitFor(async () => {
    const d = (await rows()).find((r) => r.title === "Ultimo mese");
    if (!d) return false;
    const def = JSON.parse(d.definition);
    return def.widgets.length === 2 && def.filters.date.fields["iride:parcels"] === "surveyed" && !("demo:roads" in def.filters.date.fields) && def.filters.date.preset === "30d" && def.filters.area === true;
  }));
  await page.close();
  await asRole("fss-etl-viewer", "bob");
  page = await open("/d/2");
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  check("periodo iniziale 'Ultimi 30 giorni' applicato all'apertura, indirizzo pulito", (await page.locator('input[aria-label="Dal"]').inputValue()) === from && (await page.locator('input[aria-label="Al"]').inputValue()) === today && new URL(page.url()).search === "");
  check("nessuna particella negli ultimi 30 giorni (dati di prova di inizio 2026)", await waitFor(async () => (await page.locator(".widget .k-value").first().innerText()) === "0"));
  await page.close();

  check("nessun errore JS/console durante i test", errors.length === 0, errors.slice(0, 5).join(" | "));
  await browser.close();
  finish();
})().catch(crash);
