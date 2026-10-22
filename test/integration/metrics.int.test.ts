// nginx reale con njs: metriche per Prometheus generate da 50-metrics-config.sh e nginx/metrics.js, davanti a un upstream
// HTTP locale che risponde con ritardi noti al posto di GeoServer (e, se configurato, davanti a GeoServer vero).
// Ogni combinazione di configurazione passa `nginx -t`; conteggi esatti per area, metodo, stato e richiesta OGC; tempi
// nei bucket giusti; upstream solo quando ha risposto davvero; cache dei tile; 429; contatori condivisi tra più worker,
// che crescono nel tempo e restano dopo un reload; /metrics solo sulla porta dedicata.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { ROOT, gs, hasNginx, required } from "./support";

type Inst = { d: string; url: string; metricsUrl: string; stop: () => void };
type Lib = { startNginx: (n: string, p: number, e: Record<string, string>, o?: { workers?: number }) => Inst; stopAll: () => void; NJS_MODULE: string | null };
type Fam = Map<string, { type: string; samples: { name: string; labels: Record<string, string>; value: number }[] }>;
type Prom = { parsePrometheus: (t: string) => Fam; sample: (m: Fam, n: string, l?: Record<string, string>) => number; histogram: (m: Fam, n: string, l?: Record<string, string>) => { buckets: Record<string, number>; sum: number; count: number } };
// e2e/lib.mjs avvia nginx esattamente come nell'immagine (stessi script, stessa default.conf, modulo njs del sistema)
const lib = () => import("../../e2e/lib.mjs") as Promise<Lib>;
const prom = () => import("../../e2e/prom.mjs") as Promise<Prom>;

const built = fs.existsSync(path.join(ROOT, "dist/index.html"));
const { NJS_MODULE } = await lib();
if (required && !hasNginx) throw new Error("nginx non installato: serve a metrics.int.test.ts");
if (required && !NJS_MODULE) throw new Error("modulo njs di nginx non trovato (Debian/Ubuntu: apt-get install libnginx-mod-http-js; altrove NGINX_JS_MODULE=percorso): serve a metrics.int.test.ts");
if (required && !built) throw new Error("build mancante: esegui `npm run build` prima di metrics.int.test.ts");
const ready = hasNginx && !!NJS_MODULE && built;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = (u: string, init?: RequestInit) => fetch(u, init).then(async (r) => { await r.arrayBuffer(); return r.status; });

describe.skipIf(!ready)("nginx reale con njs: metriche per Prometheus", () => {
  let upstream: http.Server;
  let up = "";
  const seen: string[] = [];
  let L: Lib;
  let P: Prom;
  const base = () => ({ AUTH_ENABLED: "false", GEOSERVER_PROXY_URL: `${up}/geoserver`, GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass", GEOCODER: "off", BASEMAPS: `osm|Mappa|${up}/tiles/{z}/{x}/{y}.png|t` });
  const scrape = async (i: Inst) => {
    const r = await fetch(i.metricsUrl + "/metrics");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    return P.parsePrometheus(await r.text()); // lancia se il formato non è valido
  };

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      const u = new URL(req.url ?? "/", "http://x");
      const delay = Number(u.searchParams.get("delay") ?? 0);
      req.resume();
      req.on("end", () => setTimeout(() => {
        if (u.searchParams.get("fail")) { res.writeHead(500, { "Content-Type": "text/plain" }); res.end("errore"); return; }
        if (/getmap/i.test(u.searchParams.get("request") ?? "")) { res.writeHead(200, { "Content-Type": "image/png" }); res.end(Buffer.alloc(1000, 1)); return; }
        res.writeHead(200, { "Content-Type": "application/xml" });
        res.end("<ok/>");
      }, delay));
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    up = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    L = await lib();
    P = await prom();
  });
  afterAll(async () => { L?.stopAll(); await new Promise((r) => upstream?.close(r)); });

  it.each([
    ["default", {}, 8160],
    ["porta personalizzata, cache dei tile, scritture, log JSON, CSP report-only", { METRICS_PORT: "127.0.0.1:19161", TILE_CACHE: "true", EDIT_ENABLED: "true", ACCESS_LOG_FORMAT: "json", CSP: "report-only" }, 8161],
    ["tutto spento tranne le metriche", { CSP: "off", CLIENT_ERRORS: "false", RATE_LIMIT: "false" }, 8162],
  ] as [string, Record<string, string>, number][])("%s: nginx -t accetta la configurazione, /metrics risponde in formato valido", async (name, env, port) => {
    const i = L.startNginx(`INT-MET-${port}`, port, { ...base(), ...env }); // startNginx esegue nginx -t: lancia se non valida
    try {
      expect(i.metricsUrl).toBe(`http://${env.METRICS_PORT ?? `127.0.0.1:${port + 1000}`}`);
      expect(await get(i.url + "/")).toBe(200);
      const m = await scrape(i);
      expect(P.sample(m, "gema_http_requests_total", { route: "app", status: "200" })).toBe(1);
      expect(await get(i.url + "/metrics")).toBe(404); // mai sulla porta dell'app
    } finally { i.stop(); }
  });

  it("METRICS=false: nessun server delle metriche, l'app funziona e /metrics è 404", async () => {
    const i = L.startNginx("INT-MET-OFF", 8163, { ...base(), METRICS: "false" });
    try {
      expect(i.metricsUrl).toBe("");
      expect(await get(i.url + "/")).toBe(200);
      expect(await get(i.url + "/metrics")).toBe(404);
      await expect(fetch("http://127.0.0.1:9163/metrics")).rejects.toThrow();
      expect(fs.readFileSync(path.join(i.d, "proxy.d/metrics.main"), "utf8")).toBe("");
    } finally { i.stop(); }
  });

  it("conteggi, tempi, upstream, cache e limiti misurati su richieste note", async () => {
    const i = L.startNginx("INT-MET", 8164, { ...base(), TILE_CACHE: "true", EDIT_ENABLED: "true", GEOSERVER_RATE: "1r/s", GEOSERVER_BURST: "20" });
    try {
      const asset = fs.readdirSync(path.join(i.d, "html/assets")).find((f) => f.endsWith(".js"));
      for (const u of ["/", "/dashboards", "/admin/roles", "/config.json", `/assets/${asset}`, "/logos/gema-favicon.svg"]) expect([u, await get(i.url + u)]).toEqual([u, 200]);
      const gsu = (q: string) => `${i.url}/geoserver/wms?service=WMS&${q}`;
      seen.length = 0;
      expect(await get(gsu("request=GetMap&layers=a&delay=300"))).toBe(200);            // MISS, GeoServer lento
      expect(await get(gsu("request=GetMap&layers=a&delay=300"))).toBe(200);            // HIT, dalla cache: nessun upstream
      expect(await get(gsu("REQUEST=getfeatureinfo&delay=30"))).toBe(200);
      expect(await get(gsu("request=GetCapabilities"))).toBe(200);
      expect(await get(gsu("request=GetCapabilities&fail=1"))).toBe(500);
      expect(await get(`${i.url}/geoserver/wfs?delay=1200`, { method: "POST", body: "<wfs:Transaction/>" })).toBe(200);
      expect(seen.length).toBe(5);
      const burst = await Promise.all(Array.from({ length: 30 }, () => get(gsu("request=GetLegendGraphic"))));
      const limited = burst.filter((s) => s === 429).length;
      expect(limited).toBeGreaterThan(0);

      const m = await scrape(i);
      const n = (name: string, l: Record<string, string>) => P.sample(m, name, l);
      // per area
      expect(n("gema_http_requests_total", { route: "app", method: "GET", status: "200" })).toBe(3); // pagine della SPA = index.html
      expect(n("gema_http_requests_total", { route: "config" })).toBe(1);
      expect(n("gema_http_requests_total", { route: "assets" })).toBe(1);
      expect(n("gema_http_requests_total", { route: "static" })).toBe(1);
      expect(n("gema_http_requests_total", { route: "geoserver", method: "POST", status: "200" })).toBe(1);
      expect(n("gema_http_requests_total", { route: "geoserver", status: "429" })).toBe(limited);
      expect(n("gema_http_requests_total", { route: "geoserver" })).toBe(36);
      expect(n("gema_http_response_bytes_total", { route: "geoserver" })).toBeGreaterThanOrEqual(2000); // due PNG da 1000 byte
      // per richiesta OGC
      expect(n("gema_geoserver_requests_total", { request: "GetMap", status: "200" })).toBe(2);
      expect(n("gema_geoserver_requests_total", { request: "GetFeatureInfo", status: "200" })).toBe(1);
      expect(n("gema_geoserver_requests_total", { request: "GetCapabilities", status: "500" })).toBe(1);
      expect(n("gema_geoserver_requests_total", { request: "Transaction", status: "200" })).toBe(1);
      expect(n("gema_geoserver_requests_total", { request: "GetLegendGraphic" })).toBe(30);
      // tempi: il bucket giusto (le = minore o uguale)
      const getmap = P.histogram(m, "gema_geoserver_request_duration_seconds", { request: "GetMap" });
      expect(getmap.count).toBe(2);
      expect(getmap.buckets["0.25"]).toBe(1); // solo il HIT
      expect(getmap.buckets["0.5"]).toBe(2);
      expect(getmap.sum).toBeGreaterThanOrEqual(0.3);
      const fi = P.histogram(m, "gema_geoserver_request_duration_seconds", { request: "GetFeatureInfo" });
      expect([fi.buckets["0.025"], fi.buckets["0.25"]]).toEqual([0, 1]);
      const tx = P.histogram(m, "gema_geoserver_request_duration_seconds", { request: "Transaction" });
      expect([tx.buckets["1"], tx.buckets["2.5"], tx.count]).toEqual([0, 1, 1]);
      expect(tx.sum).toBeGreaterThanOrEqual(1.2);
      // upstream: solo le 5 richieste arrivate davvero (niente HIT, niente 429)
      const upst = P.histogram(m, "gema_upstream_response_duration_seconds", { route: "geoserver" });
      expect(upst.count).toBe(seen.length);
      expect(upst.sum).toBeGreaterThanOrEqual(1.53);
      expect(upst.buckets["0.25"]).toBe(seen.length - 2); // tutte tranne la GetMap lenta e la transazione
      // cache dei tile
      expect(n("gema_tile_cache_requests_total", { status: "MISS" })).toBe(1);
      expect(n("gema_tile_cache_requests_total", { status: "HIT" })).toBe(1);
      // connessioni
      expect(n("gema_nginx_connections", { state: "active" })).toBeGreaterThanOrEqual(1);
      expect(n("gema_nginx_requests_total", {})).toBeGreaterThanOrEqual(42);
      expect(n("gema_metrics_zone_free_bytes", {})).toBeGreaterThan(n("gema_metrics_zone_size_bytes", {}) * 0.9);

      // le richieste di /metrics non si contano; la porta delle metriche espone solo /metrics
      const again = await scrape(i);
      expect(P.sample(again, "gema_http_requests_total", {})).toBe(P.sample(m, "gema_http_requests_total", {}));
      expect(await get(i.metricsUrl + "/")).toBe(404);
      expect(await get(i.metricsUrl + "/metrics", { method: "POST" })).toBe(403);
      expect(await get(i.url + "/metrics")).toBe(404);
      expect(await (await fetch(i.url + "/stub_status")).text()).not.toContain("Active connections"); // solo sulla porta delle metriche
    } finally { i.stop(); }
  });

  it("più worker: contatori condivisi ed esatti, crescono nel tempo, restano dopo un reload di nginx", async () => {
    const i = L.startNginx("INT-MET-W", 8165, base(), { workers: 4 });
    try {
      const statuses = await Promise.all(Array.from({ length: 200 }, () => get(i.url + "/config.json")));
      expect(statuses.every((s) => s === 200)).toBe(true);
      const first = await scrape(i);
      expect(P.sample(first, "gema_http_requests_total", { route: "config" })).toBe(200);
      expect(P.histogram(first, "gema_http_request_duration_seconds", { route: "config" }).count).toBe(200);

      // nel tempo: altre richieste, l'aumento è esatto (è ciò che usa rate() in Prometheus)
      await Promise.all(Array.from({ length: 50 }, () => get(i.url + "/config.json")));
      const second = await scrape(i);
      expect(P.sample(second, "gema_http_requests_total", { route: "config" }) - P.sample(first, "gema_http_requests_total", { route: "config" })).toBe(50);

      // reload (nuova configurazione, nuovi worker): la memoria condivisa resta, i contatori non ripartono da zero
      process.kill(Number(fs.readFileSync(path.join(i.d, "nginx.pid"), "utf8").trim()), "SIGHUP");
      await sleep(800);
      expect(await get(i.url + "/config.json")).toBe(200);
      const third = await scrape(i);
      expect(P.sample(third, "gema_http_requests_total", { route: "config" })).toBe(251);
    } finally { i.stop(); }
  });

  describe.skipIf(!gs)("davanti a GeoServer vero", () => {
    it("GetCapabilities WMS e WFS: conteggi per richiesta e tempo di risposta di GeoServer", async () => {
      const G = gs!;
      const i = L.startNginx("INT-MET-GS", 8166, { AUTH_ENABLED: "false", GEOSERVER_PROXY_URL: G.url, GEOSERVER_USER: G.user, GEOSERVER_PASSWORD: G.password, GEOCODER: "off" });
      try {
        expect(await get(`${i.url}/geoserver/ows?service=WMS&version=1.3.0&request=GetCapabilities`)).toBe(200);
        expect(await get(`${i.url}/geoserver/ows?service=WFS&version=2.0.0&request=GetCapabilities`)).toBe(200);
        expect(await get(`${i.url}/geoserver/ows?service=WMS&version=1.3.0&request=GetMap&layers=non_esiste&crs=EPSG:4326&bbox=0,0,1,1&width=8&height=8&format=image/png`)).toBe(200);
        const m = await scrape(i);
        expect(P.sample(m, "gema_geoserver_requests_total", { request: "GetCapabilities", status: "200" })).toBe(2);
        expect(P.sample(m, "gema_geoserver_requests_total", { request: "GetMap" })).toBe(1);
        const upst = P.histogram(m, "gema_upstream_response_duration_seconds", { route: "geoserver" });
        expect(upst.count).toBe(3);
        expect(upst.sum).toBeGreaterThan(0);
      } finally { i.stop(); }
    });
  });
});
