// Metriche per Prometheus con un utente vero nel browser: /metrics sulla porta dedicata (mai su quella dell'app) in formato
// valido; pagine, configurazione, asset e richieste a GeoServer contate per area e per richiesta OGC mentre si usa la mappa
// (tile, Feature Info, dashboard); tempi delle GetMap con GeoServer lento sopra i 250 ms, dalla cache sotto; le chiamate a
// GeoServer misurate da nginx sono esattamente quelle che GeoServer ha ricevuto; contatori che crescono soltanto;
// METRICS=false. Serve il modulo njs di nginx (NGINX_JS_MODULE per un percorso diverso).
import { J, MOCK, NJS_MODULE, crash, launchBrowser, prepare, results, startNginx, waitFor } from "./lib.mjs";
import { histogram, parsePrometheus, sample } from "./prom.mjs";

if (!NJS_MODULE) {
  console.log("SKIP  e2e-metrics: modulo njs di nginx non trovato (Debian/Ubuntu: apt-get install libnginx-mod-http-js; altrove NGINX_JS_MODULE=percorso)");
  process.exit(process.env.E2E_REQUIRE_NJS === "1" ? 1 : 0);
}

const { check, finish } = results();
const VIEW = [12.42, 41.8675, 12];
const hashFor = (l) => "#s=" + encodeURIComponent(JSON.stringify({ v: VIEW, l }));
const base = {
  AUTH_ENABLED: "false", GEOSERVER_PROXY_URL: `${MOCK}/geoserver`, GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass",
  BASEMAP_TILES: `${MOCK}/tiles/{z}/{x}/{y}.png`, BASEMAPS: `osm|Mappa|${MOCK}/tiles/{z}/{x}/{y}.png|© test`,
  APP_TITLE: "Test metriche", MAP_CENTER_LON: String(VIEW[0]), MAP_CENTER_LAT: String(VIEW[1]), MAP_ZOOM: String(VIEW[2]), GEOCODER: "off", USAGE_STATS: "off",
};
const scrape = async (inst) => {
  const r = await fetch(inst.metricsUrl + "/metrics");
  const text = await r.text();
  return { status: r.status, type: r.headers.get("content-type"), text, m: parsePrometheus(text) };
};
/** Chiamate che GeoServer (finto) ha ricevuto: tutte passano da nginx. */
const gsCalls = async () => (await J("/__log")).filter((l) => l.path.startsWith("/geoserver/")).length;
/** Ogni contatore e ogni conteggio di istogramma di `b` è >= quello di `a` (le serie nuove partono da zero). */
const neverDecreases = (a, b) => {
  const bad = [];
  for (const [name, f] of a) {
    if (f.type !== "counter" && f.type !== "histogram") continue;
    for (const s of f.samples) {
      if (f.type === "histogram" && s.name.endsWith("_sum")) continue;
      const after = b.get(name)?.samples.find((x) => x.name === s.name && JSON.stringify(x.labels) === JSON.stringify(s.labels));
      if (!after || after.value < s.value) bad.push(`${s.name}${JSON.stringify(s.labels)}: ${s.value} -> ${after?.value}`);
    }
  }
  return bad;
};

(async () => {
  prepare();
  await J("/__reset");
  const S = startNginx("MET", 8177, { ...base, TILE_CACHE: "true", TILE_CACHE_TTL: "1h", EDIT_ENABLED: "true" });

  // ============================================================ endpoint
  console.log("\n== endpoint ==");
  const s0 = await scrape(S);
  check("/metrics sulla porta dedicata: 200, text/plain 0.0.4, formato valido per Prometheus", s0.status === 200 && s0.type === "text/plain; version=0.0.4; charset=utf-8");
  const families = ["gema_http_requests_total", "gema_http_request_duration_seconds", "gema_http_response_bytes_total", "gema_upstream_response_duration_seconds",
    "gema_geoserver_requests_total", "gema_geoserver_request_duration_seconds", "gema_tile_cache_requests_total", "gema_nginx_connections", "gema_metrics_zone_free_bytes"];
  check("tutte le famiglie dichiarate (HELP e TYPE) già prima del traffico", families.every((f) => s0.m.has(f) && s0.m.get(f).help), families.filter((f) => !s0.m.has(f)).join(", "));
  check("nessuna richiesta contata prima dell'uso (le letture di /metrics non contano)", sample(s0.m, "gema_http_requests_total") === 0);
  check("sulla porta dell'app /metrics non esiste (404)", (await fetch(S.url + "/metrics")).status === 404);

  // ============================================================ mappa nel browser
  console.log("\n== mappa nel browser ==");
  await J("/__slow?ms=250");
  const browser = await launchBrowser();
  const errors = [];
  const open = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
    await page.goto(S.url + "/" + hashFor([["iride:parcels", 1, "", ""]]));
    await page.waitForSelector(".active-card", { timeout: 15000 });
    return { ctx, page };
  };
  const tilesSettled = async (page) => {
    // le GetMap della vista sono finite quando il numero di risorse caricate smette di crescere
    let last = -1;
    await waitFor(async () => {
      const n = await page.evaluate(() => performance.getEntriesByType("resource").filter((e) => /request=GetMap/.test(e.name)).length);
      const same = n > 0 && n === last;
      last = n;
      await new Promise((r) => setTimeout(r, 600));
      return same;
    }, 20000);
  };
  const first = await open();
  await tilesSettled(first.page);
  const s1 = await scrape(S);
  const n1 = (l) => sample(s1.m, "gema_http_requests_total", l);
  check("pagina, configurazione e asset contati per area", n1({ route: "app", status: "200" }) >= 1 && n1({ route: "config", status: "200" }) >= 1 && n1({ route: "assets", status: "200" }) >= 1,
    `app=${n1({ route: "app" })} config=${n1({ route: "config" })} assets=${n1({ route: "assets" })}`);
  const getmap1 = histogram(s1.m, "gema_geoserver_request_duration_seconds", { request: "GetMap" });
  check("GeoServer per richiesta OGC: capabilities e GetMap della vista", sample(s1.m, "gema_geoserver_requests_total", { request: "GetCapabilities" }) >= 1 && getmap1.count >= 1, `GetMap=${getmap1.count}`);
  const miss1 = sample(s1.m, "gema_tile_cache_requests_total", { status: "MISS" });
  check("GeoServer lento (250 ms): le GetMap non in cache stanno sopra 0.25 s nell'istogramma", miss1 >= 1 && getmap1.count - (getmap1.buckets["0.25"] ?? 0) >= miss1 && getmap1.sum >= 0.25 * miss1,
    `count=${getmap1.count} le0.25=${getmap1.buckets["0.25"]} MISS=${miss1} sum=${getmap1.sum}`);
  const up1 = histogram(s1.m, "gema_upstream_response_duration_seconds", { route: "geoserver" });
  const calls1 = await gsCalls();
  check("le chiamate a GeoServer misurate da nginx sono esattamente quelle ricevute da GeoServer", up1.count === calls1 && up1.sum >= 0.25 * miss1, `nginx=${up1.count} GeoServer=${calls1}`);

  // ============================================================ secondo utente: tile dalla cache
  console.log("\n== secondo utente, stessa vista ==");
  const second = await open();
  await tilesSettled(second.page);
  const s2 = await scrape(S);
  const getmap2 = histogram(s2.m, "gema_geoserver_request_duration_seconds", { request: "GetMap" });
  const hits = sample(s2.m, "gema_tile_cache_requests_total", { status: "HIT" });
  check("le GetMap del secondo utente arrivano dalla cache (HIT) e sono veloci (sotto 0.1 s)", hits >= 1 && (getmap2.buckets["0.1"] ?? 0) - (getmap1.buckets["0.1"] ?? 0) >= hits - sample(s1.m, "gema_tile_cache_requests_total", { status: "HIT" }),
    `HIT=${hits} le0.1: ${getmap1.buckets["0.1"]} -> ${getmap2.buckets["0.1"]}`);
  const calls2 = await gsCalls();
  check("i tile dalla cache non contano come tempo di GeoServer (upstream = chiamate ricevute)", histogram(s2.m, "gema_upstream_response_duration_seconds", { route: "geoserver" }).count === calls2,
    `nginx=${histogram(s2.m, "gema_upstream_response_duration_seconds", { route: "geoserver" }).count} GeoServer=${calls2}`);
  await second.ctx.close();

  // ============================================================ Feature Info e dashboard
  console.log("\n== Feature Info e dashboard ==");
  await J("/__slow?ms=0");
  const page = first.page;
  const b = await page.locator(".map-el").boundingBox();
  await page.locator('button.tool[title="Interroga oggetti (Feature Info)"]').click();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await waitFor(async () => /Particella/.test(await page.locator(".float-panel").innerText().catch(() => "")));
  await page.locator('.active-card [title="Dashboard"]').click();
  await waitFor(async () => /oggetti in vista/i.test(await page.locator(".kpis").innerText().catch(() => "")));
  // i dati della dashboard arrivano dopo le etichette: si aspetta che nginx abbia contato la GetFeature
  const s3 = await waitFor(async () => { const s = await scrape(S); return sample(s.m, "gema_geoserver_requests_total", { request: "GetFeature", status: "200" }) >= 1 ? s : false; }) || (await scrape(S));
  check("Feature Info contata come GetFeatureInfo", sample(s3.m, "gema_geoserver_requests_total", { request: "GetFeatureInfo", status: "200" }) >= 1);
  check("i dati della dashboard contati come GetFeature (WFS)", sample(s3.m, "gema_geoserver_requests_total", { request: "GetFeature", status: "200" }) >= 1);
  check("nessun errore di GeoServer né del proxy (5xx)", sample(s3.m, "gema_geoserver_requests_total", { status: "500" }) + sample(s3.m, "gema_geoserver_requests_total", { status: "502" }) === 0);

  // ============================================================ nel tempo
  console.log("\n== nel tempo ==");
  const bad = [...neverDecreases(s0.m, s1.m), ...neverDecreases(s1.m, s2.m), ...neverDecreases(s2.m, s3.m)];
  check("tra una lettura e l'altra contatori e conteggi crescono soltanto (rate() di Prometheus li usa così)", bad.length === 0, bad.slice(0, 3).join(" | "));
  const before = sample(s3.m, "gema_http_requests_total", { route: "config" });
  for (let k = 0; k < 5; k++) await fetch(S.url + "/config.json").then((r) => r.arrayBuffer());
  check("cinque richieste in più: il contatore sale esattamente di cinque", sample((await scrape(S)).m, "gema_http_requests_total", { route: "config" }) - before === 5);
  const conn = sample(s3.m, "gema_nginx_connections", { state: "active" });
  check("connessioni di nginx esposte (stub_status)", conn >= 1 && sample(s3.m, "gema_nginx_requests_total") > sample(s3.m, "gema_http_requests_total"));
  await first.ctx.close();

  // ============================================================ METRICS=false
  console.log("\n== METRICS=false ==");
  const OFF = startNginx("METOFF", 8178, { ...base, METRICS: "false" });
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const p2 = await ctx.newPage();
  p2.on("pageerror", (e) => errors.push("pageerror (METRICS=false): " + e.message));
  await p2.goto(OFF.url + "/" + hashFor([["iride:parcels", 1, "", ""]]));
  check("METRICS=false: l'app funziona", !!(await p2.waitForSelector(".active-card", { timeout: 15000 }).catch(() => null)));
  check("METRICS=false: nessuna porta delle metriche, /metrics 404 sull'app", OFF.metricsUrl === "" && (await fetch("http://127.0.0.1:9178/metrics").then(() => false, () => true)) && (await fetch(OFF.url + "/metrics")).status === 404);
  await ctx.close();

  check("nessun errore JS/console durante i test", errors.length === 0, errors.slice(0, 5).join(" | "));
  await browser.close();
  finish();
})().catch(crash);
