import { chromium } from "/opt/npm-tools/node_modules/playwright-core/index.mjs";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.resolve(here, "../proj");
const RUN = path.join(here, "run");
const MOCK = "http://127.0.0.1:8600";
const results = [];
const check = (name, ok, extra = "") => { results.push([name, !!ok]); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) { const t = Date.now(); let last; while (Date.now() - t < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(100); } return false; }
const dq = (l) => decodeURIComponent(l.query);
const J = async (u) => (await fetch(MOCK + u)).json();
const st = () => J("/__state");
const resetMock = () => J("/__reset");

// ---------------------------------------------------------------- nginx reale con la config generata dagli script di entrypoint
function startNginx(name, port, env) {
  const d = path.join(RUN, name);
  fs.rmSync(d, { recursive: true, force: true });
  for (const x of ["proxy.d", "html", "tmp"]) fs.mkdirSync(path.join(d, x), { recursive: true });
  fs.cpSync(path.join(PROJ, "dist"), path.join(d, "html"), { recursive: true });
  fs.rmSync(path.join(d, "html/config.json"), { force: true });
  const sub = (s) => s.replaceAll("/etc/nginx/proxy.d", `${d}/proxy.d`).replaceAll("/usr/share/nginx/html", `${d}/html`);
  const out = {};
  for (const sc of ["35-proxy-config.sh", "40-runtime-config.sh"]) {
    const src = sub(fs.readFileSync(`/mnt/user-data/outputs/docker-entrypoint.d/${sc}`, "utf8"));
    fs.writeFileSync(path.join(d, sc), src);
    out[sc] = execSync(`sh ${path.join(d, sc)}`, { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  }
  let conf = sub(fs.readFileSync("/mnt/user-data/outputs/nginx/default.conf", "utf8"))
    .replace("listen 8080", `listen ${port}`).replace("access_log /dev/stdout mapp", `access_log ${d}/access.log mapp`).replace("error_log  /dev/stderr warn", `error_log ${d}/server-error.log warn`);
  fs.writeFileSync(path.join(d, "default.conf"), conf);
  fs.writeFileSync(path.join(d, "nginx.conf"), `user root;\npid ${d}/nginx.pid;\nerror_log ${d}/error.log;\nevents {}\nhttp {\n include /etc/nginx/mime.types;\n client_body_temp_path ${d}/tmp/b; proxy_temp_path ${d}/tmp/p; fastcgi_temp_path ${d}/tmp/f; uwsgi_temp_path ${d}/tmp/u; scgi_temp_path ${d}/tmp/s;\n include ${d}/default.conf;\n}\n`);
  execSync(`nginx -t -c ${d}/nginx.conf -p ${d} 2>&1`);
  execSync(`nginx -c ${d}/nginx.conf -p ${d}`);
  return { d, out, url: `http://127.0.0.1:${port}`, stop: () => { try { execSync(`kill $(cat ${d}/nginx.pid)`); } catch {} } };
}

const baseEnv = {
  AUTH_ENABLED: "false", GEOSERVER_PROXY_URL: `${MOCK}/geoserver`, GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass",
  BASEMAP_TILES: `${MOCK}/tiles/{z}/{x}/{y}.png`, APP_TITLE: 'Test <&> "app"', APP_ACCENT: "#0a6cc4", MAP_CENTER_LON: "12.5", MAP_CENTER_LAT: "41.9", MAP_ZOOM: "9",
};

// ---------------------------------------------------------------- geometria dello schermo (Web Mercator, tile da 512 px)
const merc = (lon, lat, z) => { const s = 512 * 2 ** z; return [((lon + 180) / 360) * s, (0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI)) * s]; };
const hashFor = (v, l) => "#s=" + encodeURIComponent(JSON.stringify({ v, l }));
const VIEW = [12.42, 41.8675, 12, 0, 0];

(async () => {
  fs.mkdirSync(path.join(here, "shots"), { recursive: true });
  execSync("pkill -x nginx || true");
  const A = startNginx("A", 8091, { ...baseEnv, GEOSERVER_WRITE_USER: "writer", GEOSERVER_WRITE_PASSWORD: "wpass", EDIT_ENABLED: "true" });
  const B = startNginx("B", 8092, { ...baseEnv });
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const errors = [];
  const openPage = async (base, hash = "", scheme = "light", { geo = false } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: scheme, acceptDownloads: true, permissions: geo ? ["geolocation"] : [] });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
    await page.goto(base + "/" + hash);
    await page.waitForSelector(".sidebar");
    return page;
  };
  const mapBox = async (page) => { const b = await page.locator(".map-el").boundingBox(); return { cx: b.x + b.width / 2, cy: b.y + b.height / 2, ...b }; };
  const at = async (page, lon, lat, view = VIEW) => { const b = await mapBox(page); const [cx, cy] = merc(view[0], view[1], view[2]); const [x, y] = merc(lon, lat, view[2]); return [b.cx + (x - cx), b.cy + (y - cy)]; };
  const openGroups = (page) => page.evaluate(() => document.querySelectorAll("details.group").forEach((d) => (d.open = true)));
  const hashOf = (page) => page.evaluate(() => window.location.hash);
  const readHash = async (page) => JSON.parse(decodeURIComponent((await hashOf(page)).slice(3)));

  // ============================================================ proxy / sicurezza (curl)
  console.log("\n== proxy ==");
  const curl = (args) => execSync(`curl -s -o /dev/null -w '%{http_code}' ${args}`, { encoding: "utf8" });
  check("A: /config.json ha editEnabled=true e /geoserver", await (async () => { const c = await (await fetch(A.url + "/config.json")).json(); return c.editEnabled === true && c.geoserverUrl === "/geoserver" && !c.keycloak && c.title === 'Test <&> "app"'; })());
  check("B: /config.json ha editEnabled=false", (await (await fetch(B.url + "/config.json")).json()).editEnabled === false);
  check("GET /geoserver passa con le credenziali di lettura", curl(`'${A.url}/geoserver/ows?service=WMS&request=GetCapabilities' -H 'Authorization: Bearer x'`) === "200");
  check("A: POST /geoserver/wms -> 403", curl(`-X POST '${A.url}/geoserver/wms' -d x`) === "403");
  check("A: POST /geoserver/rest/workspaces -> 403", curl(`-X POST '${A.url}/geoserver/rest/workspaces' -d x`) === "403");
  check("A: DELETE /geoserver/rest/workspaces/x -> 403", curl(`-X DELETE '${A.url}/geoserver/rest/workspaces/x'`) === "403");
  check("A: POST /geoserver/wfs con credenziali di scrittura -> 200", curl(`-X POST '${A.url}/geoserver/wfs' -H 'Content-Type: text/xml' -d '<wfs:Transaction xmlns:wfs="http://www.opengis.net/wfs" service="WFS" version="1.0.0"/>'`) === "200");
  check("B (sola lettura): POST /geoserver/wfs -> 403", curl(`-X POST '${B.url}/geoserver/wfs' -d x`) === "403");
  check("config 404 -> SPA, /healthz ok", curl(`'${A.url}/healthz'`) === "200");
  const log0 = await J("/__log");
  check("l'upstream riceve Host del mock e Authorization Basic", log0.some((l) => l.host === "127.0.0.1:8600" && l.auth.startsWith("Basic")));

  // ============================================================ elenco prodotti e layer
  console.log("\n== prodotti e layer ==");
  await resetMock();
  let page = await openPage(A.url);
  check("titolo pagina da APP_TITLE", (await page.title()) === 'Test <&> "app"');
  check("4 prodotti elencati", await waitFor(async () => (await page.locator("label.item").count()) === 4));
  check("gruppi per workspace (iride, demo)", (await page.locator("details.group").count()) === 2);
  await page.fill(".panel-head .search", "sens");
  check("ricerca filtra l'elenco", await waitFor(async () => (await page.locator("label.item").count()) === 1));
  await page.fill(".panel-head .search", "");
  await openGroups(page); await page.locator('label.item:has-text("Particelle") input').check();
  check("layer acceso -> scheda attiva", await waitFor(async () => (await page.locator(".active-card").count()) === 1));
  check("richieste GetMap con filtro assente", await waitFor(async () => (await J("/__log")).some((l) => /request=GetMap/i.test(l.query) && /layers=iride%3Aparcels/.test(l.query) && !/cql_filter/.test(l.query))));
  await openGroups(page); await page.locator('label.item:has-text("NDVI") input').check();
  check("raster: due schede, NDVI in cima", await waitFor(async () => (await page.locator(".active-card").count()) === 2 && /NDVI/.test(await page.locator(".active-card .name").first().innerText())));
  check("raster: input data a testo libero (intervallo)", (await page.locator('.active-card:has-text("NDVI") input[placeholder^="Data o intervallo"]').count()) === 1);
  await page.locator('.active-card:has-text("NDVI") input[placeholder^="Data o intervallo"]').fill("2026-06-01");
  await page.locator('.active-card:has-text("NDVI") .fb-row button:has-text("Applica")').last().click();
  check("raster: time inviato a GetMap", await waitFor(async () => (await J("/__log")).some((l) => /layers=iride%3Andvi/.test(l.query) && /time=2026-06-01/.test(l.query))));
  await page.locator('.active-card:has-text("NDVI") [title="Rimuovi dalla mappa"]').click();
  await openGroups(page); await page.locator('label.item:has-text("Sensori") input').check();
  const sel = page.locator('.active-card:has-text("Sensori") select');
  check("TIME discreto -> menu con 3 date", await waitFor(async () => (await sel.locator("option").count()) === 4));
  await sel.selectOption("2026-02-01");
  check("TIME: GetMap con time=2026-02-01", await waitFor(async () => (await J("/__log")).some((l) => /layers=iride%3Asensors/.test(l.query) && /time=2026-02-01/.test(l.query))));
  await page.locator('.active-card:has-text("Sensori") [title="Rimuovi dalla mappa"]').click();

  // CQL
  const card = page.locator('.active-card:has-text("Particelle")');
  await card.locator(".filterbox input.search").first().fill("kind = 'A'");
  await card.locator(".fb-row button:has-text('Applica')").first().click();
  check("CQL valido: GetMap con cql_filter senza parentesi extra", await waitFor(async () => (await J("/__log")).some((l) => /request=GetMap/i.test(l.query) && dq(l).includes("cql_filter=kind = 'A'"))));
  await card.locator(".filterbox input.search").first().fill("bad ~~ 1");
  await card.locator(".fb-row button:has-text('Applica')").first().click();
  check("CQL non valido: messaggio d'errore, filtro non applicato", await waitFor(async () => /Filtro non valido/.test(await card.locator(".filterbox .error").innerText())));
  check("CQL non valido: l'ultimo filtro resta quello buono", (await readHash(page)).l[0][2] === "kind = 'A'");
  await card.locator(".fb-row button:has-text('Togli')").first().click().catch(() => {});

  // ============================================================ Feature Info
  console.log("\n== feature info, editing ==");
  await page.close();
  await resetMock();
  page = await openPage(A.url, hashFor(VIEW, [["iride:parcels", 1, "", ""]]));
  check("restore dal link: layer attivo", await waitFor(async () => (await page.locator(".active-card").count()) === 1));
  check("restore dal link: vista", await waitFor(async () => { const h = await readHash(page); return Math.abs(h.v[2] - 12) < 0.05 && Math.abs(h.v[0] - 12.42) < 0.001; }));
  const { cx, cy } = await mapBox(page);
  await page.locator('button.tool[title="Interroga oggetti (Feature Info)"]').click();
  await page.mouse.click(cx, cy);
  check("Feature Info mostra Particella 1", await waitFor(async () => /Particella 1/.test(await page.locator(".float-panel").innerText())));
  check("Feature Info: pulsante Modifica presente (editing attivo)", (await page.locator('.float-panel button.btn-sm:has-text("Modifica")').count()) >= 1);

  // modifica attributo con caratteri speciali
  await page.locator('.float-panel button.btn-sm:has-text("Modifica")').first().click();
  const nameInput = page.locator('.float-panel.editor .ed-field:has(span:text-is("name")) input');
  check("editor: form con i valori dell'oggetto", await waitFor(async () => (await nameInput.inputValue()) === "Particella 1"));
  const special = `A <b> & "c" 'd'`;
  await nameInput.fill(special);
  await page.locator('.float-panel.editor button:has-text("Salva")').click();
  check("editor: salvataggio riuscito", await waitFor(async () => /Modifiche salvate/.test(await page.locator(".float-panel.editor .ok").innerText())));
  let s = await st();
  check("WFS-T Update: attributo scritto con escaping corretto", s["iride:parcels"].features[0].properties.name === special, JSON.stringify(s["iride:parcels"].features[0].properties));
  const posts = (await J("/__log")).filter((l) => l.method === "POST");
  check("WFS-T: richiesta POST con &lt;b&gt; e FeatureId", posts.some((p) => p.body.includes("&lt;b&gt;") && p.body.includes('fid="parcels.1"')));
  check("WFS-T: solo le colonne modificate", posts.every((p) => !p.body.includes("<wfs:Name>kind</wfs:Name>")));

  // riapertura dello stesso oggetto dopo il salvataggio (rimonta l'editor)
  await page.locator('.float-panel.editor [title="Chiudi editor"]').click().catch(() => {});
  await page.locator('button.tool[title="Interroga oggetti (Feature Info)"]').click();
  await page.mouse.click(cx, cy);
  check("dopo il salvataggio il nuovo nome è interrogabile", await waitFor(async () => (await page.locator(".float-panel").innerText()).includes("<b>")));
  await page.locator('.float-panel button.btn-sm:has-text("Modifica")').first().click();
  check("riapertura dello stesso oggetto: editor rimontato con il valore nuovo", await waitFor(async () => (await nameInput.inputValue()) === special));

  // trascinamento di un vertice
  const [vx, vy] = await at(page, 12.44, 41.885);
  const dx = 40, dy = -25;
  await page.mouse.move(vx, vy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(vx + (dx * i) / 8, vy + (dy * i) / 8);
  await page.mouse.up();
  check("trascinamento vertice: 'Geometria modificata'", await waitFor(async () => /Geometria modificata/.test(await page.locator(".float-panel.editor").innerText())));
  await page.screenshot({ path: path.join(here, "shots/vertex-edit.png") });
  await page.locator('.float-panel.editor button:has-text("Salva")').click();
  check("vertice: salvataggio riuscito", await waitFor(async () => /Modifiche salvate/.test(await page.locator(".float-panel.editor .ok").innerText())));
  s = await st();
  const ring = s["iride:parcels"].features[0].geometry.coordinates[0][0];
  const expLon = 12.44 + (dx * 360) / (512 * 2 ** 12);
  check("WFS-T: vertice spostato (lon/lat nel posto giusto)", ring.some(([x, y]) => Math.abs(x - expLon) < 0.0008 && y > 41.8855 && y < 41.8895), JSON.stringify(ring));
  check("WFS-T: la geometria resta MultiPolygon", s["iride:parcels"].features[0].geometry.type === "MultiPolygon");
  check("WFS-T: gli altri vertici restano", ring.length === 5 && ring.some(([x, y]) => x === 12.4 && y === 41.85));

  // nuovo poligono
  await page.locator('.active-card [title="Modifica oggetti"]').click();
  await page.locator('.float-panel.editor button:has-text("Poligono")').click();
  for (const [lon, lat] of [[12.43, 41.83], [12.46, 41.83], [12.46, 41.845], [12.43, 41.845]]) { const [x, y] = await at(page, lon, lat); await page.mouse.click(x, y); }
  await page.locator('.float-panel.editor button:has-text("Termina disegno")').click();
  await page.locator('.float-panel.editor .ed-field:has(span:text-is("name")) input').fill("Nuova");
  await page.locator('.float-panel.editor .ed-field:has(span:text-is("area")) input').fill("42.5");
  await page.locator('.float-panel.editor button:has-text("Salva")').click();
  check("nuovo oggetto: creato", await waitFor(async () => /Nuovo oggetto creato/.test(await page.locator(".float-panel.editor .ok").innerText())));
  s = await st();
  const nf = s["iride:parcels"].features.at(-1);
  check("WFS-T Insert: 8 oggetti, valori e geometria", s["iride:parcels"].features.length === 8 && nf.properties.name === "Nuova" && nf.properties.area === 42.5 && nf.geometry.type === "MultiPolygon" && nf.geometry.coordinates[0][0].length === 5, JSON.stringify(nf));

  // eliminazione
  page.on("dialog", (d) => d.accept());
  await page.locator('.float-panel.editor [title="Chiudi editor"]').click();
  await page.locator('button.tool[title="Interroga oggetti (Feature Info)"]').click();
  const [px, py] = await at(page, 12.445, 41.8375);
  await page.mouse.click(px, py);
  check("Feature Info sul nuovo oggetto", await waitFor(async () => /Nuova/.test(await page.locator(".float-panel").innerText())));
  await page.locator('.float-panel button.btn-sm:has-text("Modifica")').first().click();
  await page.locator('.float-panel.editor button:has-text("Elimina")').click();
  check("eliminazione: riuscita", await waitFor(async () => /Oggetto eliminato/.test(await page.locator(".float-panel.editor .ok").innerText())));
  check("WFS-T Delete: 7 oggetti", (await st())["iride:parcels"].features.length === 7);
  check("dopo la scrittura i tile vengono ricaricati (_r nel GetMap)", (await J("/__log")).some((l) => /request=GetMap/i.test(l.query) && /_r=\d/.test(l.query)));
  await page.screenshot({ path: path.join(here, "shots/after-edit.png") });
  await page.close();

  // errori di scrittura mostrati all'utente (proxy in sola lettura)
  console.log("\n== sola lettura ==");
  page = await openPage(B.url, hashFor(VIEW, [["iride:parcels", 1, "", ""]]));
  await waitFor(async () => (await page.locator(".active-card").count()) === 1);
  check("B: nessun pulsante di modifica nella scheda", (await page.locator('.active-card [title="Modifica oggetti"]').count()) === 0);
  await page.locator('button.tool[title="Interroga oggetti (Feature Info)"]').click();
  const b = await mapBox(page);
  await page.mouse.click(b.cx, b.cy);
  check("B: Feature Info senza pulsante Modifica", await waitFor(async () => /Particella|A <b>/.test(await page.locator(".float-panel").innerText())) && (await page.locator('.float-panel button.btn-sm:has-text("Modifica")').count()) === 0);
  await page.close();

  // ============================================================ filtro dal link, dashboard, tabella
  console.log("\n== dashboard e tabella ==");
  await resetMock();
  page = await openPage(A.url, hashFor(VIEW, [["iride:parcels", 0.8, "", ""]]));
  await waitFor(async () => (await page.locator(".active-card").count()) === 1);
  await page.locator('.active-card [title="Dashboard"]').click();
  check("dashboard: KPI 'Oggetti in vista'", await waitFor(async () => /oggetti in vista/i.test(await page.locator(".kpis").innerText())));
  await page.locator(".dock-check input").uncheck();
  check("dashboard: senza 'solo vista corrente' conta tutti i 7 oggetti", await waitFor(async () => /\b7\b/.test(await page.locator(".kpis .kpi").first().innerText())));
  await page.locator(".dock-field select").selectOption("kind");
  check("dashboard: 3 barre (A, B, C)", await waitFor(async () => (await page.locator(".bar-row").count()) === 3));
  const labels = await page.locator(".bar-label").allInnerTexts();
  check("dashboard: barre ordinate per conteggio (A prima, 3 oggetti)", labels[0] === "A" && (await page.locator(".bar-row").first().getAttribute("aria-label")) === "A: 3", labels.join());
  await page.locator(".bar-row").first().hover();
  const tipTxt = await waitFor(async () => (await page.locator(".viz-tip").innerText()) || false);
  check("dashboard: tooltip con valore e quota", /3 · 4[23]/.test(tipTxt), String(tipTxt));
  await page.locator(".bar-row").first().click();
  check("clic sulla barra: chip del filtro grafico", await waitFor(async () => /kind = A/.test(await page.locator(".dock-tools .chip").innerText())));
  check("clic sulla barra: la mappa filtra (GetMap con kind = 'A')", await waitFor(async () => (await J("/__log")).some((l) => /request=GetMap/i.test(l.query) && dq(l).includes("cql_filter=kind = 'A'"))));
  check("clic sulla barra: la scheda mostra 'Dal grafico'", /Dal grafico/.test(await page.locator(".active-card").innerText()));
  check("barre non selezionate attenuate", await waitFor(async () => (await page.locator(".bar-row.dim").count()) === 2));
  await page.locator('.dock-tab:has-text("Tabella")').click();
  check("tabella filtrata dal grafico: 3 righe", await waitFor(async () => (await page.locator("table.attr tbody tr").count()) === 3));
  await page.locator('.dock-tab:has-text("Dashboard")').click();
  await page.locator(".dock-tools .chip .icon-btn").click();
  check("rimozione selezione: chip sparito", await waitFor(async () => (await page.locator(".dock-tools .chip").count()) === 0));
  await page.locator('.dock-tab:has-text("Tabella")').click();
  check("tabella intera: 7 righe", await waitFor(async () => (await page.locator("table.attr tbody tr").count()) === 7));
  await page.fill(".dock-tools input.search:not(.cql)", "Particella 3");
  check("filtro rapido sulla tabella", await waitFor(async () => (await page.locator("table.attr tbody tr").count()) === 1));
  await page.fill(".dock-tools input.search:not(.cql)", "");
  await page.fill(".dock-tools input.search.cql", "area > 400");
  await page.locator('.dock-tools button:has-text("Applica")').click();
  check("filtro CQL sulla tabella (area > 400 -> 3 righe)", await waitFor(async () => (await page.locator("table.attr tbody tr").count()) === 3));
  await page.locator('table.attr tbody tr').first().click();
  check("riga selezionata evidenziata sulla mappa", await waitFor(async () => (await page.locator("table.attr tr.sel").count()) === 1));
  await page.locator('.dock-tab:has-text("Dashboard")').click();
  await page.locator(".dock-field select").selectOption("area");
  check("campo numerico: istogramma a 10 classi + KPI", await waitFor(async () => (await page.locator(".col").count()) === 10 && /somma/i.test(await page.locator(".kpis").innerText())));
  await page.locator(".col").nth(0).click();
  check("clic su una classe: filtro con >= e <", await waitFor(async () => (await J("/__log")).some((l) => /request=GetMap/i.test(l.query) && /cql_filter=area >= /.test(dq(l)) && / < /.test(dq(l)))));
  await page.locator(".dock-tools .chip .icon-btn").click();
  await page.locator(".dock-field select").selectOption("surveyed");
  check("campo data: colonne per mese", await waitFor(async () => (await page.locator(".col").count()) === 3));
  await page.locator(".viz-toggle button:has-text('Tabella')").click();
  check("vista tabella dei dati del grafico", await waitFor(async () => (await page.locator("table.viz-table tbody tr").count()) === 3));
  await page.screenshot({ path: path.join(here, "shots/dashboard-light.png") });

  // link condivisibile
  await page.locator(".dock-field select").selectOption("kind");
  await page.locator(".viz-toggle button:has-text('Grafico')").click();
  const card2 = page.locator(".active-card");
  await card2.locator(".filterbox input.search").first().fill("kind = 'B'");
  await card2.locator(".fb-row button:has-text('Applica')").first().click();
  check("filtro CQL applicato dalla scheda", await waitFor(async () => (await readHash(page)).l[0][2] === "kind = 'B'"));
  check("opacità dal link applicata", (await readHash(page)).l[0][1] === 0.8);
  const link = await page.evaluate(() => window.location.href);
  const p2 = await openPage(A.url, link.slice(link.indexOf("#")));
  check("link: layer, filtro e opacità ripristinati", await waitFor(async () => (await p2.locator(".active-card").count()) === 1 && (await p2.locator('.active-card .filterbox input.search').first().inputValue()) === "kind = 'B'" && (await p2.locator('.active-card input[type=range]').inputValue()) === "0.8"));
  await p2.close();
  await page.close();

  // ============================================================ strumenti, 3D, GPS, export, tema
  console.log("\n== strumenti ==");
  page = await openPage(A.url, hashFor(VIEW, [["iride:parcels", 1, "", ""]]), "light", { geo: true });
  await waitFor(async () => (await page.locator(".active-card").count()) === 1);
  check("controllo GPS (geolocate) presente", (await page.locator(".maplibregl-ctrl-geolocate").count()) === 1);
  check("pulsante 'Copia il link' presente", (await page.locator('[title="Copia il link a questa vista"]').count()) === 1);
  const mb = await mapBox(page);
  await page.locator('button.tool[title="Misura distanza"]').click();
  await page.mouse.click(mb.cx - 300, mb.cy + 200);
  await page.mouse.click(mb.cx + 300, mb.cy + 200);
  const lenTxt = await waitFor(async () => { const t = await page.locator(".float-panel .big").innerText(); return /km|m/.test(t) ? t : false; });
  const km = parseFloat(String(lenTxt).replace(",", "."));
  const lat = 41.8675;
  const expected = (600 * 40075016.686 * Math.cos(((lat - 0.02) * Math.PI) / 180)) / (512 * 2 ** 12) / 1000;
  check("misura distanza ≈ 600 px a z12", km > expected * 0.95 && km < expected * 1.05, `${lenTxt} atteso ~${expected.toFixed(2)} km`);
  await page.locator('button.tool[title="Misura area"]').click();
  for (const [x, y] of [[-100, -100], [100, -100], [100, 100], [-100, 100]]) await page.mouse.click(mb.cx + x, mb.cy + y);
  check("misura area: valore mostrato", await waitFor(async () => /(km²|m²|ha)/.test(await page.locator(".float-panel .big").innerText())));
  await page.locator('button.tool[title="Coordinate"]').click();
  await page.mouse.click(mb.cx, mb.cy);
  check("coordinate: centro ≈ 41.8675, 12.42", await waitFor(async () => { const t = await page.locator(".float-panel .big").innerText(); const [a, o] = t.split(",").map(parseFloat); return Math.abs(a - 41.8675) < 0.003 && Math.abs(o - 12.42) < 0.003; }));
  await page.locator('button.tool[title="Navigazione"]').click();

  await page.locator('button.tool[title="Vista inclinata"]').click();
  check("3D: pulsante cambia titolo", await waitFor(async () => (await page.locator('button.tool[title="Torna alla vista 2D"]').count()) === 1));
  check("3D: inclinazione 60° nel link", await waitFor(async () => Math.abs((await readHash(page)).v[3] - 60) <= 1));
  await page.screenshot({ path: path.join(here, "shots/tilt.png") });
  await page.locator('button.tool[title="Torna alla vista 2D"]').click();
  check("3D: ritorno a 2D", await waitFor(async () => (await readHash(page)).v[3] === 0));

  await page.locator('button.tool[title^="Stampa"]').click();
  await page.fill('.float-panel.export input', "Mappa di prova");
  const dl = page.waitForEvent("download", { timeout: 15000 });
  await page.locator('.float-panel.export button:has-text("Scarica PNG")').click();
  const file = await dl.catch(() => null);
  let okPng = false;
  if (file) { const p = path.join(here, "shots/export.png"); await file.saveAs(p); const buf = fs.readFileSync(p); okPng = buf.length > 5000 && buf.slice(1, 4).toString() === "PNG"; }
  check("export PNG scaricato e valido", okPng);
  await page.close();

  // tema scuro
  page = await openPage(A.url, hashFor(VIEW, [["iride:parcels", 1, "", ""]]), "dark");
  await waitFor(async () => (await page.locator(".active-card").count()) === 1);
  await page.locator('.active-card [title="Dashboard"]').click();
  await page.locator(".dock-field select").selectOption("kind");
  await waitFor(async () => (await page.locator(".bar-row").count()) === 3);
  await page.screenshot({ path: path.join(here, "shots/dashboard-dark.png") });
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check("tema scuro: sfondo scuro", bg === "rgb(18, 26, 37)", bg);
  await page.close();

  // lingua: layer mancanti -> errore elenco leggibile
  check("nessun errore JS/console durante i test", errors.length === 0, errors.slice(0, 5).join(" | "));

  await browser.close();
  A.stop(); B.stop();
  const bad = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - bad.length}/${results.length} controlli superati`);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error("ERRORE NEL TEST:", e); try { execSync("pkill -x nginx || true"); } catch {} process.exit(2); });
