// Bozze e pubblicazione delle dashboard: le modifiche restano in bozza (chi usa la dashboard vede la versione pubblicata),
// differenze, anteprima come ruolo, pubblica, scarta, bozze nuove anche incomplete, elimina; tabella delle bozze mancante.
import { J, MOCK, crash, launchBrowser, prepare, results, shot, startNginx, waitFor } from "./lib.mjs";

const { check, finish } = results();

const asRole = (roles, user = "bob") => J(`/__kc?user=${user}&roles=${encodeURIComponent(roles)}`);
const seed = (layer, list) => fetch(`${MOCK}/__seed?layer=${encodeURIComponent(layer)}`, { method: "POST", body: JSON.stringify(list) }).then((r) => r.json());
const table = async (t) => (await J("/__state"))[`mapp:${t}`].features.map((f) => ({ fid: f.id, ...f.properties }));
const K = (id, layer, title) => ({ id, type: "kpi", title, layer, agg: "count", w: 1 });

(async () => {
  prepare();
  await J("/__reset");
  const F = startNginx("DR", 8085, {
    AUTH_ENABLED: "true", KEYCLOAK_URL: `${MOCK}/kc`, KEYCLOAK_REALM: "test", KEYCLOAK_CLIENT_ID: "mapp",
    ACCESS_CONTROL: "true", KNOWN_ROLES: "fss-etl-viewer,fss-etl-ops", GEOSERVER_WRITE_PASSTHROUGH: "true",
    GEOSERVER_PROXY_URL: `${MOCK}/geoserver`, GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass",
    BASEMAP_TILES: `${MOCK}/tiles/{z}/{x}/{y}.png`, BASEMAPS: `osm|Mappa|${MOCK}/tiles/{z}/{x}/{y}.png|© test`,
    APP_TITLE: "Test bozze", MAP_CENTER_LON: "12.5", MAP_CENTER_LAT: "41.9", MAP_ZOOM: "9", GEOCODER: "off",
  });
  await seed("mapp:dashboards", [{ title: "Monitoraggio", description: "", roles: '["fss-etl-viewer"]', definition: JSON.stringify([K("a", "iride:parcels", "Particelle")]), updated_by: "alice", updated_at: "2026-10-01T10:00:00Z" }]);
  await seed("mapp:role_rules", [
    { role: "fss-etl-viewer", layers: '["iride:parcels"]', tools: '["info","dashboard"]' },
    { role: "fss-etl-ops", layers: '["*"]', tools: '["info"]' },
  ]);
  await seed("mapp:role_views", [{ role: "fss-etl-viewer", bbox: "12.39,41.84,12.52,41.91", basemap: "", layers: "[]" }]);
  const browser = await launchBrowser();
  const errors = [];
  const open = async (urlPath, wait) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
    page.on("dialog", (d) => d.accept());
    await page.goto(F.url + urlPath);
    await page.waitForSelector(wait, { timeout: 15000, state: "attached" });
    return page;
  };
  const item = (page, t) => page.locator(`.dash-item:has(strong:text-is("${t}"))`);
  const title = (page) => page.locator('.dash-editor > .form-grid label:has(> span:text-is("Titolo")) input');
  const btn = (page, t) => page.locator(`.dash-editor button:text-is("${t}")`);
  const okMsg = (page) => page.locator(".page .ok").innerText().catch(() => "");

  // ============================================================ bozza di una dashboard pubblicata
  console.log("\n== bozza di una pubblicata ==");
  await asRole("fss-etl-admin", "alice");
  let page = await open("/admin/dashboards", ".dash-editor");
  check("elenco: la dashboard è 'Pubblicata'", /Pubblicata/.test(await item(page, "Monitoraggio").innerText()));
  await item(page, "Monitoraggio").click();
  check("stato: pubblicata da alice; Salva bozza e Pubblica spenti senza modifiche",
    /Pubblicata da alice/.test(await page.locator(".draft-state").innerText()) && await btn(page, "Salva bozza").isDisabled() && await btn(page, "Pubblica").isDisabled());
  await title(page).fill("Monitoraggio v2");
  await page.locator('button:has-text("+ Aggiungi widget")').click();
  await page.locator(".widget-form").nth(1).locator('label:has(> span:text-is("Layer")) select').selectOption("iride:sensors");
  check("modifiche non salvate segnalate", (await page.locator(".dirty-note").count()) === 1);
  await btn(page, "Salva bozza").click();
  check("bozza salvata: messaggio", await waitFor(async () => /Bozza salvata: chi usa la dashboard vede ancora la versione pubblicata/.test(await okMsg(page))));
  let drafts = await table("dashboard_drafts");
  let dash = await table("dashboards");
  check("WFS-T: riga in dashboard_drafts collegata alla dashboard; la pubblicata non cambia",
    drafts.length === 1 && drafts[0].dashboard_id === "1" && drafts[0].title === "Monitoraggio v2" && JSON.parse(drafts[0].definition).length === 2 &&
    dash.length === 1 && dash[0].title === "Monitoraggio" && JSON.parse(dash[0].definition).length === 1);
  check("elenco: 'Bozza da pubblicare'; stato con le differenze", await waitFor(async () =>
    /Bozza da pubblicare/.test(await item(page, "Monitoraggio v2").innerText()) && /Differenze: titolo \(«Monitoraggio» → «Monitoraggio v2»\); 1 widget nuovo/.test(await page.locator(".draft-state").innerText())));
  check("niente più 'Modifiche non salvate'", (await page.locator(".dirty-note").count()) === 0);

  // ============================================================ anteprima come ruolo
  console.log("\n== anteprima come ruolo ==");
  const sel = page.locator('select[aria-label="Anteprima come ruolo"]');
  await sel.selectOption("fss-etl-viewer");
  const notes = () => page.locator(".preview-notes").innerText();
  check("anteprima come viewer: la trova nell'elenco; il layer dei sensori non è abilitato", await waitFor(async () => {
    const n = await notes();
    return /fss-etl-viewer trova questa dashboard/.test(n) && /Layer non abilitati per fss-etl-viewer.*iride:sensors/.test(n);
  }));
  check("anteprima: senza filtro per area nessun pulsante 'La mia area'", (await page.locator('.dash-preview button:has-text("La mia area")').count()) === 0);
  await sel.selectOption("fss-etl-ops");
  check("anteprima come ops: non tra i ruoli della dashboard", await waitFor(async () => /fss-etl-ops non è tra i ruoli della dashboard: non la vedrà/.test(await notes())));
  check("anteprima: due widget con i dati, nessun 'Apri sulla mappa' attivo", await waitFor(async () =>
    (await page.locator(".dash-preview .widget .k-value").count()) === 2 && (await page.locator(".dash-preview .widget .k-value").first().innerText()) === "7") &&
    (await page.locator('.dash-preview button:has-text("Apri sulla mappa"):enabled').count()) === 0);
  await page.screenshot({ path: shot("drafts-admin.png"), fullPage: true });

  // ============================================================ chi usa la dashboard vede la pubblicata
  console.log("\n== viewer durante la bozza ==");
  const logBefore = (await J("/__log")).length;
  await asRole("fss-etl-viewer", "bob");
  const viewer = await open("/d/1", ".dash-grid");
  check("viewer: versione pubblicata (titolo vecchio, 1 widget)", await waitFor(async () => (await viewer.locator("h1").innerText()) === "Monitoraggio" && (await viewer.locator(".widget").count()) === 1));
  check("viewer: nessuna richiesta alle bozze", (await J("/__log")).slice(logBefore).every((l) => !l.query.includes("dashboard_drafts")));

  // ============================================================ pubblica
  console.log("\n== pubblica ==");
  await btn(page, "Pubblica").click();
  check("pubblicata: messaggio con i ruoli", await waitFor(async () => /Dashboard pubblicata: la vedono fss-etl-viewer/.test(await okMsg(page))));
  drafts = await table("dashboard_drafts");
  dash = await table("dashboards");
  check("WFS-T: dashboard aggiornata e bozza eliminata insieme", drafts.length === 0 && dash.length === 1 && dash[0].title === "Monitoraggio v2" && JSON.parse(dash[0].definition).length === 2 && dash[0].updated_by === "alice");
  check("elenco: di nuovo 'Pubblicata'", await waitFor(async () => /Pubblicata/.test(await item(page, "Monitoraggio v2").innerText()) && !/Bozza/.test(await item(page, "Monitoraggio v2").innerText())));
  await viewer.reload();
  await viewer.waitForSelector(".dash-grid");
  check("viewer: dopo la pubblicazione vede la versione nuova", await waitFor(async () => (await viewer.locator("h1").innerText()) === "Monitoraggio v2" && (await viewer.locator(".widget").count()) === 2));

  // ============================================================ scarta
  console.log("\n== scarta ==");
  await title(page).fill("Da scartare");
  await btn(page, "Salva bozza").click();
  check("bozza salvata", await waitFor(async () => (await table("dashboard_drafts")).length === 1));
  await btn(page, "Scarta bozza").click();
  check("scartata: niente bozze, editor con la pubblicata", await waitFor(async () => (await table("dashboard_drafts")).length === 0 && (await title(page).inputValue()) === "Monitoraggio v2") &&
    /Bozza scartata/.test(await okMsg(page)));

  // ============================================================ bozza nuova
  console.log("\n== bozza nuova ==");
  await page.locator('button:has-text("+ Nuova dashboard")').click();
  await title(page).fill("Idee");
  await page.locator('.dash-editor .check-row .check:has-text("fss-etl-viewer") input').check();
  check("incompleta: si salva in bozza, non si pubblica", /Puoi salvare la bozza anche incompleta/.test(await page.locator(".dash-editor").innerText()) && await btn(page, "Pubblica").isDisabled() && !(await btn(page, "Salva bozza").isDisabled()));
  await btn(page, "Salva bozza").click();
  check("bozza nuova salvata: 'Mai pubblicata' e selezionata", await waitFor(async () =>
    /Mai pubblicata/.test(await item(page, "Idee").innerText()) && /\bon\b/.test(await item(page, "Idee").getAttribute("class")) && /Bozza mai pubblicata/.test(await page.locator(".draft-state").innerText())));
  drafts = await table("dashboard_drafts");
  check("WFS-T: bozza senza dashboard collegata, nessuna widget", drafts.length === 1 && !drafts[0].dashboard_id && JSON.parse(drafts[0].definition).length === 0);
  await viewer.goto(F.url + "/dashboards");
  await viewer.waitForSelector(".cards", { state: "attached" });
  check("viewer: la bozza non è nell'elenco anche se assegnata al suo ruolo", await waitFor(async () => (await viewer.locator(".card-link").count()) === 1));
  await asRole("fss-etl-admin", "alice"); // ricaricando si rifà l'accesso
  await page.reload();
  await page.waitForSelector(".dash-editor");
  check("ricaricando la pagina la bozza c'è ancora", (await item(page, "Idee").count()) === 1);
  await item(page, "Idee").click();
  await btn(page, "Elimina").click();
  check("elimina la bozza nuova", await waitFor(async () => (await table("dashboard_drafts")).length === 0 && (await item(page, "Idee").count()) === 0) && /Bozza eliminata/.test(await okMsg(page)));
  await page.close();
  await viewer.close();

  // ============================================================ tabella mancante
  console.log("\n== tabella delle bozze mancante ==");
  await J("/__tables?off=1&only=mapp:dashboard_drafts");
  await asRole("fss-etl-admin", "alice");
  page = await open("/admin/dashboards", ".dash-editor");
  check("avviso con il nome del layer; salvataggio diretto come prima", await waitFor(async () => /mapp:dashboard_drafts/.test(await page.locator(".notice").innerText())) &&
    (await btn(page, "Salva dashboard").count()) === 1 && (await btn(page, "Salva bozza").count()) === 0 && (await page.locator(".status-tag").count()) === 0);
  await item(page, "Monitoraggio v2").click();
  await title(page).fill("Monitoraggio v3");
  await btn(page, "Salva dashboard").click();
  check("salvata direttamente nella tabella delle dashboard", await waitFor(async () => (await table("dashboards"))[0].title === "Monitoraggio v3"));
  await J("/__tables?off=0");
  await page.close();

  check("nessun errore JS/console durante i test", errors.length === 0, errors.slice(0, 5).join(" | "));
  await browser.close();
  finish();
})().catch(crash);
