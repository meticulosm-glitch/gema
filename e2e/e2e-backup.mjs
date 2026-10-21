// Backup e ripristino della configurazione: file JSON con tutte le sezioni, anteprima delle differenze, unione o
// sostituzione in un'unica transazione, copia di sicurezza prima di scrivere, registro modifiche, file sbagliati.
import fs from "node:fs";
import { J, MOCK, crash, launchBrowser, prepare, results, shot, startNginx, waitFor } from "./lib.mjs";

const { check, finish } = results();
const asRole = (roles, user = "bob") => J(`/__kc?user=${user}&roles=${encodeURIComponent(roles)}`);
const seed = (layer, list) => fetch(`${MOCK}/__seed?layer=${encodeURIComponent(layer)}`, { method: "POST", body: JSON.stringify(list) }).then((r) => r.json());
const table = async (t) => (await J("/__state"))[`mapp:${t}`].features.map((f) => ({ fid: f.id, ...f.properties }));
const WRITE = "Basic " + Buffer.from("writer:wpass").toString("base64");
const tx = (ops) => fetch(`${MOCK}/geoserver/wfs`, { method: "POST", headers: { Authorization: WRITE, "Content-Type": "text/xml" },
  body: `<wfs:Transaction service="WFS" version="1.0.0" xmlns:wfs="http://www.opengis.net/wfs" xmlns:ogc="http://www.opengis.net/ogc" xmlns:mapp="http://iride.example/mapp">${ops}</wfs:Transaction>` }).then((r) => r.text());

(async () => {
  prepare();
  await J("/__reset");
  const F = startNginx("BK", 8077, {
    AUTH_ENABLED: "true", KEYCLOAK_URL: `${MOCK}/kc`, KEYCLOAK_REALM: "test", KEYCLOAK_CLIENT_ID: "mapp",
    ACCESS_CONTROL: "true", KNOWN_ROLES: "fss-etl-viewer", GEOSERVER_WRITE_PASSTHROUGH: "true",
    GEOSERVER_PROXY_URL: `${MOCK}/geoserver`, GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass",
    BASEMAP_TILES: `${MOCK}/tiles/{z}/{x}/{y}.png`, BASEMAPS: `osm|Mappa|${MOCK}/tiles/{z}/{x}/{y}.png|© test`,
    APP_TITLE: "Test backup", MAP_CENTER_LON: "12.5", MAP_CENTER_LAT: "41.9", MAP_ZOOM: "9", GEOCODER: "off", USAGE_STATS: "off",
  });
  await seed("mapp:role_rules", [{ role: "fss-etl-viewer", layers: '["iride:parcels"]', tools: '["info"]' }, { role: "fss-etl-ops", layers: '["*"]', tools: '["info","table"]' }]);
  await seed("mapp:dashboards", [{ title: "Monitoraggio", description: "d", roles: '["fss-etl-viewer"]', definition: JSON.stringify({ widgets: [{ id: "a", type: "kpi", title: "K", layer: "iride:parcels", agg: "count", w: 1 }], filters: { area: true } }) }]);
  await seed("mapp:announcements", [{ message: "Benvenuti", level: "info", starts_at: "", ends_at: "", roles: "[]", dismissible: "true", active: "true" }]);
  await seed("mapp:catalog_folders", [{ folder_key: "agri", parent_key: "", title: "Agricoltura", description: "", position: "0", expanded: "true", hidden: "false" }]);
  const original = { rules: await table("role_rules"), dash: await table("dashboards") };

  const browser = await launchBrowser();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  page.on("dialog", (d) => d.accept());
  const restoreCard = page.locator('[aria-label="Ripristino"]');
  const planRows = async () => (await restoreCard.locator("table.bk-plan tr").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());

  // ============================================================ backup
  console.log("\n== backup ==");
  await asRole("fss-etl-admin", "alice");
  await page.goto(F.url + "/admin/backup");
  await page.waitForSelector('[aria-label="Backup"] .bk-sections', { timeout: 15000 });
  const secText = async () => (await page.locator(".bk-sections").textContent()) ?? "";
  check("sezioni con il numero di righe", await waitFor(async () => /Regole dei ruoli \(2\)/.test(await secText()) && /Avvisi \(1\)/.test(await secText())), await secText());
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator('button:has-text("Scarica backup (JSON)")').click()]);
  const file = await dl.path();
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  check("file: formato, tutte le sezioni, niente id né autori", json.format === "gema-config" && json.workspace === "mapp" && Object.keys(json.sections).length === 7 &&
    json.sections.rules.length === 2 && !("fid" in json.sections.rules[0]) && json.sections.dashboards[0].filters.area === true && /^gema-config-127\.0\.0\.1_8077-/.test(dl.suggestedFilename()));

  // ============================================================ cambi dopo il backup
  await tx(`<wfs:Update typeName="mapp:role_rules"><wfs:Property><wfs:Name>tools</wfs:Name><wfs:Value>[]</wfs:Value></wfs:Property><ogc:Filter><ogc:FeatureId fid="${original.rules[1].fid}"/></ogc:Filter></wfs:Update>` +
    `<wfs:Insert><mapp:role_rules><mapp:role>fss-etl-extra</mapp:role><mapp:layers>[]</mapp:layers><mapp:tools>[]</mapp:tools></mapp:role_rules></wfs:Insert>` +
    `<wfs:Delete typeName="mapp:dashboards"><ogc:Filter><ogc:FeatureId fid="${original.dash[0].fid}"/></ogc:Filter></wfs:Delete>`);

  // ============================================================ anteprima
  console.log("\n== anteprima ==");
  await page.reload();
  await page.waitForSelector('[aria-label="Backup"] .bk-sections');
  await page.locator('input[aria-label="File di backup da ripristinare"]').setInputFiles(file);
  check("anteprima (unione): regola cambiata, dashboard da ricreare, nulla da eliminare", await waitFor(async () => {
    const r = await planRows();
    return r.includes("Regole dei ruoli 0 1 0 1") && r.includes("Dashboard 1 0 0 0") && r.includes("Avvisi 0 0 0 1");
  }), (await planRows()).join(" | "));
  await restoreCard.locator('label:has-text("Sostituisci") input').check();
  check("sostituzione: la regola aggiunta dopo il backup va eliminata", await waitFor(async () => (await planRows()).includes("Regole dei ruoli 0 1 1 1")));
  await page.screenshot({ path: shot("backup-preview.png"), fullPage: true });

  // ============================================================ ripristino
  console.log("\n== ripristino ==");
  const txBefore = (await J("/__txcount")).txCount;
  const [safety] = await Promise.all([page.waitForEvent("download"), restoreCard.locator('button:has-text("Ripristina (")').click()]);
  check("copia di sicurezza scaricata prima di scrivere", /^gema-config-/.test(safety.suggestedFilename()) && JSON.parse(fs.readFileSync(await safety.path(), "utf8")).sections.rules.some((r) => r.role === "fss-etl-extra"));
  check("messaggio di completamento", await waitFor(async () => /Ripristino completato: 3 modifiche applicate/.test(await page.locator(".page .ok").innerText().catch(() => ""))));
  const rules = await table("role_rules");
  const dash = await table("dashboards");
  check("regole com'erano (strumenti ripristinati, regola in più eliminata)", rules.length === 2 && rules.find((r) => r.role === "fss-etl-ops")?.tools === '["info","table"]' && !rules.some((r) => r.role === "fss-etl-extra"));
  check("dashboard ricreata con widget e filtri", dash.length === 1 && dash[0].title === "Monitoraggio" && JSON.parse(dash[0].definition).filters.area === true && dash[0].updated_by === "alice");
  check("una sola transazione per il ripristino", (await J("/__txcount")).txCount - txBefore === 1, `${(await J("/__txcount")).txCount - txBefore}`);
  const log = await table("change_log");
  check("registro modifiche: le tre modifiche a nome di chi ha ripristinato", ["UPDATE", "DELETE", "INSERT"].every((op) => log.some((e) => e.op === op && e.changed_by === "alice")));
  check("sezioni aggiornate dopo il ripristino", await waitFor(async () => /Regole dei ruoli \(2\)/.test(await secText()) && /Dashboard \(1\)/.test(await secText())));

  // ============================================================ file sbagliati
  console.log("\n== file sbagliati ==");
  const wrong = file.replace(/\.json$|$/, "-dash.json");
  fs.writeFileSync(wrong, JSON.stringify({ format: "gema-dashboards", version: 1, dashboards: [] }));
  await page.locator('input[aria-label="File di backup da ripristinare"]').setInputFiles(wrong);
  check("file di sole dashboard: spiegato", await waitFor(async () => /File non utilizzabile: è un file di sole dashboard/.test(await page.locator(".page .error").innerText().catch(() => ""))));
  await page.locator('input[aria-label="File di backup da ripristinare"]').setInputFiles(file);
  await restoreCard.locator('label:has-text("Sostituisci") input').check();
  check("stesso file di nuovo: niente da cambiare", await waitFor(async () => await restoreCard.locator('button:has-text("Niente da cambiare")').isDisabled()));

  const c2 = await browser.newContext();
  const p2 = await c2.newPage();
  await asRole("fss-etl-viewer", "bob");
  await p2.goto(F.url + "/admin/backup");
  await p2.waitForSelector(".page h1", { timeout: 15000 });
  check("visualizzatore: accesso negato", /Accesso negato/.test(await p2.locator(".page h1").innerText()) && (await p2.locator(".bk-card").count()) === 0);
  await c2.close();

  check("nessun errore JS/console durante i test", errors.length === 0, errors.slice(0, 5).join(" | "));
  await browser.close();
  finish();
})().catch(crash);
