// Dashboard: duplica, esporta (una e tutte) e importa da JSON, con cambio dei layer tra ambienti, sostituzione per
// titolo, file non validi e transazione unica.
import fs from "node:fs";
import { J, MOCK, crash, launchBrowser, prepare, results, shot, startNginx, waitFor } from "./lib.mjs";

const { check, finish } = results();

const rows = async () => (await J("/__state"))["mapp:dashboards"].features.map((f) => ({ fid: f.id, ...f.properties }));
const asRole = (roles, user = "bob") => J(`/__kc?user=${user}&roles=${encodeURIComponent(roles)}`);
const seed = (list) => fetch(`${MOCK}/__seed?layer=${encodeURIComponent("mapp:dashboards")}`, { method: "POST", body: JSON.stringify(list) }).then((r) => r.json());
const W = (id, layer = "iride:parcels", extra = {}) => ({ id, type: "kpi", title: `KPI ${id}`, layer, agg: "count", w: 1, ...extra });

(async () => {
  prepare();
  await J("/__reset");
  const D = startNginx("DIO", 8088, {
    AUTH_ENABLED: "true", KEYCLOAK_URL: `${MOCK}/kc`, KEYCLOAK_REALM: "test", KEYCLOAK_CLIENT_ID: "mapp",
    ACCESS_CONTROL: "true", KNOWN_ROLES: "fss-etl-viewer, fss-etl-ops", GEOSERVER_WRITE_PASSTHROUGH: "true",
    GEOSERVER_PROXY_URL: `${MOCK}/geoserver`, GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass",
    BASEMAP_TILES: `${MOCK}/tiles/{z}/{x}/{y}.png`, APP_TITLE: "Test dashboard JSON", MAP_CENTER_LON: "12.5", MAP_CENTER_LAT: "41.9", MAP_ZOOM: "9", GEOCODER: "off",
  });
  await seed([
    { title: "Particelle", description: "Monitoraggio", roles: '["fss-etl-viewer"]', definition: JSON.stringify([W("a"), W("b", "iride:parcels", { type: "bar", field: "kind", w: 2 })]) },
    { title: "Sensori", description: "", roles: "[]", definition: JSON.stringify([W("c", "iride:sensors")]) },
  ]);
  const browser = await launchBrowser();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  await asRole("fss-etl-admin", "alice");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  page.on("dialog", (d) => d.accept());
  await page.goto(D.url + "/admin/dashboards");
  await page.waitForSelector(".dash-item", { timeout: 15000 });
  const grab = async (click) => {
    const ev = page.waitForEvent("download", { timeout: 10000 });
    await click();
    const d = await ev;
    const p = shot(d.suggestedFilename());
    await d.saveAs(p);
    return { name: d.suggestedFilename(), path: p, json: JSON.parse(fs.readFileSync(p, "utf8")) };
  };

  // ============================================================ duplica
  console.log("\n== duplica ==");
  await page.locator('.dash-item:has-text("Particelle")').click();
  await page.locator('.dash-editor button:has-text("Duplica")').click();
  const titleInput = page.locator('.dash-editor > .form-grid label:has(> span:text-is("Titolo")) input');
  check("duplica: editor con il titolo '(copia)', nuova dashboard", (await titleInput.inputValue()) === "Particelle (copia)" && /Copia pronta/.test(await page.locator(".page .ok").innerText()) && (await page.locator('.dash-editor button:has-text("Duplica")').count()) === 0);
  await page.locator('button:text-is("Pubblica")').click();
  check("copia salvata come riga nuova, con gli stessi widget e ruoli (id dei widget nuovi)", await waitFor(async () => {
    const r = await rows();
    const c = r.find((x) => x.title === "Particelle (copia)");
    if (!c || r.length !== 3) return false;
    const w = JSON.parse(c.definition);
    return w.length === 2 && w[1].field === "kind" && w[0].id !== "a" && JSON.parse(c.roles).join() === "fss-etl-viewer";
  }));

  // ============================================================ esporta
  console.log("\n== esporta ==");
  await page.locator('.dash-item:has-text("Sensori")').click();
  const one = await grab(() => page.locator('.dash-editor button:has-text("Esporta (JSON)")').click());
  check("esporta una: nome del file dal titolo, formato e versione", one.name === "dashboard-sensori.json" && one.json.format === "gema-dashboards" && one.json.version === 1 && one.json.dashboards.length === 1);
  check("esporta: niente fid né autore, widget completi", !("fid" in one.json.dashboards[0]) && !("updatedBy" in one.json.dashboards[0]) && one.json.dashboards[0].widgets[0].layer === "iride:sensors");
  const all = await grab(() => page.locator('button:has-text("Esporta tutte (JSON)")').click());
  check("esporta tutte: tre dashboard, con l'host di provenienza", all.json.dashboards.length === 3 && all.json.source === "127.0.0.1:8088" && /^dashboard-\d{4}-\d{2}-\d{2}\.json$/.test(all.name));

  // ============================================================ importa
  console.log("\n== importa ==");
  const file = shot("import-test.json");
  const src = structuredClone(all.json);
  src.dashboards[0].title = "Particelle";                                  // esiste: da sostituire
  src.dashboards[0].widgets[0].layer = "uat:parcels";                       // layer di un altro ambiente
  src.dashboards[0].widgets.push({ type: "torta", layer: "x" });            // widget non valido
  src.dashboards[1].title = "Sensori bis";                                   // nuova
  src.dashboards[1].roles = ["fss-etl-uat-only"];
  src.dashboards[2].title = "Da non importare";
  fs.writeFileSync(file, JSON.stringify(src));
  const input = page.locator('input[aria-label="Importa dashboard da un file JSON"]');
  await input.setInputFiles(file);
  const panel = page.locator(".import-panel");
  await panel.waitFor();
  check("anteprima: tre dashboard, widget scartato segnalato", (await panel.locator("tbody tr").count()) === 3 && /1 widget non validi scartati/.test(await panel.innerText()));
  check("anteprima: dashboard esistente riconosciuta per titolo", /Esiste già/.test(await panel.locator('tr[data-title="Particelle"]').innerText()) && /nuova/.test(await panel.locator('tr[data-title="Sensori bis"]').innerText()));
  check("anteprima: layer mancante da sostituire, ruolo sconosciuto segnalato", (await panel.locator('select[aria-label="Sostituisci uat:parcels"]').count()) === 1 && /fss-etl-uat-only/.test(await panel.innerText()));
  await panel.locator('select[aria-label="Sostituisci uat:parcels"]').selectOption("iride:parcels");
  await panel.locator('tr[data-title="Particelle"] .check input').check();
  await panel.locator('input[aria-label="Importa Da non importare"]').uncheck();
  await page.screenshot({ path: shot("dashio-import.png"), fullPage: true });
  const tx0 = (await J("/__log")).filter((l) => l.method === "POST").length;
  await panel.locator('button:has-text("Importa 2 dashboard (1 sostituite)")').click();
  check("importazione: conferma", await waitFor(async () => /Importate 2 dashboard/.test(await page.locator(".page .ok").innerText())));
  check("importazione in un'unica transazione WFS-T", (await J("/__log")).filter((l) => l.method === "POST").length === tx0 + 1);
  const r = await rows();
  const part = r.filter((x) => x.title === "Particelle");
  check("sostituita la dashboard esistente (stessa riga), layer rimappato, widget non valido assente", part.length === 1 && part[0].fid === "dashboards.1" &&
    JSON.parse(part[0].definition).every((w) => w.layer === "iride:parcels") && JSON.parse(part[0].definition).length === 2, JSON.stringify(part));
  check("aggiunta la nuova, non importata quella esclusa", r.some((x) => x.title === "Sensori bis" && JSON.parse(x.roles).join() === "fss-etl-uat-only") && !r.some((x) => x.title === "Da non importare") && r.length === 4);

  // una sola dashboard: si può aprire nell'editor prima di salvare
  fs.writeFileSync(file, JSON.stringify({ title: "Bozza importata", widgets: [W("z", "demo:roads")] }));
  await input.setInputFiles(file);
  await page.locator('.import-panel button:has-text("Apri nell\'editor")').click();
  check("una dashboard: 'Apri nell'editor' la carica senza salvarla", (await titleInput.inputValue()) === "Bozza importata" && (await rows()).length === 4);

  // file non validi
  for (const [content, re] of [["non è json", /non è JSON valido/], [JSON.stringify({ format: "altro", dashboards: [] }), /formato non riconosciuto/], [JSON.stringify({ format: "gema-dashboards", version: 9, dashboards: [] }), /versione più recente/], [JSON.stringify({ dashboards: [{ title: "", widgets: [] }] }), /nessuna dashboard importabile/]]) {
    fs.writeFileSync(file, content);
    await input.setInputFiles(file);
    check(`file non valido: ${re.source}`, await waitFor(async () => re.test(await page.locator(".page .error").innerText())) && (await page.locator(".import-panel").count()) === 0);
  }

  check("nessun errore JS/console durante i test", errors.length === 0, errors.slice(0, 5).join(" | "));
  await browser.close();
  finish();
})().catch(crash);
