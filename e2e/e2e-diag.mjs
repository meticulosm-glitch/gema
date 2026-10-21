// Pagina di diagnostica: GeoServer, tabelle di configurazione (colonne e lettura), prova di scrittura che non cambia
// nulla, ruoli nel token, Keycloak (discovery, rinnovo del token e CORS), sfondi; errori riconosciuti con il rimedio;
// rapporto copiato e scaricato senza token; pagina riservata agli amministratori.
import { J, MOCK, crash, launchBrowser, prepare, results, shot, startNginx, waitFor } from "./lib.mjs";

const { check, finish } = results();
const asRole = (roles, user = "bob") => J(`/__kc?user=${user}&roles=${encodeURIComponent(roles)}`);
const TABLES = ["role_rules", "dashboards", "saved_views", "catalog_folders", "catalog_layers", "role_views", "edit_forms", "announcements", "dashboard_drafts"];

(async () => {
  prepare();
  await J("/__reset");
  const F = startNginx("DG", 8083, {
    AUTH_ENABLED: "true", KEYCLOAK_URL: `${MOCK}/kc`, KEYCLOAK_REALM: "test", KEYCLOAK_CLIENT_ID: "mapp",
    ACCESS_CONTROL: "true", KNOWN_ROLES: "fss-etl-viewer", GEOSERVER_WRITE_PASSTHROUGH: "true",
    GEOSERVER_PROXY_URL: `${MOCK}/geoserver`, GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass",
    BASEMAP_TILES: `${MOCK}/tiles/{z}/{x}/{y}.png`, BASEMAPS: `osm|Mappa|${MOCK}/tiles/{z}/{x}/{y}.png|© test`,
    APP_TITLE: "Test diagnostica", MAP_CENTER_LON: "12.5", MAP_CENTER_LAT: "41.9", MAP_ZOOM: "9", GEOCODER: "off",
  });
  await fetch(`${MOCK}/__seed?layer=${encodeURIComponent("mapp:role_rules")}`, { method: "POST", body: JSON.stringify([{ role: "fss-etl-viewer", layers: '["*"]', tools: '["info"]', updated_by: "alice" }]) });
  const browser = await launchBrowser();
  const errors = [];
  let corsPhase = false;
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 1000 }, acceptDownloads: true });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: F.url });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() !== "error" || /favicon|Failed to load resource/.test(m.text())) return;
    if (corsPhase && /CORS|kc|keycloak|token/i.test(m.text())) return; // atteso: Keycloak senza CORS
    errors.push("console: " + m.text());
  });
  const row = (id) => page.locator(`.diag-row[data-check="${id}"]`);
  const status = async (id) => (await row(id).getAttribute("class"))?.match(/ds-(\w+)/)?.[1];
  const done = () => waitFor(async () => !/Controllo in corso/.test(await page.locator(".diag-summary").innerText()) && (await page.locator(".diag-summary").innerText()).length > 0, 20000);
  const rerun = async () => { await page.locator('button:has-text("Ripeti i controlli")').click(); await waitFor(async () => /Controllo in corso/.test(await page.locator(".diag-summary").innerText()), 3000); return done(); };

  // ============================================================ tutto a posto
  console.log("\n== tutto a posto ==");
  await asRole("fss-etl-admin", "alice");
  await page.goto(F.url + "/admin/diagnostics");
  await page.waitForSelector(".diag-summary", { timeout: 15000 });
  check("i controlli partono da soli e finiscono", await done());
  check("riepilogo: nessun errore né avviso", /Tutto a posto: \d+ controlli superati/.test(await page.locator(".diag-summary").innerText()), await page.locator(".diag-summary").innerText());
  check("GeoServer: WMS e WFS", (await status("gs-wms")) === "ok" && (await status("gs-wfs")) === "ok");
  const tableStates = await Promise.all(TABLES.map((t) => status(`table-${t}`)));
  check("tutte le tabelle con le colonne attese e leggibili", tableStates.every((s) => s === "ok"), tableStates.join());
  check("prova di scrittura accettata", (await status("write")) === "ok");
  const rr = (await J("/__state"))["mapp:role_rules"].features;
  check("la prova non ha cambiato righe", rr.length === 1 && rr[0].properties.updated_by === "alice");
  check("WFS-T di prova con il filtro che non trova nulla", (await J("/__log")).some((l) => l.method === "POST" && l.body.includes("__gema_diagnostica__")));
  check("token: ruolo admin e scadenza", (await status("token-roles")) === "ok" && /Client role di mapp: fss-etl-admin/.test(await row("token-roles").innerText()) && (await status("token-exp")) === "ok");
  check("Keycloak: discovery e rinnovo del token", (await status("kc-discovery")) === "ok" && (await status("kc-refresh")) === "ok");
  check("indirizzi per il client Keycloak con l'origine dell'app", (await row("kc-redirect").innerText()).includes(`Web origins: ${F.url}`));
  check("sfondo raggiungibile", (await status("basemap-osm")) === "ok");
  await page.screenshot({ path: shot("diag-ok.png"), fullPage: true });

  // ============================================================ rapporto
  console.log("\n== rapporto ==");
  await page.locator('button:has-text("Copia rapporto")').click();
  check("copia: messaggio", await waitFor(async () => /Rapporto copiato/.test(await page.locator(".page .ok").innerText().catch(() => ""))));
  const text = await page.evaluate(() => navigator.clipboard.readText());
  check("rapporto: gruppi, stati, nessun token", text.startsWith("Diagnostica Gema · ") && text.includes("## Tabelle di configurazione") && text.includes("[OK] Scrittura (WFS-T)") && !text.includes("eyJ"));
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator('button:has-text("Scarica rapporto")').click()]);
  check("scarica: file di testo con data", /^diagnostica-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.txt$/.test(dl.suggestedFilename()));

  // ============================================================ problemi riconosciuti
  console.log("\n== problemi ==");
  await J("/__tables?off=1&only=mapp:dashboard_drafts,mapp:announcements");
  await J("/__failtx?msg=" + encodeURIComponent("Access denied: scrittura non consentita"));
  check("ripeti", await rerun());
  check("tabelle non pubblicate: errore con il rimedio", (await status("table-dashboard_drafts")) === "fail" && (await status("table-announcements")) === "fail" &&
    /Non pubblicata in GeoServer[\s\S]*Riesegui il Job/.test(await row("table-dashboard_drafts").innerText()) && (await status("table-role_rules")) === "ok");
  check("scrittura rifiutata: errore e dove intervenire", (await status("write")) === "fail" && /Access denied[\s\S]*ACL_WRITE_ROLES/.test(await row("write").innerText()));
  check("riepilogo con gli errori", /^3 errori/.test(await page.locator(".diag-summary").innerText()));
  check("in cima: cosa sistemare, con i collegamenti", JSON.stringify((await page.locator('[aria-label="Da sistemare"] a').allInnerTexts()).sort()) === JSON.stringify(["Scrittura (WFS-T)", "mapp:announcements", "mapp:dashboard_drafts"]));
  await page.screenshot({ path: shot("diag-errors.png"), fullPage: true });
  await J("/__tables?off=0");

  corsPhase = true;
  await J("/__kc?cors=0");
  check("ripeti senza CORS su Keycloak", await rerun());
  check("Keycloak senza CORS: discovery e rinnovo falliscono, con l'origine da aggiungere", (await status("kc-discovery")) === "fail" && (await status("kc-refresh")) === "fail" &&
    (await row("kc-refresh").innerText()).includes(`Aggiungi ${F.url} a "Web origins"`));
  await J("/__kc?cors=1");
  check("CORS ripristinato: tutto a posto", await rerun() && /Tutto a posto/.test(await page.locator(".diag-summary").innerText()));
  corsPhase = false;

  // ============================================================ riservata
  console.log("\n== riservata agli amministratori ==");
  const p2ctx = await browser.newContext();
  const p2 = await p2ctx.newPage();
  await asRole("fss-etl-viewer", "bob");
  await p2.goto(F.url + "/admin/diagnostics");
  await p2.waitForSelector(".page h1", { timeout: 15000 });
  check("visualizzatore: accesso negato", /Accesso negato/.test(await p2.locator(".page h1").innerText()) && (await p2.locator(".diag-row").count()) === 0);
  await p2ctx.close();

  check("nessun errore JS/console durante i test", errors.length === 0, errors.slice(0, 5).join(" | "));
  await browser.close();
  finish();
})().catch(crash);
