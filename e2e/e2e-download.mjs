// Scarico dei dati dal browser: GeoJSON, CSV, Shapefile (WFS) e GeoTIFF (WCS), con filtro, data e area della mappa,
// limite di oggetti; i file scaricati vengono aperti e controllati.
import fs from "node:fs";
import { J, MOCK, crash, launchBrowser, prepare, results, shot, sleep, startNginx, waitFor } from "./lib.mjs";

const { check, finish } = results();

const env = {
  AUTH_ENABLED: "false", GEOCODER: "off", GEOSERVER_PROXY_URL: `${MOCK}/geoserver`, GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass",
  BASEMAP_TILES: `${MOCK}/tiles/{z}/{x}/{y}.png`, APP_TITLE: "Test scarico", MAP_CENTER_LON: "12.5", MAP_CENTER_LAT: "41.9", MAP_ZOOM: "9",
  DOWNLOAD_MAX_FEATURES: "5",
};
const hashFor = (v, l) => "#s=" + encodeURIComponent(JSON.stringify({ v, l }));
const VIEW = [12.5, 41.87, 11, 0, 0];
const reqs = async (re) => (await J("/__log")).filter((l) => re.test(decodeURIComponent(l.query)));
const param = (l, k) => new URLSearchParams(l.query).get(k);

(async () => {
  prepare();
  await J("/__reset");
  const X = startNginx("X", 8099, env);
  const cfg = await (await fetch(X.url + "/config.json")).json();
  check("config.json: downloadMaxFeatures da DOWNLOAD_MAX_FEATURES", cfg.downloadMaxFeatures === 5);

  const browser = await launchBrowser();
  const errors = [];
  const open = async (hash, scheme = "light") => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true, colorScheme: scheme });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
    await page.goto(X.url + "/" + hash);
    await page.waitForSelector(".sidebar");
    return page;
  };
  /** Clicca "Scarica" e restituisce nome e contenuto del file arrivato al browser. */
  const grab = async (page) => {
    const ev = page.waitForEvent("download", { timeout: 15000 });
    await page.locator('.float-panel.download button:has-text("Scarica")').click();
    const d = await ev;
    const p = shot(`dl-${d.suggestedFilename()}`);
    await d.saveAs(p);
    return { name: d.suggestedFilename(), buf: fs.readFileSync(p) };
  };
  const countText = (page) => page.locator(".float-panel.download .dl-count").innerText();

  // ============================================================ vettoriale con filtro, area visibile
  console.log("\n== vettoriale: filtro e area visibile ==");
  let page = await open(hashFor(VIEW, [["iride:parcels", 1, "kind = 'A'", "", ""]]));
  await waitFor(async () => (await page.locator(".active-card").count()) === 1);
  const btn = page.locator('.active-card [title="Scarica dati"]');
  check("pulsante 'Scarica dati' nella scheda del layer", (await btn.count()) === 1);
  await btn.click();
  check("pannello di scarico aperto, con il nome del layer", await waitFor(async () => /Particelle/.test(await page.locator(".float-panel.download .dl-layer").innerText())));
  check("il pannello mostra il filtro attivo", /kind = 'A'/.test(await page.locator(".float-panel.download").innerText()));
  const nView = Number((await waitFor(async () => { const t = await countText(page); return /^\d+ oggetti$/.test(t) ? t : false; }) || "").split(" ")[0]);
  check(`conteggio nell'area visibile: ${nView} oggetti`, nView > 0 && nView <= 3);
  const hits = (await reqs(/resultType=hits/)).at(-1);
  check("il conteggio usa filtro + BBOX dell'area visibile", !!hits && /^\(kind = 'A'\) AND BBOX\(geom,[\d.]+,[\d.]+,[\d.]+,[\d.]+,'EPSG:4326'\)$/.test(param(hits, "cql_filter")), hits && param(hits, "cql_filter"));
  await page.screenshot({ path: shot("download-panel.png") });

  let f = await grab(page);
  const gj = JSON.parse(f.buf.toString());
  check(`GeoJSON: ${f.name}`, /^parcels_\d{8}-\d{4}\.geojson$/.test(f.name));
  check("GeoJSON: stesso numero di oggetti del conteggio, tutti con kind = A", gj.features.length === nView && gj.features.every((x) => x.properties.kind === "A"), `${gj.features.length} vs ${nView}`);
  check("messaggio con nome e dimensione del file", /Scaricato parcels_.*\.geojson \(\d/.test(await page.locator(".float-panel.download .ok").innerText()));
  const getGj = (await reqs(/request=GetFeature/)).filter((l) => /outputFormat=application\/json/.test(decodeURIComponent(l.query)) && !/resultType/.test(l.query)).at(-1);
  check("GetFeature: EPSG:4326, limite 5, stesso filtro del conteggio", param(getGj, "srsName") === "EPSG:4326" && param(getGj, "maxFeatures") === "5" && param(getGj, "cql_filter") === param(hits, "cql_filter"));
  check("la richiesta passa dal proxy con le credenziali di lettura", getGj.auth.startsWith("Basic"));

  await page.locator('.float-panel.download select[aria-label="Formato"]').selectOption("csv");
  f = await grab(page);
  const lines = f.buf.toString().trim().split(/\r?\n/);
  check(`CSV: ${f.name}, intestazione con attributi e geometria`, /\.csv$/.test(f.name) && lines[0] === "FID,name,kind,area,surveyed,geom", lines[0]);
  check("CSV: una riga per oggetto, geometria in WKT", lines.length - 1 === nView && lines.slice(1).every((l) => /MULTIPOLYGON/.test(l)));

  await page.locator('.float-panel.download select[aria-label="Formato"]').selectOption("shp");
  f = await grab(page);
  const zipNames = [];
  for (let i = 0; i + 30 < f.buf.length; ) {
    if (f.buf.readUInt32LE(i) !== 0x04034b50) break;
    const nl = f.buf.readUInt16LE(i + 26), sz = f.buf.readUInt32LE(i + 18);
    zipNames.push(f.buf.subarray(i + 30, i + 30 + nl).toString());
    i += 30 + nl + sz;
  }
  check(`Shapefile: ${f.name} è uno zip con .shp .shx .dbf .prj`, /\.zip$/.test(f.name) && ["parcels.shp", "parcels.shx", "parcels.dbf", "parcels.prj"].every((n) => zipNames.includes(n)), zipNames.join(","));
  const getShp = (await reqs(/outputFormat=SHAPE-ZIP/)).at(-1);
  check("Shapefile: richiesto in UTF-8 (accenti corretti nel .dbf)", param(getShp, "format_options") === "CHARSET:UTF-8");

  // ============================================================ tutto il layer, oltre il limite
  console.log("\n== tutto il layer e limite ==");
  await page.close();
  page = await open(hashFor(VIEW, [["iride:parcels", 1, "", "", ""]]));
  await waitFor(async () => (await page.locator(".active-card").count()) === 1);
  await page.locator('.active-card [title="Scarica dati"]').click();
  await page.locator(".float-panel.download").getByLabel("Tutto il layer").check();
  check("tutto il layer: 7 oggetti", await waitFor(async () => (await countText(page)) === "7 oggetti"));
  check("oltre il limite: avviso 'solo i primi 5'", await waitFor(async () => /solo i primi 5 oggetti/.test(await page.locator(".float-panel.download .warn").innerText())));
  const allHits = (await reqs(/resultType=hits/)).at(-1);
  check("tutto il layer, senza filtro: nessun cql_filter", param(allHits, "cql_filter") === null);
  f = await grab(page);
  check("scaricati solo i primi 5 oggetti", JSON.parse(f.buf.toString()).features.length === 5);

  // l'area segue la mappa
  await page.locator(".float-panel.download").getByLabel("Area visibile").check();
  await page.evaluate(() => window.scrollTo(0, 0));
  const before = (await reqs(/resultType=hits/)).length;
  const map = await page.locator(".map-el").boundingBox();
  await page.mouse.move(map.x + map.width / 2, map.y + map.height / 2);
  await page.mouse.down();
  await page.mouse.move(map.x + map.width / 2 + 500, map.y + map.height / 2, { steps: 8 });
  await page.mouse.up();
  check("spostando la mappa il conteggio si aggiorna con la nuova area", await waitFor(async () => (await reqs(/resultType=hits/)).length > before));
  await page.close();

  // ============================================================ raster: GeoTIFF via WCS
  console.log("\n== raster ==");
  page = await open(hashFor(VIEW, [["iride:ndvi", 1, "", "2026-06-01", ""]]), "dark");
  await waitFor(async () => (await page.locator(".active-card").count()) === 1);
  await page.locator('.active-card [title="Scarica dati"]').click();
  check("raster: formato GeoTIFF dell'area visibile e data", await waitFor(async () => { const t = await page.locator(".float-panel.download").innerText(); return /GeoTIFF dell'area visibile/.test(t) && /Data: 2026-06-01/.test(t); }));
  check("raster: elenco WCS chiesto all'apertura del pannello", (await reqs(/service=WCS&version=2\.0\.1&request=GetCapabilities/)).length === 1);
  await waitFor(async () => page.locator('.float-panel.download button:has-text("Scarica")').isEnabled());
  await page.screenshot({ path: shot("download-raster-dark.png") });
  f = await grab(page);
  check(`GeoTIFF: ${f.name}`, /^ndvi_\d{8}-\d{4}\.tif$/.test(f.name));
  check("GeoTIFF: file TIFF valido", ["II*\0", "MM\0*"].includes(f.buf.subarray(0, 4).toString("latin1")) && f.buf.length > 100);
  const cov = (await reqs(/request=GetCoverage/)).at(-1);
  const subs = new URLSearchParams(cov.query).getAll("subset");
  const lon = /^Long\(([\d.]+),([\d.]+)\)$/.exec(subs[0]), lat = /^Lat\(([\d.]+),([\d.]+)\)$/.exec(subs[1]);
  check("GetCoverage: copertura iride__ndvi, GeoTIFF, EPSG:4326", param(cov, "coverageId") === "iride__ndvi" && param(cov, "format") === "image/tiff" && /EPSG\/0\/4326$/.test(param(cov, "subsettingCRS")));
  check("GetCoverage: ritaglio sull'area visibile (intorno al centro della vista)", !!lon && !!lat && +lon[1] < 12.5 && +lon[2] > 12.5 && +lat[1] < 41.87 && +lat[2] > 41.87 && +lon[2] - +lon[1] < 1, subs.join(" "));
  check("GetCoverage: taglio sulla data del layer", subs[2] === 'time("2026-06-01")');
  await page.close();

  // ============================================================ errori
  console.log("\n== errori ==");
  page = await open(hashFor(VIEW, [["iride:parcels", 1, "", "", ""]]));
  await waitFor(async () => (await page.locator(".active-card").count()) === 1);
  await page.route("**/geoserver/ows?*outputFormat=application%2Fjson*", (route) =>
    route.request().url().includes("resultType") ? route.continue() : route.fulfill({ status: 200, contentType: "application/vnd.ogc.se_xml", body: "<ServiceException>Memoria esaurita nel generare la risposta</ServiceException>" }));
  await page.locator('.active-card [title="Scarica dati"]').click();
  await waitFor(async () => /oggetti$/.test(await countText(page)));
  await page.locator('.float-panel.download button:has-text("Scarica")').click();
  check("errore di GeoServer mostrato nel pannello", await waitFor(async () => /Scarico non riuscito: Memoria esaurita/.test(await page.locator(".float-panel.download .error").innerText())));
  await page.locator('.float-panel.download [aria-label="Chiudi lo scarico"]').click();
  check("chiusura del pannello", (await page.locator(".float-panel.download").count()) === 0);
  await page.close();

  await sleep(100);
  check("nessun errore JS/console", errors.length === 0, errors.slice(0, 5).join(" | "));
  await browser.close();
  finish();
})().catch(crash);
