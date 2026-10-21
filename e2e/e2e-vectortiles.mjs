// Disegno vettoriale (vector tiles): per i layer vettoriali, se GeoServer offre il formato MVT, si sceglie "Immagine"
// o "Vettoriale"; in vettoriale i tile arrivano in MVT, passando il mouse si vede l'oggetto (senza GetFeatureInfo),
// il filtro vale anche qui, la scelta resta nel link; senza l'estensione in GeoServer la scelta non compare.
import { J, MOCK, crash, launchBrowser, prepare, results, shot, startNginx, waitFor } from "./lib.mjs";

const { check, finish } = results();
const link = (render) => "/#s=" + encodeURIComponent(JSON.stringify({ v: [12.42, 41.8675, 13], l: [["iride:parcels", 1, "", "", "", ...(render ? [render] : [])]] }));
const mvtRequests = async () => (await J("/__log")).filter((l) => /request=GetMap/.test(l.query) && decodeURIComponent(l.query).includes("format=application/vnd.mapbox-vector-tile"));
const pngRequests = async () => (await J("/__log")).filter((l) => /request=GetMap/.test(l.query) && /format=image\/png/.test(decodeURIComponent(l.query)));

(async () => {
  prepare();
  await J("/__reset");
  const F = startNginx("VT", 8074, {
    AUTH_ENABLED: "false", GEOSERVER_PROXY_URL: `${MOCK}/geoserver`, GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass",
    BASEMAP_TILES: `${MOCK}/tiles/{z}/{x}/{y}.png`, BASEMAPS: `osm|Mappa|${MOCK}/tiles/{z}/{x}/{y}.png|© test`,
    APP_TITLE: "Test vector tiles", MAP_CENTER_LON: "12.42", MAP_CENTER_LAT: "41.8675", MAP_ZOOM: "13", GEOCODER: "off", USAGE_STATS: "off",
  });
  const browser = await launchBrowser();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 850 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  const card = page.locator(".active-card").first();
  const sw = card.locator('[role="radiogroup"]');
  const tip = page.locator(".vt-tip");
  /** Mouse al centro della mappa, dove c'è la prima particella. */
  const hoverCenter = async () => {
    const b = await page.locator(".map-el").boundingBox();
    await page.mouse.move(b.x + b.width / 2 - 5, b.y + b.height / 2 - 5);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  };
  // solo il frammento cambia: senza reload l'app non si riaprirebbe
  const open = async (path) => { await page.goto(F.url + path); await page.reload(); await page.waitForSelector(".active-card", { timeout: 15000 }); };

  // ============================================================ scelta del disegno
  console.log("\n== immagine o vettoriale ==");
  await open(link());
  check("GeoServer offre MVT: scelta 'Disegno' sul layer vettoriale, immagine di default", await waitFor(async () => (await sw.count()) === 1) &&
    (await sw.locator('[aria-checked="true"]').innerText()) === "Immagine");
  await hoverCenter();
  await page.waitForTimeout(300);
  check("in immagine nessun riquadro al passaggio del mouse", (await tip.count()) === 0);
  await sw.locator('button:has-text("Vettoriale")').click();
  check("in vettoriale i tile arrivano in MVT", await waitFor(async () => (await mvtRequests()).length > 0));
  await page.waitForTimeout(500);
  await hoverCenter();
  check("passando il mouse: l'oggetto con titolo e attributi, senza GetFeatureInfo", await waitFor(async () => /Particella 1/.test(await tip.innerText().catch(() => ""))) &&
    /Particelle/.test(await tip.innerText()) && /kind\s*A/.test(await tip.innerText()) && !(await J("/__log")).some((l) => /GetFeatureInfo/i.test(l.query)));
  check("legenda: colore del disegno vettoriale", /disegno vettoriale/.test(await page.locator(".legend-panel").innerText()));
  check("il link ricorda il disegno vettoriale", await waitFor(async () => JSON.parse(decodeURIComponent(new URL(page.url()).hash.slice(3))).l[0][5] === "v"));
  await page.screenshot({ path: shot("vectortiles.png") });

  // ============================================================ filtro e ricaricamento
  console.log("\n== filtro, link, ritorno all'immagine ==");
  await card.locator('.filterbox input.search').first().fill("kind = 'B'");
  await card.locator('.filterbox button:has-text("Applica")').first().click();
  check("filtro anche sui vector tile", await waitFor(async () => (await mvtRequests()).some((l) => decodeURIComponent(l.query).includes("cql_filter=kind = 'B'"))));
  await page.mouse.move(5, 5);
  await page.waitForTimeout(600);
  await hoverCenter();
  await page.waitForTimeout(400);
  check("con il filtro la particella di tipo A non c'è più", (await tip.count()) === 0);
  await open(link("v"));
  check("dal link: si riapre in vettoriale", (await sw.locator('[aria-checked="true"]').innerText()) === "Vettoriale");
  await page.waitForTimeout(600);
  await hoverCenter();
  check("e il passaggio del mouse funziona subito", await waitFor(async () => /Particella 1/.test(await tip.innerText().catch(() => ""))));
  const pngBefore = (await pngRequests()).length;
  await sw.locator('button:has-text("Immagine")').click();
  check("di nuovo immagine: tile PNG con lo stile di GeoServer, niente riquadro", await waitFor(async () => (await pngRequests()).length > pngBefore) && await waitFor(async () => (await tip.count()) === 0));

  // ============================================================ senza estensione
  console.log("\n== GeoServer senza vector tiles ==");
  await J("/__mvt?off=1");
  await open(link("v"));
  await page.waitForTimeout(500);
  check("nessuna scelta di disegno; un link vettoriale si apre come immagine", (await sw.count()) === 0 && (await pngRequests()).length > 0);
  await J("/__mvt?off=0");

  check("nessun errore JS/console durante i test", errors.length === 0, errors.slice(0, 5).join(" | "));
  await browser.close();
  finish();
})().catch(crash);
