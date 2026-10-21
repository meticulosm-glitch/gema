// Test dei ruoli: Keycloak finto (admin / viewer / ruolo senza regole), pagine admin, dashboard, scritture negate.
import { execSync } from "node:child_process";
import fs from "node:fs";
import { J, MOCK, crash, goAdmin, launchBrowser, prepare, results, shot, sleep, startNginx, runtimeConfig, waitFor } from "./lib.mjs";

const { check, finish } = results();

const st = () => J("/__state");
const asRole = (roles, user = "bob") => J(`/__kc?user=${user}&roles=${encodeURIComponent(roles)}`);

const jwtFor = (roles) => { const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); return `${b({ alg: "none" })}.${b({ preferred_username: "x", resource_access: { mapp: { roles } } })}.sig`; };

(async () => {
  prepare();
  await J("/__reset");
  const C = startNginx("C", 8093, {
    AUTH_ENABLED: "true", KEYCLOAK_URL: `${MOCK}/kc`, KEYCLOAK_REALM: "test", KEYCLOAK_CLIENT_ID: "mapp",
    ACCESS_CONTROL: "true", KNOWN_ROLES: "fss-etl-viewer, fss-etl-ops", EDIT_ENABLED: "true", GEOSERVER_WRITE_PASSTHROUGH: "true",
    GEOSERVER_PROXY_URL: `${MOCK}/geoserver`, GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass",
    BASEMAP_TILES: `${MOCK}/tiles/{z}/{x}/{y}.png`, APP_TITLE: "Test ruoli", MAP_CENTER_LON: "12.5", MAP_CENTER_LAT: "41.9", MAP_ZOOM: "9", GEOCODER: "off",
  });
  const browser = await launchBrowser();
  const errors = [];
  const open = async (urlPath = "/") => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
    page.on("dialog", (d) => d.accept());
    await page.goto(C.url + urlPath);
    await page.waitForSelector(".header", { timeout: 15000 });
    return page;
  };
  const openGroups = (page) => page.evaluate(() => document.querySelectorAll("details.group").forEach((d) => (d.open = true)));
  const items = async (page) => { await waitFor(async () => (await page.locator("label.item").count()) > 0); await openGroups(page); return (await page.locator("label.item").allInnerTexts()).map((t) => t.trim()).sort(); };

  // ---------------------------------------------------------------- config
  console.log("\n== config e proxy ==");
  const cfg = await (await fetch(C.url + "/config.json")).json();
  check("config.json: blocco access con ruoli di default e KNOWN_ROLES", cfg.access?.enabled && cfg.access.adminRole === "fss-etl-admin" && cfg.access.viewerRole === "fss-etl-viewer" && cfg.access.rolesClient === "mapp" && cfg.access.knownRoles.join() === "fss-etl-viewer,fss-etl-ops" && cfg.access.workspace === "mapp", JSON.stringify(cfg.access));
  const post = (auth) => execSync(`curl -s -o /dev/null -w '%{http_code}' -X POST '${C.url}/geoserver/wfs' ${auth ? `-H 'Authorization: ${auth}'` : ""} -H 'Content-Type: text/xml' -d '<wfs:Transaction xmlns:wfs="http://www.opengis.net/wfs" service="WFS" version="1.0.0"/>'`, { encoding: "utf8" });
  check("scrittura con token viewer: negata (403 da GeoServer)", post(`Bearer ${jwtFor(["fss-etl-viewer"])}`) === "403");
  check("scrittura con token admin: accettata", post(`Bearer ${jwtFor(["fss-etl-admin"])}`) === "200");
  check("scrittura senza token: rifiutata (401), nessuna credenziale fissa iniettata", post("") === "401");
  check("POST su altri endpoint resta vietato (403)", execSync(`curl -s -o /dev/null -w '%{http_code}' -X POST '${C.url}/geoserver/rest/workspaces' -d x`, { encoding: "utf8" }) === "403");
  check("config: ACCESS_CONTROL ignorato senza Keycloak", !runtimeConfig({ AUTH_ENABLED: "false", ACCESS_CONTROL: "true" }).includes('"access"'));

  // ---------------------------------------------------------------- ruoli senza accesso / viewer senza regole
  console.log("\n== viewer ==");
  await asRole("some-other-role");
  let page = await open();
  check("ruolo non abilitato: 'Accesso non configurato' con i ruoli letti", await waitFor(async () => /Accesso non configurato/.test(await page.locator(".page").innerText()) && /some-other-role/.test(await page.locator(".page").innerText())));
  await page.close();

  await asRole("fss-etl-viewer");
  page = await open();
  const all4 = await items(page);
  check("viewer senza regole salvate: vede tutti i 4 layer (e non le tabelle di configurazione)", all4.length === 4 && !all4.some((t) => /role_rules|dashboards/.test(t)), all4.join());
  check("viewer: nessun menu Admin", (await page.locator(".nav-tag").count()) === 0);
  check("viewer: strumenti di sola lettura (misure, 3D, stampa presenti)", (await page.locator('button.tool[title="Misura distanza"]').count()) === 1 && (await page.locator('button.tool[title="Vista inclinata"]').count()) === 1);
  await page.locator('label.item:has-text("Particelle") input').check();
  await page.waitForSelector(".active-card");
  check("viewer: niente pulsante di modifica anche con EDIT_ENABLED", (await page.locator('.active-card [title="Modifica oggetti"]').count()) === 0);
  check("viewer: tabella e grafici sul layer presenti", (await page.locator('.active-card [title="Tabella attributi"]').count()) === 1 && (await page.locator('.active-card [title="Dashboard"]').count()) === 1);
  check("viewer senza regole: 'Scarica dati' presente (strumenti predefiniti)", (await page.locator('.active-card [title="Scarica dati"]').count()) === 1);
  await page.close();
  page = await open("/admin/roles");
  check("viewer su /admin/roles: accesso negato", await waitFor(async () => /Accesso negato/.test(await page.locator(".page").innerText())));
  await page.close();

  // ---------------------------------------------------------------- admin: ruoli
  console.log("\n== admin: ruoli ==");
  await asRole("fss-etl-admin", "alice");
  page = await open();
  const adminItems = await items(page);
  check("admin: vede tutti i layer", adminItems.length === 4);
  await page.locator('label.item:has-text("Particelle") input').check();
  await page.waitForSelector(".active-card");
  check("admin: pulsante di modifica visibile (EDIT_ENABLED + ruolo)", (await page.locator('.active-card [title="Modifica oggetti"]').count()) === 1);
  await page.locator("button.nav-tag").click();
  check("admin: menu Admin nella barra con le pagine", (await page.locator(".nav-tag").count()) === 1 && JSON.stringify(await page.locator(".nav-menu a").allInnerTexts()) === JSON.stringify(["Ruoli e permessi", "Catalogo prodotti", "Moduli di modifica", "Avvisi", "Crea dashboard", "Registro modifiche", "Statistiche d'uso", "Backup e ripristino", "Diagnostica"]));
  await page.locator('.nav-menu a:has-text("Ruoli e permessi")').click();
  check("admin: la pagina corrente compare sul pulsante del menu", /Ruoli e permessi/.test(await page.locator("button.nav-tag").innerText()) && (await page.locator(".nav-menu").count()) === 0);
  check("pagina ruoli: titolo, nota 'nessuna regola', card admin bloccata", await waitFor(async () => /Ruoli e permessi/.test(await page.locator("h1").innerText()) && /Nessuna regola salvata/.test(await page.locator(".page").innerText()) && (await page.locator(".role-card.locked").count()) === 1));
  check("pagina ruoli: card per i ruoli da KNOWN_ROLES e VIEWER_ROLE", await waitFor(async () => (await page.locator(".role-card[data-role]").count()) === 2));
  const vcard = page.locator('.role-card[data-role="fss-etl-viewer"]');
  await waitFor(async () => (await vcard.locator(".check-list .check").count()) === 4);
  check("pagina ruoli: elenco dei 4 layer pubblicati (senza tabelle di configurazione)", (await vcard.locator(".check-list .check").count()) === 4);
  check("salva disabilitato senza layer scelti", await vcard.locator('button:has-text("Salva regola")').isDisabled());
  await vcard.locator('.check-list .check:has-text("Particelle") input').check();
  await vcard.locator('.check-list .check:has-text("Sensori") input').check();
  // la regola deve lasciare solo "Interroga oggetti" e "Tabella attributi"
  for (const t of ["Misure e coordinate", "Vista 3D", "Stampa / esporta", "Grafici sul layer", "Serie storica in un punto", "Confronto con cursore", "Ricerca luoghi e attributi", "Viste salvate", "Scarica dati"]) await vcard.locator(`.check:has-text("${t}") input`).uncheck();
  await vcard.locator('button:has-text("Salva regola")').click();
  check("regola salvata (messaggio)", await waitFor(async () => /Regola di fss-etl-viewer salvata/.test(await page.locator(".page .ok").innerText())));
  let s = await st();
  const rr = s["mapp:role_rules"].features;
  check("WFS-T: riga in role_rules con layer e strumenti", rr.length === 1 && rr[0].properties.role === "fss-etl-viewer" && JSON.stringify(JSON.parse(rr[0].properties.layers)) === JSON.stringify(["iride:parcels", "iride:sensors"]) && JSON.parse(rr[0].properties.tools).sort().join() === ["info", "table"].join(), JSON.stringify(rr[0]?.properties));
  check("dopo il salvataggio la nota 'nessuna regola' sparisce", await waitFor(async () => !/Nessuna regola salvata/.test(await page.locator(".page").innerText())));
  check("regola salvata registra l'utente", rr[0].properties.updated_by === "alice");
  // modifica di una regola esistente (update, non insert)
  await vcard.locator('.check:has-text("Misure e coordinate") input').check().catch(() => {});
  await page.locator('.role-card[data-role="fss-etl-viewer"] .check:has-text("Misure e coordinate") input').check();
  await page.locator('.role-card[data-role="fss-etl-viewer"] button:has-text("Salva regola")').click();
  check("modifica regola: update sulla stessa riga", await waitFor(async () => { const r = (await st())["mapp:role_rules"].features; return r.length === 1 && JSON.parse(r[0].properties.tools).includes("measure"); }));
  // nuovo ruolo
  await page.fill('.add-role input', "fss-etl-analyst");
  await page.locator('.add-role button:has-text("Aggiungi ruolo")').click();
  check("aggiunta di un ruolo nuovo (non salvato)", await waitFor(async () => (await page.locator('.role-card[data-role="fss-etl-analyst"] .chip:has-text("non salvata")').count()) === 1));
  await page.screenshot({ path: shot("admin-roles.png"), fullPage: true });

  // ---------------------------------------------------------------- admin: dashboard
  console.log("\n== admin: dashboard ==");
  await goAdmin(page, "Crea dashboard");
  await page.waitForSelector(".dash-editor");
  check("crea dashboard: salvataggio bloccato finché mancano dati", await page.locator('.dash-editor button:text-is("Pubblica")').isDisabled() && /Manca il titolo/.test(await page.locator(".problems").innerText()));
  await page.locator('.dash-editor .form-grid label:has(> span:text-is(\"Titolo\")) input').first().fill("Monitoraggio particelle");
  await page.locator('.dash-editor .check-row .check:has-text("fss-etl-viewer") input').check();
  const addW = () => page.locator('.dash-editor button:has-text("Aggiungi widget")').click();
  await addW();
  const w = (i) => page.locator(".widget-form").nth(i);
  await w(0).locator('label:has(> span:text-is(\"Layer\")) select').selectOption("iride:parcels");
  await w(0).locator('label:has(> span:text-is(\"Titolo\")) input').fill("Particelle totali");
  await addW();
  await w(1).locator('label:has(> span:text-is(\"Tipo\")) select').selectOption("bar");
  await w(1).locator('label:has(> span:text-is(\"Layer\")) select').selectOption("iride:parcels");
  await w(1).locator('label:has(> span:text-is(\"Raggruppa per\")) select').selectOption("kind");
  await w(1).locator('label:has(> span:text-is(\"Titolo\")) input').fill("Per tipo");
  await w(1).locator('label:has(> span:text-is(\"Larghezza\")) select').selectOption("2");
  await addW();
  await w(2).locator('label:has(> span:text-is(\"Tipo\")) select').selectOption("hist");
  await w(2).locator('label:has(> span:text-is(\"Layer\")) select').selectOption("iride:parcels");
  await w(2).locator('label:has(> span:text-is(\"Campo numerico\")) select').selectOption("area");
  await w(2).locator('label:has(> span:text-is(\"Titolo\")) input').fill("Aree");
  await addW();
  await w(3).locator('label:has(> span:text-is(\"Tipo\")) select').selectOption("kpi");
  await w(3).locator('label:has(> span:text-is(\"Layer\")) select').selectOption("iride:parcels");
  await w(3).locator('label:has(> span:text-is(\"Valore\")) select').selectOption("sum");
  check("somma richiede il campo del valore (messaggio)", /campo del valore/.test(await page.locator(".problems").innerText()));
  await w(3).locator('label:has(> span:text-is(\"Campo del valore\")) select').selectOption("area");
  await w(3).locator('label:has(> span:text-is(\"Titolo\")) input').fill("Area totale");
  check("anteprima: KPI conteggio = 7", await waitFor(async () => (await page.locator(".dash-grid .widget").nth(0).locator(".k-value").innerText()) === "7"));
  check("anteprima: barre per tipo (3)", await waitFor(async () => (await page.locator(".dash-grid .widget").nth(1).locator(".bar-row").count()) === 3));
  check("anteprima: istogramma a 10 classi", await waitFor(async () => (await page.locator(".dash-grid .widget").nth(2).locator(".col").count()) === 10));
  check("anteprima: somma delle aree = 2.800", await waitFor(async () => /2\.800/.test(await page.locator(".dash-grid .widget").nth(3).locator(".k-value").innerText())));
  await page.screenshot({ path: shot("admin-dashboards.png"), fullPage: true });
  check("nessun problema residuo, salvataggio abilitato", await waitFor(async () => (await page.locator(".problems").count()) === 0 && !(await page.locator('button:text-is("Pubblica")').isDisabled())));
  await page.locator('button:text-is("Pubblica")').click();
  check("dashboard pubblicata", await waitFor(async () => /Dashboard pubblicata/.test(await page.locator(".page .ok").innerText())));
  s = await st();
  const dd = s["mapp:dashboards"].features;
  check("WFS-T: riga in dashboards con ruoli e 4 widget", dd.length === 1 && dd[0].properties.title === "Monitoraggio particelle" && JSON.parse(dd[0].properties.roles).join() === "fss-etl-viewer" && JSON.parse(dd[0].properties.definition).length === 4, JSON.stringify(dd[0]?.properties).slice(0, 300));
  check("la dashboard salvata compare nell'elenco", await waitFor(async () => (await page.locator(".dash-item").count()) === 1));
  await page.close();

  // ---------------------------------------------------------------- viewer con regole
  console.log("\n== viewer con regole ==");
  await asRole("fss-etl-viewer", "bob");
  page = await open();
  const vItems = await items(page);
  check("viewer con regola: solo Particelle e Sensori", vItems.length === 2 && vItems.some((t) => /Particelle/.test(t)) && vItems.some((t) => /Sensori/.test(t)), vItems.join());
  check("viewer: strumenti secondo la regola (misure sì dopo l'update; 3D e stampa no)", (await page.locator('button.tool[title="Misura distanza"]').count()) === 1 && (await page.locator('button.tool[title="Vista inclinata"]').count()) === 0 && (await page.locator('button.tool[title^="Stampa"]').count()) === 0);
  check("viewer: Feature Info consentito", (await page.locator('button.tool[title^="Interroga"]').count()) === 1);
  await page.locator('label.item:has-text("Particelle") input').check();
  await page.waitForSelector(".active-card");
  check("viewer: tabella sì, grafici sul layer no, modifica no", (await page.locator('.active-card [title="Tabella attributi"]').count()) === 1 && (await page.locator('.active-card [title="Dashboard"]').count()) === 0 && (await page.locator('.active-card [title="Modifica oggetti"]').count()) === 0);
  check("viewer con regola senza 'Scarica dati': nessun pulsante di scarico", (await page.locator('.active-card [title="Scarica dati"]').count()) === 0);
  await page.locator('.nav a:has-text("Dashboard")').click();
  check("viewer: elenco con la dashboard assegnata", await waitFor(async () => (await page.locator(".card-link").count()) === 1 && /Monitoraggio particelle/.test(await page.locator(".card-link").innerText())));
  await page.locator(".card-link").click();
  check("dashboard del viewer: 4 widget", await waitFor(async () => (await page.locator(".widget").count()) === 4));
  check("dashboard del viewer: KPI 7 e barre A/B/C", await waitFor(async () => (await page.locator(".widget").nth(0).locator(".k-value").innerText()) === "7" && (await page.locator(".widget").nth(1).locator(".bar-row").count()) === 3));
  await page.screenshot({ path: shot("dashboard-viewer.png"), fullPage: true });
  await page.locator(".widget").nth(1).locator(".bar-row").first().click();
  check("clic su una barra: apre la mappa con il filtro", await waitFor(async () => page.url().includes("/#s=") && (await page.locator(".active-card").count()) === 1 && (await page.locator('.active-card .filterbox input.search').first().inputValue()) === "kind = 'A'"));
  await page.close();
  page = await open("/admin/dashboards");
  check("viewer su /admin/dashboards: accesso negato", await waitFor(async () => /Accesso negato/.test(await page.locator(".page").innerText())));
  await page.close();
  await asRole("fss-etl-ops", "carol");
  page = await open();
  check("ruolo senza regola (altre regole presenti): nessun accesso", await waitFor(async () => /Accesso non configurato/.test(await page.locator(".page").innerText())));
  await page.close();

  // ---------------------------------------------------------------- eliminazioni e bootstrap
  console.log("\n== eliminazioni ==");
  await asRole("fss-etl-admin", "alice");
  page = await open("/admin/dashboards");
  await page.waitForSelector(".dash-item");
  await page.locator(".dash-item").click();
  await page.locator('button:has-text("Elimina")').click();
  check("dashboard eliminata (WFS-T Delete)", await waitFor(async () => (await st())["mapp:dashboards"].features.length === 0));
  await goAdmin(page, "Ruoli e permessi");
  await waitFor(async () => (await page.locator('.role-card[data-role="fss-etl-viewer"] button:has-text("Elimina regola")').count()) === 1);
  await page.locator('.role-card[data-role="fss-etl-viewer"] button:has-text("Elimina regola")').click();
  check("regola eliminata", await waitFor(async () => (await st())["mapp:role_rules"].features.length === 0));
  await page.close();
  await asRole("fss-etl-viewer", "bob");
  page = await open();
  check("senza regole il viewer torna a vedere tutto in sola lettura", (await items(page)).length === 4);
  await page.close();

  console.log("\n== tabelle non installate ==");
  await J("/__tables?off=1");
  await asRole("fss-etl-admin", "alice");
  page = await open("/admin/roles");
  check("admin: avviso 'tabelle di configurazione non trovate'", await waitFor(async () => /Tabelle di configurazione non trovate/.test(await page.locator(".page").innerText())));
  await page.close();
  await asRole("fss-etl-viewer", "bob");
  page = await open();
  check("viewer: la mappa funziona comunque (sola lettura)", (await items(page)).length === 4);
  await page.close();
  await J("/__tables?off=0");

  check("nessun errore JS/console durante i test", errors.length === 0, errors.slice(0, 5).join(" | "));
  await browser.close();
  finish();
})().catch(crash);
