// Ricerca (luoghi + attributi), sfondi, scheda del layer e viste salvate: browser reale, nginx reale, GeoServer/geocoder/Keycloak finti.
import { execSync } from "node:child_process";
import fs from "node:fs";
import { J, MOCK, crash, launchBrowser, prepare, results as collect, shot, sleep, startNginx, waitFor } from "./lib.mjs";

const { check, finish } = collect();
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const base = {
  GEOSERVER_PROXY_URL: `${MOCK}/geoserver`, GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass",
  BASEMAP_TILES: `${MOCK}/tiles/{z}/{x}/{y}.png`, APP_TITLE: "Test ricerca", MAP_CENTER_LON: "12.5", MAP_CENTER_LAT: "41.9", MAP_ZOOM: "9",
};
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

(async () => {
  prepare();
  await J("/__reset");
  const D = startNginx("D", 8094, { ...base, AUTH_ENABLED: "false", GEOCODER: "nominatim", GEOCODER_URL: `${MOCK}/nominatim`, GEOCODER_COUNTRY: "IT", GEOCODER_USER_AGENT: "mapp-web-test" });
  const E = startNginx("E", 8095, { ...base, AUTH_ENABLED: "false", GEOCODER: "off", BASEMAPS: `osm|Mappa|${MOCK}/tiles/{z}/{x}/{y}.png|© test;nessuno|Vuoto|;rotto|Rotto|ftp://x` });
  const C = startNginx("C", 8096, {
    ...base, AUTH_ENABLED: "true", KEYCLOAK_URL: `${MOCK}/kc`, KEYCLOAK_REALM: "test", KEYCLOAK_CLIENT_ID: "mapp",
    ACCESS_CONTROL: "true", EDIT_ENABLED: "true", GEOSERVER_WRITE_PASSTHROUGH: "true", CONFIG_WORKSPACE: "mapp",
    GEOCODER: "photon", GEOCODER_URL: `${MOCK}/photon`,
  });
  const browser = await launchBrowser();
  const errors = [];
  const reqs = [];
  const open = async (url, { ctx, wait = ".sidebar", cookies } = {}) => {
    ctx ??= await browser.newContext({ viewport: { width: 1400, height: 900 } });
    if (cookies) await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
    page.on("request", (r) => reqs.push(r.url()));
    page.on("dialog", (d) => d.accept());
    await page.route("**/server.arcgisonline.com/**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
    await page.route("**/basemaps.cartocdn.com/**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
    await page.goto(url);
    await page.waitForSelector(wait, { timeout: 15000 });
    return page;
  };
  const openGroups = (page) => page.evaluate(() => document.querySelectorAll("details.group").forEach((d) => (d.open = true)));
  const hash = async (page) => JSON.parse(decodeURIComponent((await page.evaluate(() => window.location.hash)).slice(3)));
  const ready = (page) => page.waitForSelector("label.item input:not([disabled])", { state: "attached", timeout: 15000 });
  const search = async (page, term, enter = true) => { await page.fill(".hsearch input", term); if (enter) await page.press(".hsearch input", "Enter"); };

  // ============================================================ proxy /geocode e config
  console.log("\n== geocoder: config e proxy ==");
  const cfgD = await (await fetch(D.url + "/config.json")).json();
  check("config.json: geocoder nominatim su /geocode con paese e lingua, senza l'URL dell'upstream", cfgD.geocoder?.type === "nominatim" && cfgD.geocoder.url === "/geocode" && cfgD.geocoder.country === "it" && cfgD.geocoder.lang === "it" && !JSON.stringify(cfgD).includes("8600/nominatim"), JSON.stringify(cfgD.geocoder));
  check("GEOCODER=off: nessun blocco geocoder e /geocode/ non instradato", !(await (await fetch(E.url + "/config.json")).json()).geocoder && (await fetch(E.url + "/geocode/search?q=bari")).headers.get("content-type")?.includes("text/html"));
  const code = (args) => execSync(`curl -s -o /dev/null -w '%{http_code}' ${args}`, { encoding: "utf8" });
  check("POST /geocode/ vietato (403)", code(`-X POST '${D.url}/geocode/search?q=bari' -d x`) === "403");
  await fetch(MOCK + "/__reset");
  const r1 = await fetch(`${D.url}/geocode/search?q=bari+uno&format=jsonv2`, { headers: { Authorization: "Bearer SEGRETO", Cookie: "sessione=abc" } });
  const geo1 = await J("/__geo");
  check("proxy: risposta del geocoder inoltrata", r1.ok && (await r1.json())[0]?.name === "Bari");
  check("proxy: Authorization e cookie dell'utente NON arrivano al geocoder; User-Agent configurato", geo1.at(-1)?.auth === null && geo1.at(-1)?.cookie === null && geo1.at(-1)?.ua === "mapp-web-test", JSON.stringify(geo1.at(-1)));
  const n0 = (await J("/__geo")).length;
  await fetch(`${D.url}/geocode/search?q=bari+uno&format=jsonv2`);
  check("proxy: la stessa ricerca è servita dalla cache (il geocoder non viene richiamato)", (await J("/__geo")).length === n0);
  const codes = []; for (let i = 0; i < 12; i++) codes.push(code(`'${D.url}/geocode/search?q=unico${i}'`));
  check("proxy: oltre il limite per client risponde 429", codes.includes("429") && codes[0] === "200", codes.join(","));
  await sleep(1500);

  // ============================================================ ricerca nel browser (Nominatim: con Invio)
  console.log("\n== ricerca luoghi e attributi ==");
  await J("/__reset");
  const ctxD = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  let page = await open(D.url + "/", { ctx: ctxD, cookies: [{ name: "sessione", value: "abc", url: D.url }] });
  check("casella di ricerca nell'header", (await page.locator(".hsearch input").count()) === 1 && /luogo/.test(await page.locator(".hsearch input").getAttribute("placeholder")));
  const g0 = (await J("/__geo")).length;
  await page.fill(".hsearch input", "bari");
  await sleep(900);
  check("Nominatim: nessuna richiesta mentre si scrive", (await J("/__geo")).length === g0);
  await page.press(".hsearch input", "Enter");
  check("Invio: due luoghi trovati con dettaglio", await waitFor(async () => (await page.locator(".sr-item").count()) === 2 && /Puglia/.test(await page.locator(".sr-item").first().innerText())));
  const gq = (await J("/__geo")).at(-1);
  check("richiesta al geocoder: paese e lingua, via proxy, senza token", /countrycodes=it/.test(gq.query) && /accept-language=it/.test(gq.query) && gq.auth === null && gq.cookie === null, JSON.stringify(gq));
  await page.screenshot({ path: shot("search-places.png") });
  await page.locator(".sr-item").first().click();
  check("clic sul luogo: la mappa si sposta su Bari e l'elenco si chiude", await waitFor(async () => { const v = (await hash(page)).v; return near(v[0], 16.85, 0.3) && near(v[1], 41.1, 0.3); }) && (await page.locator(".search-results").count()) === 0);
  await page.fill(".hsearch input", ""); 
  // attributi
  await page.goto(D.url + "/" ); await page.waitForSelector(".sidebar");
  await ready(page); await openGroups(page); await page.locator('label.item:has-text("Particelle") input').check();
  await page.locator(".active-card").waitFor();
  await search(page, "Particella 3");
  check("ricerca per attributo: trova la particella nel layer attivo", await waitFor(async () => (await page.locator(".sr-item").filter({ hasText: "Particella 3" }).count()) === 1));
  check("CQL inviato: ILIKE su attributi di testo, nome per primo", (await J("/__log")).some((l) => /request=GetFeature/i.test(l.query) && /typeName=iride%3Aparcels/.test(l.query) && /cql_filter=name%20ILIKE%20(%27|')%25Particella%203%25(%27|')%20OR%20kind%20ILIKE/.test(l.query)), JSON.stringify((await J("/__log")).filter((l) => /cql_filter/.test(l.query)).slice(-1)));
  check("ricerca senza maiuscole (particella 3)", await (async () => { await search(page, "pARTICELLA 3"); return waitFor(async () => (await page.locator(".sr-item").count()) === 1); })());
  await page.locator(".sr-item").first().click();
  check("clic sul risultato: zoom sulla particella 3", await waitFor(async () => { const v = (await hash(page)).v; return near(v[0], 12.52, 0.02) && near(v[1], 41.8675, 0.02) && v[2] > 11; }));
  await search(page, "O'Brien' OR 1=1 --");
  check("apice nel termine: nessun errore, nessun risultato", await waitFor(async () => /Nessun risultato/.test(await page.locator(".search-results").innerText())) && !(await page.locator(".sr-err").count()));
  check("l'apice è raddoppiato nel CQL", (await J("/__log")).some((l) => /cql_filter=name%20ILIKE%20(%27|')%25O(%27%27|'')Brien(%27%27|'')%20OR%201%3D1%20--%25(%27|')%20OR%20kind/.test(l.query)), JSON.stringify((await J("/__log")).filter((l) => /cql_filter/.test(l.query)).slice(-1)));

  // ============================================================ sfondi
  console.log("\n== sfondi ==");
  page = await open(D.url + "/");
  const radios = async (p) => (await p.locator(".basemap-switch [role=radio]").allInnerTexts()).map((t) => t.trim());
  check("selettore: Mappa, Satellite, Scuro, Nessuno; attivo il primo", (await radios(page)).join() === "Mappa,Satellite,Scuro,Nessuno" && (await page.locator('.basemap-switch [aria-checked=true]').innerText()) === "Mappa");
  reqs.length = 0;
  await page.locator(".basemap-switch [role=radio]", { hasText: "Satellite" }).click();
  check("Satellite: i tile arrivano dal fornitore satellitare", await waitFor(() => reqs.some((u) => u.includes("server.arcgisonline.com"))));
  check("lo sfondo è nel link (#s)", (await hash(page)).b === "sat");
  await sleep(1500); // finiscono di arrivare i tile del satellite già in coda
  reqs.length = 0;
  await page.locator(".basemap-switch [role=radio]", { hasText: "Nessuno" }).click();
  await sleep(1200);
  check("Nessuno: nessun tile di sfondo richiesto", !reqs.some((u) => u.includes("/tiles/") || u.includes("arcgisonline") || u.includes("cartocdn")) && (await hash(page)).b === "none", reqs.join(" "));
  await page.locator(".basemap-switch [role=radio]", { hasText: "Scuro" }).click();
  check("Scuro: tile CARTO", await waitFor(() => reqs.some((u) => u.includes("cartocdn.com"))));
  await page.screenshot({ path: shot("basemap-dark.png") });
  const pageB = await open(D.url + "/#s=" + encodeURIComponent(JSON.stringify({ v: [12.5, 41.9, 9, 0, 0], l: [], b: "sat" })));
  check("da link con b=sat: parte con il satellite", (await pageB.locator('.basemap-switch [aria-checked=true]').innerText()) === "Satellite");
  const pageB2 = await open(D.url + "/#s=" + encodeURIComponent(JSON.stringify({ v: [12.5, 41.9, 9, 0, 0], l: [], b: "inesistente" })));
  check("sfondo sconosciuto nel link: ricade sul primo", (await pageB2.locator('.basemap-switch [aria-checked=true]').innerText()) === "Mappa");
  const pageE = await open(E.url + "/");
  check("BASEMAPS personalizzato: solo le voci valide (mappa, vuoto)", (await radios(pageE)).join() === "Mappa,Vuoto", (await radios(pageE)).join());
  check("GEOCODER=off: la ricerca resta, solo per attributi", /attributi/.test(await pageE.locator(".hsearch input").getAttribute("placeholder")));

  // ============================================================ scheda del layer
  console.log("\n== scheda del layer ==");
  page = await open(D.url + "/");
  await ready(page); await openGroups(page);
  const row = page.locator('label.item:has-text("Particelle")');
  await row.hover(); await row.locator(".item-info").click();
  const panel = page.locator(".float-panel.layerinfo");
  check("scheda: titolo, descrizione e parole chiave da GetCapabilities", await waitFor(async () => /Particelle catastali di prova/.test(await panel.innerText())) && (await panel.locator(".li-kw .chip").allInnerTexts()).join() === "catasto,particelle");
  check("scheda: oggetti (WFS hits), geometria e attributi", await waitFor(async () => { const t = await panel.innerText(); return /\b7\b/.test(t) && /MultiPolygon/.test(t) && /name, kind, area, surveyed/.test(t); }), await panel.innerText());
  check("scheda: fonte come link http(s); link javascript: scartato", (await panel.locator('a[href="https://example.org/fonte"]').count()) === 1 && (await panel.locator('a[href^="javascript"]').count()) === 0);
  await page.screenshot({ path: shot("layer-info.png") });
  await panel.getByRole("button", { name: "Aggiungi alla mappa" }).click();
  check("scheda: 'Aggiungi alla mappa' accende il layer", await waitFor(async () => (await page.locator(".active-card").count()) === 1));
  await page.locator('label.item:has-text("NDVI")').hover(); await page.locator('label.item:has-text("NDVI") .item-info').click();
  check("scheda raster: tipo, 365 date, nessun conteggio oggetti", await waitFor(async () => { const t = await page.locator(".float-panel.layerinfo").innerText(); return /Raster/.test(t) && /365 date/.test(t) && !/Oggetti/.test(t); }), await page.locator(".float-panel.layerinfo").innerText().catch((e) => "nessun pannello"));
  await page.locator(".float-panel.layerinfo [aria-label='Chiudi la scheda']").click();
  check("la scheda si chiude", (await page.locator(".float-panel.layerinfo").count()) === 0);

  // ============================================================ viste salvate (solo browser)
  console.log("\n== viste salvate (browser) ==");
  page = await open(D.url + "/", { ctx: ctxD });
  await ready(page); await openGroups(page); await page.locator('label.item:has-text("Particelle") input').check();
  await page.locator(".active-card").waitFor();
  await page.locator('.active-card input[placeholder^="Filtro CQL"]').fill("kind = 'A'");
  await page.locator('.active-card .fb-row button:has-text("Applica")').first().click();
  await waitFor(async () => (await hash(page)).l[0]?.[2] === "kind = 'A'");
  await page.locator(".basemap-switch [role=radio]", { hasText: "Satellite" }).click();
  await page.locator('button[title="Viste salvate"]').click();
  check("pannello viste: avvisa che sono solo in questo browser", await waitFor(async () => /solo in questo browser/.test(await page.locator(".float-panel.views").innerText())));
  await page.fill('.float-panel.views [aria-label="Nome della vista"]', "Particelle tipo A");
  await page.locator(".float-panel.views button:has-text('Salva')").click();
  check("vista salvata e in elenco", await waitFor(async () => /Particelle tipo A/.test(await page.locator(".view-list").innerText())));
  await page.screenshot({ path: shot("views.png") });
  const fresh = await open(D.url + "/", { ctx: ctxD });
  await fresh.locator('button[title="Viste salvate"]').click();
  check("dopo un ricaricamento la vista c'è ancora", await waitFor(async () => /Particelle tipo A/.test(await fresh.locator(".view-list").innerText())));
  await fresh.locator(".view-open", { hasText: "Particelle tipo A" }).click();
  check("aprire la vista: layer, filtro CQL e sfondo ripristinati", await waitFor(async () => (await fresh.locator(".active-card").count()) === 1 && (await fresh.locator('.active-card input[placeholder^="Filtro CQL"]').inputValue()) === "kind = 'A'" && (await fresh.locator('.basemap-switch [aria-checked=true]').innerText()) === "Satellite"));
  check("aprire la vista: inquadratura ripristinata e link aggiornato", await waitFor(async () => { const h = await hash(fresh); return h.b === "sat" && h.l[0][0] === "iride:parcels" && h.l[0][2] === "kind = 'A'"; }));
  check("il filtro della vista arriva ai tile", (await J("/__log")).some((l) => /request=GetMap/i.test(l.query) && /cql_filter=kind%20%3D%20(%27|')A(%27|')/.test(l.query)));
  await fresh.locator(".float-panel.views [aria-label='Elimina Particelle tipo A']").click();
  await fresh.locator(".float-panel.views button:has-text('Conferma')").click();
  check("elimina con conferma", await waitFor(async () => /Nessuna vista/.test(await fresh.locator(".float-panel.views").innerText())));

  // ============================================================ con Keycloak: viste su PostGIS, ricerca Photon con digitazione
  console.log("\n== viste su PostGIS (Keycloak) e Photon ==");
  await J("/__kc?user=alice&roles=fss-etl-admin");
  await J("/__reset");
  const pc = await open(C.url + "/", { wait: ".header" });
  await pc.waitForSelector(".sidebar");
  await ready(pc); await openGroups(pc); await pc.locator('label.item:has-text("Particelle") input').check();
  await pc.locator(".active-card").waitFor();
  await pc.locator('button[title="Viste salvate"]').click();
  check("PostGIS: il pannello non parla di 'solo browser'", await waitFor(async () => (await pc.locator(".float-panel.views").count()) === 1) && !/solo in questo browser/.test(await pc.locator(".float-panel.views").innerText()));
  await pc.fill('.float-panel.views [aria-label="Nome della vista"]', "Vista di Alice");
  await pc.locator(".float-panel.views button:has-text('Salva')").click();
  check("PostGIS: la vista compare in elenco", await waitFor(async () => /Vista di Alice/.test(await pc.locator(".view-list").innerText())));
  const st = await J("/__state");
  const row0 = st["mapp:saved_views"].features[0];
  check("PostGIS: riga scritta via WFS-T con proprietario, nome e definizione", row0?.properties.owner === "alice" && row0.properties.name === "Vista di Alice" && JSON.parse(row0.properties.definition).l[0][0] === "iride:parcels" && !!row0.properties.created_at, JSON.stringify(row0));
  const wtx = (await J("/__log")).filter((l) => l.method === "POST");
  check("la scrittura usa il token dell'utente (Bearer), non credenziali fisse", wtx.length > 0 && wtx.every((l) => l.auth.startsWith("Bearer")));
  check("saved_views non compare tra i prodotti", !(await pc.locator("label.item").allInnerTexts()).some((t) => /saved_views/.test(t)));
  // un altro utente non vede le viste di alice
  await J("/__kc?user=bob&roles=fss-etl-admin");
  const pb = await open(C.url + "/", { wait: ".header", ctx: await browser.newContext({ viewport: { width: 1400, height: 900 } }) });
  await pb.waitForSelector(".sidebar");
  await pb.locator('button[title="Viste salvate"]').click();
  check("un altro utente non vede le viste di alice (filtro owner)", await waitFor(async () => /Nessuna vista/.test(await pb.locator(".float-panel.views").innerText())));
  check("la richiesta delle viste filtra per proprietario", (await J("/__log")).some((l) => /typeName=mapp(%3A|:)saved_views/.test(l.query) && /cql_filter=owner(%20|\+| )(%3D|=)(%20|\+| )(%27|')bob(%27|')/.test(l.query)));
  await J("/__kc?user=alice&roles=fss-etl-admin");
  // Photon: ricerca mentre si scrive
  const g1 = (await J("/__geo")).length;
  await pc.fill(".hsearch input", "ba");
  await sleep(700);
  check("Photon: nessuna richiesta sotto i 3 caratteri", (await J("/__geo")).length === g1);
  await pc.fill(".hsearch input", "bari");
  check("Photon: ricerca automatica dopo la pausa, senza Invio", await waitFor(async () => (await pc.locator(".sr-item").count()) === 2));
  const gp = (await J("/__geo")).at(-1);
  check("Photon: richiesta a /api con lingua e bias sulla mappa, senza token", /\/photon\/api/.test(gp.path) && /lang=it/.test(gp.query) && /lat=/.test(gp.query) && gp.auth === null, JSON.stringify(gp));
  await pc.screenshot({ path: shot("photon.png") });
  console.log("\n== errori nel browser ==");
  check("nessun errore JS/console", errors.length === 0, errors.slice(0, 5).join(" | "));
  await browser.close();
  finish();
})().catch(crash);
