// Cache dei tile in nginx: la stessa GetMap la seconda volta arriva dal disco (più veloce, GeoServer non la vede),
// filtro/data/contatore danno tile diversi, eccezioni WMS e richieste che non sono tile non si salvano, niente cache
// senza credenziali di lettura fisse; tiled=true per GeoWebCache con WMS_TILED.
import fs from "node:fs";
import path from "node:path";
import { J, MOCK, crash, launchBrowser, prepare, results, startNginx, waitFor } from "./lib.mjs";

const { check, finish } = results();
const asRole = (roles, user = "bob") => J(`/__kc?user=${user}&roles=${encodeURIComponent(roles)}`);
const BBOX = "1335833.8895192828,5009377.085697312,1345617.8291366976,5019161.025314727";
const getmap = (base, extra = "") => `${base}/geoserver/wms?service=WMS&version=1.1.1&request=GetMap&layers=iride%3Aparcels&styles=&format=image/png&transparent=true&srs=EPSG:3857&width=256&height=256${extra}&bbox=${BBOX}`;
const upstream = async (needle) => (await J("/__log")).filter((l) => l.path.endsWith("/wms") && decodeURIComponent(l.query).includes(needle)).length;
const timed = async (url) => { const t = Date.now(); const r = await fetch(url); const b = Buffer.from(await r.arrayBuffer()); return { status: r.status, type: r.headers.get("content-type"), ms: Date.now() - t, bytes: b.length }; };
const cacheLog = (inst) => fs.readFileSync(path.join(inst.d, "access.log"), "utf8").trim().split("\n").filter((l) => /request=GetMap/.test(l)).map((l) => l.match(/cache=(\S+)/)?.[1]);

(async () => {
  prepare();
  await J("/__reset");
  const base = {
    AUTH_ENABLED: "false", GEOSERVER_PROXY_URL: `${MOCK}/geoserver`,
    BASEMAP_TILES: `${MOCK}/tiles/{z}/{x}/{y}.png`, BASEMAPS: `osm|Mappa|${MOCK}/tiles/{z}/{x}/{y}.png|© test`,
    APP_TITLE: "Test tile", MAP_CENTER_LON: "12.05", MAP_CENTER_LAT: "41.0", MAP_ZOOM: "12", GEOCODER: "off",
  };
  const C = startNginx("TC", 8076, { ...base, GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass", TILE_CACHE: "true", TILE_CACHE_TTL: "1h", WMS_TILED: "true" });
  const P = startNginx("TP", 8075, { ...base, TILE_CACHE: "true" }); // nessuna credenziale fissa: il browser manda la sua (qui nessuna)
  await J("/__slow?ms=400");

  // ============================================================ stessa richiesta
  console.log("\n== stessa GetMap due volte ==");
  const u = getmap(C.url);
  const a = await timed(u);
  const b = await timed(u);
  check("prima: da GeoServer (lenta), immagine PNG", a.status === 200 && /^image\/png/.test(a.type) && a.ms >= 400, `${a.ms} ms`);
  check("seconda: dalla cache (veloce, stessa immagine), GeoServer non la vede", b.status === 200 && b.ms < 200 && b.bytes === a.bytes && (await upstream(`bbox=${BBOX}`)) === 1, `${b.ms} ms`);
  check("nel log: MISS poi HIT", JSON.stringify(cacheLog(C).slice(0, 2)) === JSON.stringify(["MISS", "HIT"]));

  // ============================================================ chiavi diverse
  console.log("\n== richieste diverse ==");
  await timed(getmap(C.url, "&cql_filter=kind%20%3D%20%27A%27"));
  await timed(getmap(C.url, "&_r=2"));
  check("filtro CQL e contatore dopo una modifica: tile nuovi (vanno a GeoServer)", (await upstream("kind = 'A'")) === 1 && (await upstream("_r=2")) === 1);
  const req = (p) => fetch(`${C.url}/geoserver/${p}`).then((r) => r.text());
  await req("ows?service=WMS&version=1.3.0&request=GetCapabilities"); await req("ows?service=WMS&version=1.3.0&request=GetCapabilities");
  check("GetCapabilities non va in cache", (await J("/__log")).filter((l) => /request=GetCapabilities/i.test(l.query) && /service=WMS/.test(l.query)).length === 2);
  const bad = `${C.url}/geoserver/wms?service=WMS&version=1.1.1&request=GetMap&layers=iride%3Anonesiste&styles=&format=image/png&srs=EPSG:3857&width=256&height=256&bbox=${BBOX}`;
  const e1 = await fetch(bad); const t1 = await e1.text(); await fetch(bad).then((r) => r.text());
  check("eccezione WMS (200, XML) non salvata: la seconda torna a GeoServer", e1.status === 200 && /ServiceException/.test(t1) && (await upstream("nonesiste")) === 2);

  // ============================================================ senza credenziali fisse
  console.log("\n== senza credenziali di lettura fisse ==");
  const pu = getmap(P.url, "&x=1");
  await timed(pu); await timed(pu);
  const pl = fs.readFileSync(path.join(P.d, "access.log"), "utf8").trim().split("\n").filter((l) => l.includes("x=1"));
  check("cache spenta: entrambe a GeoServer (log nginx: upstream contattato, nessuno stato di cache)", pl.length === 2 && pl.every((l) => /upstream=127\.0\.0\.1:8600/.test(l) && /cache=-$/.test(l)));

  // ============================================================ nel browser
  console.log("\n== nel browser (WMS_TILED) ==");
  await J("/__slow?ms=0");
  const browser = await launchBrowser();
  const errors = [];
  const open = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
    await page.goto(C.url + "/#s=" + encodeURIComponent(JSON.stringify({ v: [12.05, 41.0, 12], l: [["iride:parcels", 1, "", ""]] })));
    await page.waitForSelector(".active-card", { timeout: 15000 });
    return { ctx, page };
  };
  await asRole("x", "bob");
  const first = await open();
  const tileReq = () => first.page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /request=GetMap/.test(n)));
  check("le GetMap del browser hanno tiled=true", await waitFor(async () => { const l = await tileReq(); return l.length > 0 && l.every((n) => n.includes("tiled=true")); }));
  await first.page.waitForTimeout(800);
  const upAfterFirst = (await J("/__log")).filter((l) => /request=GetMap/.test(l.query) && /tiled=true/.test(l.query)).length;
  await first.ctx.close();
  const second = await open();
  await second.page.waitForTimeout(1500);
  const upAfterSecond = (await J("/__log")).filter((l) => /request=GetMap/.test(l.query) && /tiled=true/.test(l.query)).length;
  check("un secondo utente sulla stessa vista: tile dalla cache, nessuna nuova richiesta a GeoServer", upAfterFirst > 0 && upAfterSecond === upAfterFirst, `${upAfterFirst} -> ${upAfterSecond}`);
  await second.ctx.close();

  check("nessun errore JS/console durante i test", errors.length === 0, errors.slice(0, 5).join(" | "));
  await browser.close();
  finish();
})().catch(crash);
