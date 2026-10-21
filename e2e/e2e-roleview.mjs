// Vista iniziale per ruolo: area di interesse (numeri e mini-mappa), sfondo e layer accesi impostati dalla pagina
// Ruoli e permessi; cosa vede chi apre la mappa con uno o più ruoli, con o senza link; tabella mancante.
import { J, MOCK, crash, launchBrowser, prepare, results, shot, startNginx, waitFor } from "./lib.mjs";

const { check, finish } = results();

const rows = async (t) => (await J("/__state"))[`mapp:${t}`].features.map((f) => ({ fid: f.id, ...f.properties }));
const asRole = (roles, user = "bob") => J(`/__kc?user=${user}&roles=${encodeURIComponent(roles)}`);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const ROME = [12.45, 41.85, 12.55, 41.95];

(async () => {
  prepare();
  await J("/__reset");
  const R = startNginx("R", 8097, {
    AUTH_ENABLED: "true", KEYCLOAK_URL: `${MOCK}/kc`, KEYCLOAK_REALM: "test", KEYCLOAK_CLIENT_ID: "mapp",
    ACCESS_CONTROL: "true", KNOWN_ROLES: "fss-etl-viewer, fss-etl-ops", GEOSERVER_WRITE_PASSTHROUGH: "true",
    GEOSERVER_PROXY_URL: `${MOCK}/geoserver`, GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass",
    BASEMAP_TILES: `${MOCK}/tiles/{z}/{x}/{y}.png`, BASEMAPS: `osm|Mappa|${MOCK}/tiles/{z}/{x}/{y}.png|© test;grigio|Grigio|${MOCK}/tiles/{z}/{x}/{y}.png?g=1|© test;none|Nessuno|`,
    APP_TITLE: "Test vista per ruolo", MAP_CENTER_LON: "12.5", MAP_CENTER_LAT: "41.9", MAP_ZOOM: "7", MAP_BBOX: "6,36,19,47.5", GEOCODER: "off",
  });
  const browser = await launchBrowser();
  const errors = [];
  const open = async (urlPath = "/", wait = ".header") => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
    page.on("dialog", (d) => d.accept());
    await page.goto(R.url + urlPath);
    await page.waitForSelector(wait, { timeout: 15000, state: "attached" });
    return page;
  };
  const card = (page, role) => page.locator(`.role-card[data-role="${role}"]`);
  const bboxInput = (page, role, label) => card(page, role).locator(`input[aria-label="${label} (gradi)"]`);
  /** Stato della mappa dal link: { v: [lon, lat, zoom, ...], l: [...], b } (aspetta che il link sia scritto). */
  const state = async (page) => {
    await waitFor(async () => (await page.evaluate(() => location.hash)).startsWith("#s="));
    return JSON.parse(decodeURIComponent((await page.evaluate(() => location.hash)).slice(3)));
  };
  const activeTitles = (page) => page.locator(".active-card .name").allInnerTexts();
  const ready = (page) => page.waitForSelector("label.item input:not([disabled])", { state: "attached", timeout: 15000 });

  // ============================================================ admin: vista del visualizzatore con i numeri
  console.log("\n== admin: vista iniziale con i numeri ==");
  await asRole("fss-etl-admin", "alice");
  let page = await open("/admin/roles", ".role-card");
  const vcard = card(page, "fss-etl-viewer");
  check("ogni ruolo ha la sezione 'Vista iniziale'", (await vcard.locator(".role-view").count()) === 1 && (await card(page, "fss-etl-ops").locator(".role-view").count()) === 1);
  check("menu sfondi: predefinito più quelli configurati", JSON.stringify(await vcard.locator('select[aria-label="Sfondo iniziale"] option').allInnerTexts()) === JSON.stringify(["(predefinito)", "Mappa", "Grigio", "Nessuno"]));
  await vcard.locator('.check:has-text("Tutti i layer") input').check();
  await bboxInput(page, "fss-etl-viewer", "Ovest").fill("abc");
  check("area non valida: errore e salvataggio bloccato", (await vcard.locator(".error").innerText()).includes("Area non valida") && (await vcard.locator('button:has-text("Salva regola")').isDisabled()));
  for (const [i, l] of ["Ovest", "Sud", "Est", "Nord"].entries()) await bboxInput(page, "fss-etl-viewer", l).fill(String(ROME[i]).replace(".", ","));
  check("virgola decimale accettata (diventa punto)", (await bboxInput(page, "fss-etl-viewer", "Ovest").inputValue()) === "12.45" && (await vcard.locator(".error").count()) === 0);
  await vcard.locator('select[aria-label="Sfondo iniziale"]').selectOption("grigio");
  check("layer da accendere: tutti quelli che il ruolo vede", (await vcard.locator('.role-view .check-list .check').count()) === 4);
  await vcard.locator('.role-view .check:has-text("Particelle") input').check();
  await vcard.locator('.role-view .check:has-text("Sensori") input').check();
  const tx0 = (await J("/__txcount")).txCount;
  await vcard.locator('button:has-text("Salva regola")').click();
  check("salvataggio: conferma", await waitFor(async () => /Regola di fss-etl-viewer salvata/.test(await page.locator(".page .ok").innerText())));
  check("regola e vista nella stessa transazione WFS-T", (await J("/__txcount")).txCount === tx0 + 1);
  let rv = await rows("role_views");
  check("tabella role_views: area, sfondo e layer del ruolo", rv.length === 1 && rv[0].role === "fss-etl-viewer" && rv[0].bbox === "12.45,41.85,12.55,41.95" && rv[0].basemap === "grigio" &&
    JSON.stringify(JSON.parse(rv[0].layers).sort()) === JSON.stringify(["iride:parcels", "iride:sensors"]) && rv[0].updated_by === "alice", JSON.stringify(rv));
  check("tabella role_rules: la regola c'è", (await rows("role_rules")).some((r) => r.role === "fss-etl-viewer"));
  check("dopo il salvataggio i valori restano nel modulo", await waitFor(async () => (await bboxInput(page, "fss-etl-viewer", "Nord").inputValue()) === "41.95"));

  // ============================================================ admin: area dalla mini-mappa per un ruolo con pochi layer
  console.log("\n== admin: area dalla mini-mappa ==");
  const ocard = card(page, "fss-etl-ops");
  await ocard.locator('.role-grid .check:has-text("Strade") input').check();
  check("layer da accendere: solo quelli visibili al ruolo", await waitFor(async () => (await ocard.locator(".role-view .check-list .check").count()) === 1 && /Strade/.test(await ocard.locator(".role-view .check-list").innerText())));
  await ocard.locator('button:has-text("Scegli sulla mappa")').click();
  await ocard.locator(".bbox-map canvas").waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: shot("roleview-picker.png"), fullPage: true });
  await ocard.locator('button:has-text("Usa questa inquadratura")').click();
  const picked = await Promise.all(["Ovest", "Sud", "Est", "Nord"].map((l) => bboxInput(page, "fss-etl-ops", l).inputValue().then(Number)));
  check("mini-mappa: riquadro valido che contiene l'area globale di partenza (MAP_BBOX)", picked.every(Number.isFinite) && picked[0] < picked[2] && picked[1] < picked[3] && picked[0] <= 6.01 && picked[2] >= 18.99, picked.join());
  check("mini-mappa chiusa dopo la scelta", (await ocard.locator(".bbox-map").count()) === 0);
  // area più piccola, scritta a mano dopo la scelta: deve valere quella
  for (const [i, l] of ["Ovest", "Sud", "Est", "Nord"].entries()) await bboxInput(page, "fss-etl-ops", l).fill(String([12.6, 41.7, 12.8, 41.8][i]));
  await ocard.locator('button:has-text("Salva regola")').click();
  check("ruolo ops salvato con la sua area", await waitFor(async () => (await rows("role_views")).some((v) => v.role === "fss-etl-ops" && v.bbox === "12.6,41.7,12.8,41.8" && v.basemap === "" && v.layers === "[]")));
  await page.close();

  // ============================================================ chi apre la mappa
  console.log("\n== visualizzatore ==");
  await asRole("fss-etl-viewer", "bob");
  page = await open("/", "label.item");
  await ready(page);
  let s = await state(page);
  check("senza link: inquadratura sull'area del ruolo (Roma), non sulla vista globale", near(s.v[0], 12.5, 0.02) && near(s.v[1], 41.9, 0.02) && s.v[2] > 10, JSON.stringify(s.v));
  check("senza link: sfondo del ruolo", s.b === "grigio" && (await page.locator('.basemap-switch [aria-checked="true"]').innerText()) === "Grigio");
  check("senza link: layer del ruolo accesi, nell'ordine dell'elenco", await waitFor(async () => JSON.stringify(await activeTitles(page)) === JSON.stringify(["Particelle", "Sensori"])));
  await page.screenshot({ path: shot("roleview-viewer.png") });
  // il pulsante area di interesse porta all'area del ruolo, non a MAP_BBOX
  await page.evaluate(() => document.querySelector(".maplibregl-ctrl-zoom-out").click());
  await page.evaluate(() => document.querySelector(".maplibregl-ctrl-zoom-out").click());
  await page.waitForTimeout(600);
  await page.locator(".aoi-ctrl").click();
  check("pulsante 'area di interesse': torna all'area del ruolo", await waitFor(async () => { const x = await state(page); return near(x.v[0], 12.5, 0.02) && x.v[2] > 10; }, 6000));
  await page.close();

  const link = "#s=" + encodeURIComponent(JSON.stringify({ v: [9.19, 45.46, 8, 0, 0], l: [["demo:roads", 1, "", "", ""]], b: "osm" }));
  page = await open("/" + link, "label.item");
  await ready(page);
  s = await state(page);
  check("con un link vale il link: inquadratura, sfondo e layer", near(s.v[0], 9.19, 0.01) && s.b === "osm" && JSON.stringify(await activeTitles(page)) === JSON.stringify(["Strade"]), JSON.stringify(s));
  await page.close();

  console.log("\n== più ruoli ==");
  await asRole("fss-etl-viewer,fss-etl-ops", "carla");
  page = await open("/", "label.item");
  await ready(page);
  s = await state(page);
  check("due ruoli: area che contiene entrambe (12.45-12.8, 41.7-41.95)", near(s.v[0], 12.625, 0.03) && near(s.v[1], 41.825, 0.03), JSON.stringify(s.v));
  check("due ruoli: sfondo del ruolo che lo indica, layer uniti", s.b === "grigio" && JSON.stringify(await activeTitles(page)) === JSON.stringify(["Particelle", "Sensori"]));
  await page.close();

  console.log("\n== admin nella mappa ==");
  await asRole("fss-etl-admin", "alice");
  page = await open("/", "label.item");
  await ready(page);
  s = await state(page);
  check("admin: vista globale (centro e zoom di configurazione, primo sfondo, niente layer)", near(s.v[0], 12.5, 0.01) && near(s.v[2], 7, 0.05) && s.b === "osm" && (await page.locator(".active-card").count()) === 0, JSON.stringify(s));
  await page.close();

  // ============================================================ svuotare ed eliminare
  console.log("\n== svuotare ed eliminare ==");
  page = await open("/admin/roles", ".role-card");
  const vc = card(page, "fss-etl-viewer");
  await vc.locator('button:has-text("Togli l\'area")').click();
  await vc.locator('select[aria-label="Sfondo iniziale"]').selectOption("");
  await vc.locator('.role-view .check:has-text("Particelle") input').uncheck();
  await vc.locator('.role-view .check:has-text("Sensori") input').uncheck();
  check("nessun layer scelto: avviso che valgono quelli del catalogo", /si accendono quelli indicati nel catalogo/.test(await vc.locator(".role-view").innerText()));
  await vc.locator('button:has-text("Salva regola")').click();
  check("vista vuota: la riga di role_views viene eliminata, la regola resta", await waitFor(async () => !(await rows("role_views")).some((v) => v.role === "fss-etl-viewer") && (await rows("role_rules")).some((r) => r.role === "fss-etl-viewer")));
  await card(page, "fss-etl-ops").locator('button:has-text("Elimina regola")').click();
  check("elimina regola: spariscono regola e vista del ruolo", await waitFor(async () => !(await rows("role_views")).some((v) => v.role === "fss-etl-ops") && !(await rows("role_rules")).some((r) => r.role === "fss-etl-ops")));
  await page.close();

  // ============================================================ tabella delle viste mancante
  console.log("\n== tabella role_views non installata ==");
  await J("/__tables?off=1&only=mapp:role_views");
  page = await open("/admin/roles", ".role-card");
  check("admin: avviso sulla tabella mancante e campi della vista disattivati", await waitFor(async () => /Tabella delle viste iniziali non trovata/.test(await page.locator(".page").innerText())) &&
    (await bboxInput(page, "fss-etl-viewer", "Ovest").isDisabled()));
  await card(page, "fss-etl-viewer").locator('.role-grid .check:has-text("Misure e coordinate") input').uncheck();
  await card(page, "fss-etl-viewer").locator('button:has-text("Salva regola")').click();
  check("admin: la regola si salva lo stesso", await waitFor(async () => /salvata/.test(await page.locator(".page .ok").innerText())));
  await page.close();
  await asRole("fss-etl-viewer", "bob");
  page = await open("/", "label.item");
  await ready(page);
  s = await state(page);
  check("visualizzatore: la mappa si apre con la vista globale", near(s.v[0], 12.5, 0.01) && near(s.v[2], 7, 0.05) && s.b === "osm");
  await page.close();
  await J("/__tables?off=0");

  check("nessun errore JS/console durante i test", errors.length === 0, errors.slice(0, 5).join(" | "));
  await browser.close();
  finish();
})().catch(crash);
