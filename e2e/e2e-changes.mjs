// Registro modifiche: le scritture sulle tabelle di configurazione finiscono nel registro (come il trigger PostGIS),
// l'eliminazione dall'app registra chi elimina, la pagina mostra chi/cosa/quando con il dettaglio dei campi,
// ripristina un elemento eliminato e riporta una riga a una versione precedente; filtri e cronologia di un elemento.
import { J, MOCK, crash, launchBrowser, prepare, results, shot, startNginx, waitFor } from "./lib.mjs";

const { check, finish } = results();
const asRole = (roles, user = "bob") => J(`/__kc?user=${user}&roles=${encodeURIComponent(roles)}`);
const table = async (t) => (await J("/__state"))[`mapp:${t}`].features.map((f) => ({ fid: f.id, ...f.properties }));
const WRITE = "Basic " + Buffer.from("writer:wpass").toString("base64");
/** Scrittura di un altro amministratore (diretta su GeoServer, senza passare dall'app). */
const tx = (ops) => fetch(`${MOCK}/geoserver/wfs`, {
  method: "POST", headers: { Authorization: WRITE, "Content-Type": "text/xml" },
  body: `<wfs:Transaction service="WFS" version="1.0.0" xmlns:wfs="http://www.opengis.net/wfs" xmlns:ogc="http://www.opengis.net/ogc" xmlns:mapp="http://iride.example/mapp">${ops}</wfs:Transaction>`,
}).then((r) => r.text());
const prop = (k, v) => `<wfs:Property><wfs:Name>${k}</wfs:Name><wfs:Value>${v}</wfs:Value></wfs:Property>`;

(async () => {
  prepare();
  await J("/__reset");
  const F = startNginx("CL", 8082, {
    AUTH_ENABLED: "true", KEYCLOAK_URL: `${MOCK}/kc`, KEYCLOAK_REALM: "test", KEYCLOAK_CLIENT_ID: "mapp",
    ACCESS_CONTROL: "true", KNOWN_ROLES: "fss-etl-viewer,fss-etl-ops", GEOSERVER_WRITE_PASSTHROUGH: "true",
    GEOSERVER_PROXY_URL: `${MOCK}/geoserver`, GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass",
    BASEMAP_TILES: `${MOCK}/tiles/{z}/{x}/{y}.png`, BASEMAPS: `osm|Mappa|${MOCK}/tiles/{z}/{x}/{y}.png|© test`,
    APP_TITLE: "Test registro", MAP_CENTER_LON: "12.5", MAP_CENTER_LAT: "41.9", MAP_ZOOM: "9", GEOCODER: "off",
  });
  // storia: ada crea la regola di ops, bea le aggiunge strumenti, ada crea una dashboard
  await tx(`<wfs:Insert><mapp:role_rules><mapp:role>fss-etl-ops</mapp:role><mapp:layers>["*"]</mapp:layers><mapp:tools>[]</mapp:tools><mapp:updated_by>ada</mapp:updated_by></mapp:role_rules></wfs:Insert>`);
  await tx(`<wfs:Update typeName="mapp:role_rules">${prop("tools", '["info","table"]')}${prop("updated_by", "bea")}<ogc:Filter><ogc:FeatureId fid="role_rules.1"/></ogc:Filter></wfs:Update>`);
  await tx(`<wfs:Update typeName="mapp:role_rules">${prop("updated_by", "zeno")}${prop("updated_at", "2026-10-20T10:00:00Z")}<ogc:Filter><ogc:FeatureId fid="role_rules.1"/></ogc:Filter></wfs:Update>`); // solo timbro
  await tx(`<wfs:Insert><mapp:dashboards><mapp:title>Monitoraggio</mapp:title><mapp:description></mapp:description><mapp:roles>["fss-etl-viewer"]</mapp:roles><mapp:definition>[]</mapp:definition><mapp:updated_by>ada</mapp:updated_by></mapp:dashboards></wfs:Insert>`);
  check("registro: 3 voci (il solo timbro non conta)", (await table("change_log")).length === 3);
  const denied = await tx(`<wfs:Delete typeName="mapp:change_log"><ogc:Filter><ogc:FeatureId fid="change_log.1"/></ogc:Filter></wfs:Delete>`);
  check("il registro non si scrive via WFS-T", /FAILED/.test(denied) && (await table("change_log")).length === 3);

  const browser = await launchBrowser();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  page.on("dialog", (d) => d.accept());
  const entries = () => page.locator(".cl-entry");
  const summaries = async () => (await entries().locator("summary").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());

  // ============================================================ eliminazione dall'app
  console.log("\n== eliminazione firmata ==");
  await asRole("fss-etl-admin", "alice");
  await page.goto(F.url + "/admin/dashboards");
  await page.waitForSelector(".dash-editor", { timeout: 15000 });
  await page.locator('.dash-item:has-text("Monitoraggio")').click();
  await page.locator('.dash-editor button:text-is("Elimina")').click();
  check("dashboard eliminata", await waitFor(async () => (await table("dashboards")).length === 0));
  const last = (await table("change_log")).at(-1);
  check("registro: eliminazione attribuita a chi ha eliminato (alice), con la riga com'era", last.op === "DELETE" && last.changed_by === "alice" && JSON.parse(last.old_data).title === "Monitoraggio" && last.new_data === null);

  // ============================================================ pagina
  console.log("\n== pagina del registro ==");
  await page.locator("button.nav-tag").click();
  await page.locator('.nav-menu a:has-text("Registro modifiche")').click();
  check("elenco: 4 modifiche, la più recente prima", await waitFor(async () => (await entries().count()) === 4) && /^4 modifiche\./.test(await page.locator(".cl-count").innerText()));
  let s = await summaries();
  check("righe: quando, operazione, cosa, chi", /Eliminato Dashboard Monitoraggio alice/.test(s[0]) && /Creato Dashboard Monitoraggio ada/.test(s[1]) && /Modificato Regole dei ruoli fss-etl-ops bea versione attuale tools/.test(s[2]) && /Creato Regole dei ruoli fss-etl-ops ada/.test(s[3]), s.join(" | "));
  await entries().nth(2).locator("summary").click();
  const diff = await entries().nth(2).locator("table.cl-diff").innerText();
  check("dettaglio della modifica: campo, prima, dopo", /tools\s+\[\]\s+\[\s*"info",\s*"table"\s*\]/.test(diff), diff);
  check("versione attuale: 'Torna a questa versione' spento", await entries().nth(2).locator('button:has-text("Torna a questa versione")').isDisabled());
  await page.screenshot({ path: shot("changes-list.png"), fullPage: true });

  // ============================================================ ripristini
  console.log("\n== ripristini ==");
  await entries().nth(0).locator("summary").click();
  await entries().nth(0).locator('button:has-text("Ripristina l\'elemento eliminato")').click();
  check("dashboard ripristinata (nuova riga) a nome di chi ripristina", await waitFor(async () => { const d = await table("dashboards"); return d.length === 1 && d[0].title === "Monitoraggio" && d[0].roles === '["fss-etl-viewer"]' && d[0].updated_by === "alice"; }));
  check("messaggio e registro aggiornato", await waitFor(async () => /Ripristinato: Dashboard · Monitoraggio \(ricreato come elemento nuovo\)/.test(await page.locator(".page .ok").innerText().catch(() => ""))) &&
    await waitFor(async () => (await summaries())[0]?.includes("Creato Dashboard Monitoraggio alice")));
  // la regola torna a com'era quando ada l'ha creata
  const nthMatching = async (re) => entries().nth((await summaries()).findIndex((t) => re.test(t)));
  const created = await nthMatching(/Creato Regole dei ruoli fss-etl-ops ada/);
  await created.locator("summary").click();
  await created.locator('button:has-text("Torna a questa versione")').click();
  check("regola riportata alla versione di ada (tools vuoti), firmata da alice", await waitFor(async () => { const r = await table("role_rules"); return r.length === 1 && r[0].tools === "[]" && r[0].layers === '["*"]' && r[0].updated_by === "alice"; }));
  check("registro: la modifica del ripristino in cima", await waitFor(async () => /Modificato Regole dei ruoli fss-etl-ops alice (versione attuale )?tools/.test((await summaries())[0] ?? "")));
  check("il ripristino si vede nella pagina Ruoli (configurazione ricaricata)", await (async () => {
    await page.locator("button.nav-tag").click();
    await page.locator('.nav-menu a:has-text("Ruoli e permessi")').click();
    await page.waitForSelector('.role-card[data-role="fss-etl-ops"]');
    return /modificata da alice/.test(await page.locator('.role-card[data-role="fss-etl-ops"] .role-head').innerText());
  })());

  // ============================================================ filtri
  console.log("\n== filtri ==");
  await page.goto(F.url + "/admin/changes");
  await waitFor(async () => (await entries().count()) === 6);
  await page.locator('.cl-filters label:has(> span:text-is("Utente")) input').fill("bea");
  await page.locator('.cl-filters button:text-is("Cerca")').click();
  check("filtro per utente: solo bea, senza 'versione attuale'", await waitFor(async () => (await entries().count()) === 1) && (await page.locator(".cl-entry .chip").count()) === 0);
  check("filtro per utente nella richiesta WFS (CQL)", (await J("/__log")).some((l) => decodeURIComponent(l.query).includes("changed_by = 'bea'")));
  await page.locator('.cl-filters button:has-text("Ultimi 30 giorni")').click();
  await waitFor(async () => (await entries().count()) === 6);
  await page.locator('.cl-filters label:has(> span:text-is("Cerca")) input').fill("Monitoraggio");
  await page.locator('.cl-filters button:text-is("Cerca")').click();
  check("ricerca nel testo: solo le voci della dashboard", await waitFor(async () => (await entries().count()) === 3));
  await page.locator('.cl-filters button:has-text("Ultimi 30 giorni")').click();
  await waitFor(async () => (await entries().count()) === 6);
  const rule = await nthMatching(/Creato Regole dei ruoli fss-etl-ops ada/);
  await rule.locator("summary").click();
  await rule.locator('button:has-text("Cronologia di questo elemento")').click();
  check("cronologia di un elemento: le 3 versioni della regola", await waitFor(async () => (await entries().count()) === 3) && /Cronologia di un solo elemento \(Regole dei ruoli #1\)/.test(await page.locator(".cl-history").innerText()));

  // ============================================================ tabella mancante, utente normale
  console.log("\n== casi limite ==");
  await J("/__tables?off=1&only=mapp:change_log");
  await page.reload();
  check("registro non pubblicato: avviso con il nome del layer", await waitFor(async () => /Registro non disponibile: .*mapp:change_log/.test(await page.locator(".page .error").innerText().catch(() => ""))));
  await J("/__tables?off=0");
  const c2 = await browser.newContext();
  const p2 = await c2.newPage();
  await asRole("fss-etl-viewer", "bob");
  await p2.goto(F.url + "/admin/changes");
  await p2.waitForSelector(".page h1", { timeout: 15000 });
  check("visualizzatore: nessun accesso al registro", /Accesso (negato|non configurato)/.test(await p2.locator(".page h1").innerText()) && (await p2.locator(".cl-entry").count()) === 0);
  await c2.close();

  check("nessun errore JS/console durante i test", errors.length === 0, errors.slice(0, 5).join(" | "));
  await browser.close();
  finish();
})().catch(crash);
