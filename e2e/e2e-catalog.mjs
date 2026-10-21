// Catalogo prodotti da interfaccia: cartelle (anche annidate), ordine, titoli e descrizioni, layer nascosti e accesi
// di default; salvataggio in un'unica transazione WFS-T, conflitti, errori, tabelle mancanti; cosa vede il visualizzatore.
import { execSync } from "node:child_process";
import { J, MOCK, crash, launchBrowser, prepare, results, shot, startNginx, waitFor } from "./lib.mjs";

const { check, finish } = results();

const st = () => J("/__state");
const rows = async (t) => (await st())[`mapp:${t}`].features.map((f) => ({ fid: f.id, ...f.properties }));
const asRole = (roles, user = "bob") => J(`/__kc?user=${user}&roles=${encodeURIComponent(roles)}`);
const seed = (layer, list) => fetch(`${MOCK}/__seed?layer=${encodeURIComponent(layer)}`, { method: "POST", body: JSON.stringify(list) }).then((r) => r.json());
const WRITE = "Basic " + Buffer.from("writer:wpass").toString("base64");
const wfsT = (body) => fetch(`${MOCK}/geoserver/wfs`, { method: "POST", headers: { Authorization: WRITE, "Content-Type": "text/xml" }, body: `<wfs:Transaction xmlns:wfs="http://www.opengis.net/wfs" xmlns:ogc="http://www.opengis.net/ogc" xmlns:mapp="http://iride.example/mapp" service="WFS" version="1.0.0">${body}</wfs:Transaction>` }).then((r) => r.text());

(async () => {
  prepare();
  await J("/__reset");
  const K = startNginx("K", 8098, {
    AUTH_ENABLED: "true", KEYCLOAK_URL: `${MOCK}/kc`, KEYCLOAK_REALM: "test", KEYCLOAK_CLIENT_ID: "mapp",
    ACCESS_CONTROL: "true", GEOSERVER_WRITE_PASSTHROUGH: "true",
    GEOSERVER_PROXY_URL: `${MOCK}/geoserver`, GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass",
    BASEMAP_TILES: `${MOCK}/tiles/{z}/{x}/{y}.png`, APP_TITLE: "Test catalogo", MAP_CENTER_LON: "12.5", MAP_CENTER_LAT: "41.9", MAP_ZOOM: "9", GEOCODER: "off",
  });
  const browser = await launchBrowser();
  const errors = [];
  const open = async (urlPath = "/", { scheme = "light", wait = ".header" } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: scheme });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
    page.on("dialog", (d) => d.accept());
    await page.goto(K.url + urlPath);
    await page.waitForSelector(wait, { timeout: 15000, state: "attached" });
    return page;
  };
  const row = (page, ref) => page.locator(`.cat-row[data-ref="${ref}"]`);
  const treeText = (page) => page.locator(".cat-tree .cat-row .cat-title").allInnerTexts();
  const detail = (page) => page.locator(".cat-detail .cat-form").first();
  const field = (page, label) => detail(page).locator(`label:has(> span:text-is("${label}"))`).locator("input, textarea, select").first();
  const saveBtn = (page) => page.locator('button:has-text("Salva catalogo")');
  /** Voci dell'elenco prodotti nell'ordine della pagina: "F:titolo" per le cartelle, "L:titolo" per i layer. */
  const sidebar = (page) => page.evaluate(() => Array.from(document.querySelectorAll(".sidebar .scroll details.group > summary, .sidebar .scroll label.item"))
    .map((e) => (e.tagName === "SUMMARY" ? "F:" : "L:") + (e.tagName === "SUMMARY" ? e.childNodes[0].textContent : e.querySelector(".grow").textContent).trim()));
  const activeTitles = (page) => page.locator(".active-card .name").allInnerTexts();

  // ============================================================ admin: primo catalogo
  console.log("\n== admin: primo catalogo ==");
  await asRole("fss-etl-admin", "alice");
  let page = await open("/admin/catalog", { wait: ".cat-tree" });
  check("menu Admin: voce 'Catalogo prodotti' attiva", (await page.locator("button.nav-tag.on").innerText()).includes("Catalogo prodotti"));
  check("catalogo mai salvato: avviso e punto di partenza per workspace", /non è ancora stato salvato/.test(await page.locator(".notice").first().innerText()));
  const first = await treeText(page);
  check("albero iniziale: cartelle demo, iride, Altri prodotti e i 4 layer (niente tabelle di configurazione)",
    (await page.locator(".cat-row.folder").count()) === 3 && (await page.locator(".cat-row.layer").count()) === 4 && !first.some((t) => /role_rules|catalog_|dashboards|saved_views/.test(t)), first.join(" | "));
  check("primo catalogo: salvataggio già possibile (modifiche da salvare)", !(await saveBtn(page).isDisabled()) && /modifiche non salvate/.test(await page.locator(".cat-changes").innerText()));

  // nuova cartella, rinominata e descritta
  await page.locator('.cat-toolbar button:has-text("Nuova cartella")').click();
  await page.waitForSelector('.cat-form[data-edit^="f:f-nuova-cartella"]');
  await field(page, "Titolo").fill("Agricoltura");
  await field(page, "Descrizione").fill("Prodotti per l'agricoltura");
  check("nuova cartella: compare nell'albero con il nuovo titolo", await waitFor(async () => (await row(page, "f:f-nuova-cartella").innerText()).includes("Agricoltura")));
  await detail(page).locator('label.check:has-text("Aperta all\'avvio") input').check();
  // portata in cima con "Su" (è l'ultima del primo livello)
  for (let i = 0; i < 3; i++) await detail(page).locator('button:text-is("Su")').click();
  check("Su: Agricoltura in cima al primo livello", await waitFor(async () => (await page.locator(".cat-row").first().getAttribute("data-ref")) === "f:f-nuova-cartella"));
  check("in cima: 'Su' disabilitato", await detail(page).locator('button:text-is("Su")').isDisabled());

  // NDVI nella cartella dal menu "Cartella", acceso di default
  await row(page, "l:iride:ndvi").click();
  await field(page, "Cartella").selectOption("f-nuova-cartella");
  await detail(page).locator('label.check:has-text("Acceso di default") input').check();
  // Particelle trascinata sulla cartella
  await row(page, "l:iride:parcels").dragTo(row(page, "f:f-nuova-cartella"));
  check("trascina su una cartella: il layer finisce dentro", await waitFor(async () => (await row(page, "l:iride:parcels").getAttribute("style"))?.includes("padding-left: 28px")));
  await row(page, "l:iride:parcels").click();
  await field(page, "Titolo").fill("Particelle catastali");
  await field(page, "Descrizione").fill("Descrizione scritta nel catalogo");
  await detail(page).locator('button:text-is("Su")').click();
  await detail(page).locator('label.check:has-text("Acceso di default") input').check();
  check("titolo personalizzato: segnalato nell'albero", await waitFor(async () => (await row(page, "l:iride:parcels").locator(".tag:text-is('titolo')").count()) === 1));
  // nascosto ed acceso si escludono
  await detail(page).locator('label.check:has-text("Nascosto") input').check();
  check("nascosto spegne 'acceso di default'", !(await detail(page).locator('label.check:has-text("Acceso di default") input').isChecked()));
  await detail(page).locator('label.check:has-text("Acceso di default") input').check();
  check("acceso spegne 'nascosto'", !(await detail(page).locator('label.check:has-text("Nascosto") input').isChecked()));

  // sottocartella con le strade, sensori nascosti, cartella demo eliminata
  await row(page, "f:f-nuova-cartella").click();
  await detail(page).locator('button:has-text("Nuova sottocartella")').click();
  await page.waitForSelector('.cat-form[data-edit^="f:f-nuova-cartella-2"]');
  await field(page, "Titolo").fill("Approfondimenti");
  await row(page, "l:demo:roads").click();
  const targets = await field(page, "Cartella").locator("option").allInnerTexts();
  check("menu Cartella: percorsi completi", targets.includes("Agricoltura / Approfondimenti") && targets.includes("(primo livello)"), targets.join(" | "));
  await field(page, "Cartella").selectOption("f-nuova-cartella-2");
  await row(page, "f:f-nuova-cartella").click();
  const parents = await field(page, "Contenuta in").locator("option").evaluateAll((os) => os.map((o) => o.value));
  check("una cartella non si sposta dentro una sua sottocartella né in 'Altri prodotti'", !parents.includes("f-nuova-cartella-2") && !parents.includes("@altri") && !parents.includes("f-nuova-cartella"), parents.join());
  await row(page, "l:iride:sensors").click();
  await detail(page).locator('label.check:has-text("Nascosto") input').check();
  check("layer nascosto: etichetta nell'albero", (await row(page, "l:iride:sensors").locator(".tag.off").count()) === 1);
  await row(page, "f:ws-demo").click();
  await detail(page).locator('button:has-text("Elimina cartella")').click();
  check("cartella eliminata", (await row(page, "f:ws-demo").count()) === 0);
  check("filtro dell'albero: 'strade' mostra la strada con le sue cartelle", await (async () => {
    await page.fill('input[aria-label="Filtra il catalogo"]', "strade");
    const t = await treeText(page);
    await page.fill('input[aria-label="Filtra il catalogo"]', "");
    return t.length === 3 && /Agricoltura/.test(t[0]) && /Approfondimenti/.test(t[1]) && /Strade/.test(t[2]);
  })());
  await page.screenshot({ path: shot("catalog-admin.png"), fullPage: true });

  const tx0 = (await J("/__txcount")).txCount;
  await saveBtn(page).click();
  check("salvataggio: messaggio di conferma", await waitFor(async () => /Catalogo salvato/.test(await page.locator(".page .ok").innerText())));
  check("salvataggio in un'unica transazione WFS-T", (await J("/__txcount")).txCount === tx0 + 1);
  check("dopo il salvataggio nessuna modifica in sospeso", await waitFor(async () => (await saveBtn(page).isDisabled()) && (await page.locator(".cat-changes").count()) === 0));
  const F = await rows("catalog_folders");
  const L = await rows("catalog_layers");
  const fk = (k) => F.find((f) => f.folder_key === k);
  const lk = (n) => L.find((l) => l.layer === n);
  check("tabella catalog_folders: Agricoltura (aperta, in cima), Approfondimenti dentro, iride, Altri prodotti",
    F.length === 4 && fk("f-nuova-cartella")?.title === "Agricoltura" && fk("f-nuova-cartella").position === 0 && fk("f-nuova-cartella").expanded === true &&
    fk("f-nuova-cartella-2")?.parent_key === "f-nuova-cartella" && !!fk("ws-iride") && !!fk("@altri") && !fk("ws-demo"), JSON.stringify(F));
  check("tabella catalog_layers: una riga per layer pubblicato, con cartella, ordine, titolo, descrizione e flag",
    L.length === 4 && lk("iride:parcels")?.folder_key === "f-nuova-cartella" && lk("iride:parcels").position === 0 && lk("iride:parcels").title === "Particelle catastali" &&
    lk("iride:parcels").description === "Descrizione scritta nel catalogo" && lk("iride:parcels").default_on === true && lk("iride:ndvi").default_on === true &&
    lk("iride:ndvi").position === 1 && lk("iride:sensors").hidden === true && lk("demo:roads").folder_key === "f-nuova-cartella-2" && lk("iride:parcels").updated_by === "alice", JSON.stringify(L));
  await page.close();

  // ============================================================ visualizzatore
  console.log("\n== visualizzatore ==");
  await asRole("fss-etl-viewer", "bob");
  page = await open("/", { wait: "label.item input:not([disabled])" });
  const side = await sidebar(page);
  check("elenco a cartelle nell'ordine del catalogo, titoli personalizzati, niente nascosti né cartelle vuote",
    JSON.stringify(side) === JSON.stringify(["F:Agricoltura", "L:Particelle catastali", "L:NDVI", "F:Approfondimenti", "L:Strade"]), side.join(" | "));
  check("cartella 'aperta all'avvio' aperta, sottocartella chiusa", await page.evaluate(() => document.querySelector('details[data-folder="f-nuova-cartella"]').open && !document.querySelector('details[data-folder="f-nuova-cartella-2"]').open));
  check("descrizione della cartella sotto il titolo", (await page.locator('details[data-folder="f-nuova-cartella"] > .group-desc').innerText()) === "Prodotti per l'agricoltura");
  check("accesi di default: Particelle in cima, poi NDVI", await waitFor(async () => JSON.stringify(await activeTitles(page)) === JSON.stringify(["Particelle catastali", "NDVI"])));
  check("accesi di default: GetMap per entrambi", await waitFor(async () => { const l = await J("/__log"); return l.some((x) => /layers=iride%3Aparcels/.test(x.query) && /GetMap/i.test(x.query)) && l.some((x) => /layers=iride%3Andvi/.test(x.query) && /GetMap/i.test(x.query)); }));
  check("il link della pagina contiene i layer accesi", await waitFor(async () => decodeURIComponent(await page.evaluate(() => location.hash)).includes("iride:parcels")));
  await page.locator('label.item:has-text("Particelle catastali") .item-info').click();
  check("scheda del layer: titolo e descrizione del catalogo", await waitFor(async () => { const t = await page.locator(".float-panel").last().innerText(); return /Particelle catastali/.test(t) && /Descrizione scritta nel catalogo/.test(t); }));
  await page.fill(".panel-head .search", "strade");
  check("ricerca nell'elenco: la cartella che contiene il risultato si apre", await waitFor(async () => JSON.stringify(await sidebar(page)) === JSON.stringify(["F:Agricoltura", "F:Approfondimenti", "L:Strade"]) && await page.evaluate(() => document.querySelector('details[data-folder="f-nuova-cartella-2"]').open)));
  await page.fill(".panel-head .search", "");
  await page.screenshot({ path: shot("catalog-viewer.png") });
  await page.close();

  page = await open("/#s=" + encodeURIComponent(JSON.stringify({ v: [12.5, 41.9, 9, 0, 0], l: [["demo:roads", 1, "", "", ""]] })), { wait: "label.item input:not([disabled])" });
  check("con un link i layer di default non si accendono: resta quello del link", await waitFor(async () => JSON.stringify(await activeTitles(page)) === JSON.stringify(["Strade"])));
  await page.close();
  page = await open("/#s=" + encodeURIComponent(JSON.stringify({ v: [12.5, 41.9, 9, 0, 0], l: [["iride:sensors", 1, "", "", ""]] })), { wait: "label.item input:not([disabled])" });
  check("un layer nascosto non si apre nemmeno da link (per il visualizzatore)", await waitFor(async () => (await page.locator("label.item").count()) === 3) && (await page.locator(".active-card").count()) === 0);
  await page.close();
  page = await open("/admin/catalog");
  check("visualizzatore su /admin/catalog: accesso negato", await waitFor(async () => /Accesso negato/.test(await page.locator(".page").innerText())));
  await page.close();

  // ============================================================ admin nella mappa: vede i nascosti, marcati
  console.log("\n== admin nella mappa ==");
  await asRole("fss-etl-admin", "alice");
  page = await open("/", { wait: "label.item input:not([disabled])" });
  check("admin: vede il layer nascosto con l'etichetta 'nascosto'", await waitFor(async () => (await page.locator('label.item.is-hidden:has-text("Sensori") .tag:text-is("nascosto")').count()) === 1));
  check("admin: i nascosti non si accendono di default", JSON.stringify(await activeTitles(page)) === JSON.stringify(["Particelle catastali", "NDVI"]));
  await page.close();

  // ============================================================ layer nuovi e non più pubblicati
  console.log("\n== layer nuovi e non più pubblicati ==");
  // la riga delle strade sparisce (come un layer pubblicato dopo l'ultimo salvataggio); compare una riga di un layer che non esiste più
  const roads = (await rows("catalog_layers")).find((l) => l.layer === "demo:roads");
  await wfsT(`<wfs:Delete typeName="mapp:catalog_layers"><ogc:Filter><ogc:FeatureId fid="${roads.fid}"/></ogc:Filter></wfs:Delete>`);
  await seed("mapp:catalog_layers", [{ layer: "iride:dismesso", folder_key: "f-nuova-cartella", position: 9, title: "Vecchio", description: "", hidden: "false", default_on: "false" }]);
  await asRole("fss-etl-viewer", "bob");
  page = await open("/", { wait: "label.item input:not([disabled])" });
  const side2 = await sidebar(page);
  check("visualizzatore: layer non catalogato in 'Altri prodotti' in fondo; il layer non più pubblicato non compare",
    side2.at(-2) === "F:Altri prodotti" && side2.at(-1) === "L:Strade" && !side2.some((t) => /Vecchio/.test(t)), side2.join(" | "));
  await page.close();
  await asRole("fss-etl-admin", "alice");
  page = await open("/admin/catalog", { wait: ".cat-tree" });
  check("admin: avviso dei layer pubblicati dopo l'ultimo salvataggio", await waitFor(async () => /1 layer pubblicato dopo l'ultimo salvataggio/.test(await page.locator(".page").innerText())));
  check("admin: il layer nuovo ha l'etichetta 'nuovo' ed è in 'Altri prodotti'", (await row(page, "l:demo:roads").locator(".tag.new").count()) === 1);
  check("admin: elenco dei layer non più pubblicati", /iride:dismesso/.test(await page.locator(".cat-stale").innerText()));
  await page.locator('.cat-stale button:has-text("Rimuovi dal catalogo")').click();
  await saveBtn(page).click();
  check("salvataggio: riga del layer nuovo inserita, riga del layer dismesso eliminata", await waitFor(async () => { const l = await rows("catalog_layers"); return l.length === 4 && l.some((x) => x.layer === "demo:roads" && x.folder_key === "@altri") && !l.some((x) => x.layer === "iride:dismesso"); }));

  // ============================================================ conflitti ed errori
  console.log("\n== conflitti ed errori ==");
  await page.waitForSelector(".page .ok");
  await row(page, "l:iride:ndvi").click();
  await field(page, "Titolo").fill("NDVI (indice di vegetazione)");
  // un altro amministratore salva nel frattempo
  await seed("mapp:catalog_folders", [{ folder_key: "f-altro-admin", parent_key: "", title: "Dell'altro admin", description: "", position: 9, expanded: "false", hidden: "false" }]);
  const before = JSON.stringify(await rows("catalog_layers"));
  await saveBtn(page).click();
  check("conflitto: il salvataggio si ferma e lo dice", await waitFor(async () => /modificato da un altro amministratore/.test(await page.locator(".page .error").innerText())));
  check("conflitto: nessuna scrittura", JSON.stringify(await rows("catalog_layers")) === before);
  await page.locator('button:has-text("Ricarica il catalogo")').click();
  check("ricarica: compare la cartella dell'altro admin e le modifiche locali sono scartate", await waitFor(async () => (await row(page, "f:f-altro-admin").count()) === 1 && (await saveBtn(page).isDisabled())));
  // errore di GeoServer a metà transazione: niente di parziale
  await row(page, "l:iride:ndvi").click();
  await field(page, "Titolo").fill("NDVI (indice di vegetazione)");
  await row(page, "f:f-altro-admin").click();
  await detail(page).locator('button:has-text("Elimina cartella")').click();
  const beforeF = JSON.stringify(await rows("catalog_folders"));
  const beforeL = JSON.stringify(await rows("catalog_layers"));
  await J("/__failtx?msg=" + encodeURIComponent("errore simulato del database"));
  await saveBtn(page).click();
  check("errore di GeoServer: messaggio leggibile", await waitFor(async () => /errore simulato del database/.test(await page.locator(".page .error").innerText())));
  check("errore di GeoServer: transazione annullata per intero (cartelle e layer intatti)", JSON.stringify(await rows("catalog_folders")) === beforeF && JSON.stringify(await rows("catalog_layers")) === beforeL);
  check("dopo l'errore le modifiche restano nell'editor", !(await saveBtn(page).isDisabled()));
  await saveBtn(page).click();
  check("riprova: salvato (titolo cambiato, cartella eliminata)", await waitFor(async () => (await rows("catalog_layers")).find((l) => l.layer === "iride:ndvi")?.title === "NDVI (indice di vegetazione)" && !(await rows("catalog_folders")).some((f) => f.folder_key === "f-altro-admin")));
  await page.close();
  page = await open("/admin/catalog", { scheme: "dark", wait: ".cat-tree" });
  await row(page, "l:iride:parcels").click();
  await page.screenshot({ path: shot("catalog-admin-dark.png"), fullPage: true });
  await page.close();

  // la scrittura resta riservata all'admin anche fuori dall'interfaccia
  const jwtFor = (roles) => { const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); return `${b({ alg: "none" })}.${b({ preferred_username: "x", resource_access: { mapp: { roles } } })}.sig`; };
  const code = execSync(`curl -s -o /dev/null -w '%{http_code}' -X POST '${K.url}/geoserver/wfs' -H 'Authorization: Bearer ${jwtFor(["fss-etl-viewer"])}' -H 'Content-Type: text/xml' -d '<wfs:Transaction xmlns:wfs="http://www.opengis.net/wfs" service="WFS" version="1.0.0"/>'`, { encoding: "utf8" });
  check("visualizzatore: scrittura diretta sulle tabelle negata (403)", code === "403");

  // ============================================================ tabelle del catalogo non installate
  console.log("\n== tabelle non installate ==");
  await J("/__tables?off=1");
  page = await open("/admin/catalog", { wait: ".cat-tree" });
  check("admin: avviso 'tabelle del catalogo non trovate' e salvataggio disabilitato", await waitFor(async () => /Tabelle del catalogo non trovate/.test(await page.locator(".page").innerText())) && (await saveBtn(page).isDisabled()));
  await page.close();
  await asRole("fss-etl-viewer", "bob");
  page = await open("/", { wait: "label.item input:not([disabled])" });
  check("visualizzatore: senza tabelle la mappa funziona con l'elenco per workspace", (await sidebar(page)).filter((t) => t.startsWith("F:")).join() === "F:demo,F:iride" && (await page.locator(".active-card").count()) === 0);
  await page.close();
  await J("/__tables?off=0");

  check("nessun errore JS/console durante i test", errors.length === 0, errors.slice(0, 5).join(" | "));
  await browser.close();
  finish();
})().catch(crash);
