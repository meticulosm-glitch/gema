// Modulo njs delle metriche (nginx/metrics.js) eseguito in Node con un `ngx` finto: classificazione delle richieste,
// istogrammi dei tempi, esposizione in formato Prometheus valida, robustezza (zona piena, valori arbitrari dal client).
// Con nginx e njs veri: test/integration/metrics.int.test.ts ed e2e/e2e-metrics.mjs.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error modulo JavaScript senza tipi (lo stesso file che carica nginx)
import M from "../nginx/metrics.js";
// @ts-expect-error modulo JavaScript senza tipi
import { histogram, parsePrometheus, sample } from "../e2e/prom.mjs";

type Vars = Record<string, string | undefined>;
type Families = Map<string, { type: string; samples: { name: string; labels: Record<string, string>; value: number }[] }>;

/** Zona condivisa finta con la stessa semantica di ngx.shared (tipo number). */
class FakeDict {
  m = new Map<string, number>();
  full = false;
  capacity = 4 * 1024 * 1024;
  incr(k: string, delta: number, init = 0) {
    if (this.full && !this.m.has(k)) throw new Error("SharedMemoryError: no memory");
    const v = (this.m.has(k) ? this.m.get(k)! : init) + delta;
    this.m.set(k, v);
    return v;
  }
  items(max = 1024) { return [...this.m.entries()].slice(0, max); }
  freeSpace() { return this.capacity - this.m.size * 128; }
}

const g = globalThis as unknown as { ngx?: unknown };
let dict: FakeDict;
let fetchResult: () => Promise<{ status: number; text: () => Promise<string> }>;
const STUB = "Active connections: 3 \nserver accepts handled requests\n 10 9 42 \nReading: 0 Writing: 1 Waiting: 2 \n";

beforeEach(() => {
  dict = new FakeDict();
  fetchResult = async () => ({ status: 200, text: async () => STUB });
  g.ngx = { shared: { gema_metrics: dict }, fetch: (url: string) => { fetched.push(url); return fetchResult(); } };
  fetched.length = 0;
});
afterEach(() => { delete g.ngx; });
const fetched: string[] = [];

const req = (v: Vars) => M.record({ variables: { request_method: "GET", status: "200", request_time: "0.010", body_bytes_sent: "100", ...v } });
async function scrape(vars: Vars = { server_addr: "10.1.2.3", server_port: "9145" }): Promise<{ text: string; status: number; headers: Record<string, string>; m: Families }> {
  const r = { variables: vars, headersOut: {} as Record<string, string>, status: 0, body: "", return(s: number, b: string) { this.status = s; this.body = b; } };
  await M.render(r);
  return { text: r.body, status: r.status, headers: r.headersOut, m: parsePrometheus(r.body) };
}

describe("metrics.js: classificazione", () => {
  it.each([
    ["/geoserver/wms", "geoserver"], ["/geoserver/gwc/service/wmts", "geoserver"], ["/geocode/search", "geocode"], ["/api/x", "api"],
    ["/assets/index-abc.js", "assets"], ["/config.json", "config"], ["/", "app"], ["/index.html", "app"],
    ["/client-errors", "reports"], ["/logos/a.svg", "static"], ["/geoserver", "static"], ["", "static"],
  ])("area di %s: %s", (uri, a) => expect(M.area(uri)).toBe(a));

  it.each([
    ["/geoserver/wms", "GET", "GetMap", "GetMap"], ["/geoserver/ows", "GET", "getfeatureinfo", "GetFeatureInfo"],
    ["/geoserver/wfs", "GET", "GETFEATURE", "GetFeature"], ["/geoserver/wcs", "GET", "GetCoverage", "GetCoverage"],
    ["/geoserver/wfs", "POST", "", "Transaction"], ["/geoserver/wfs", "POST", "GetFeature", "GetFeature"],
    ["/geoserver/ows", "POST", "", "other"], ["/geoserver/gwc/service/wmts", "GET", "GetTile", "gwc"],
    ["/geoserver/wms", "GET", "Ciao", "other"], ["/geoserver/wms", "GET", "constructor", "other"], ["/geoserver/wms", "GET", "__proto__", "other"],
    ["/geoserver/rest/about", "GET", "", "other"],
  ])("richiesta OGC di %s %s request=%s: %s", (uri, method, request, q) => expect(M.ogcRequest(uri, method, request)).toBe(q));

  it("tempo dell'upstream: uno, più tentativi, redirect interni, nessuno", () => {
    expect(M.upstreamSeconds("0.402")).toBeCloseTo(0.402);
    expect(M.upstreamSeconds("0.001, 0.402")).toBeCloseTo(0.403);
    expect(M.upstreamSeconds("0.100 : 0.200")).toBeCloseTo(0.3);
    expect(M.upstreamSeconds("-")).toBeNull();
    expect(M.upstreamSeconds("")).toBeNull();
    expect(M.upstreamSeconds(undefined)).toBeNull();
  });

  it("bucket: il limite stesso è compreso (le = minore o uguale), oltre 60 s è +Inf", () => {
    expect(M.BUCKETS[0]).toBe(0.005);
    expect(M.bucketIndex(0)).toBe(0);
    expect(M.bucketIndex(0.005)).toBe(0);
    expect(M.bucketIndex(0.0051)).toBe(1);
    expect(M.bucketIndex(0.25)).toBe(M.BUCKETS.indexOf(0.25));
    expect(M.bucketIndex(60)).toBe(M.BUCKETS.length - 1);
    expect(M.bucketIndex(61)).toBe(M.BUCKETS.length);
    expect([...M.BUCKETS].sort((a: number, b: number) => a - b)).toEqual(M.BUCKETS);
  });
});

describe("metrics.js: registrazione ed esposizione", () => {
  it("vuota: tutte le famiglie con HELP e TYPE, connessioni e spazio della zona, formato valido", async () => {
    const { text, status, headers, m } = await scrape();
    expect(status).toBe(200);
    expect(headers["Content-Type"]).toBe("text/plain; version=0.0.4; charset=utf-8");
    for (const [name, type] of M.FAMILIES) {
      expect(text).toContain(`# TYPE ${name} ${type}\n`);
      expect(text).toMatch(new RegExp(`# HELP ${name} \\S`));
    }
    expect(sample(m, "gema_nginx_connections", { state: "active" })).toBe(3);
    expect(sample(m, "gema_nginx_connections", { state: "waiting" })).toBe(2);
    expect(sample(m, "gema_nginx_connections_accepted_total")).toBe(10);
    expect(sample(m, "gema_nginx_connections_handled_total")).toBe(9);
    expect(sample(m, "gema_nginx_requests_total")).toBe(42);
    expect(sample(m, "gema_metrics_zone_size_bytes")).toBe(4 * 1024 * 1024);
    expect(fetched).toEqual(["http://10.1.2.3:9145/stub_status"]); // stesso indirizzo e porta su cui è arrivata la richiesta
  });

  it("contatori per area, metodo e stato; byte; record non scrive mai la riga di log", () => {
    expect(req({ uri: "/index.html" })).toBe("");
    req({ uri: "/index.html" });
    req({ uri: "/config.json", body_bytes_sent: "300" });
    req({ uri: "/geoserver/wms", arg_request: "GetMap", status: "429", body_bytes_sent: "0" });
    req({ uri: "/assets/a.js", request_method: "BREW", status: "x" });
    const m = parsePrometheus(M.format(dict.items(1e6), null, null));
    expect(sample(m, "gema_http_requests_total", { route: "app", method: "GET", status: "200" })).toBe(2);
    expect(sample(m, "gema_http_requests_total", { route: "geoserver", status: "429" })).toBe(1);
    expect(sample(m, "gema_http_requests_total", { route: "assets", method: "OTHER", status: "000" })).toBe(1);
    expect(sample(m, "gema_http_response_bytes_total", { route: "app" })).toBe(200);
    expect(sample(m, "gema_http_response_bytes_total", { route: "config" })).toBe(300);
    expect(sample(m, "gema_http_response_bytes_total", { route: "geoserver" })).toBe(0); // nessuna serie con 0 byte
    expect(sample(m, "gema_geoserver_requests_total", { request: "GetMap", status: "429" })).toBe(1);
  });

  it("istogrammi dei tempi: bucket cumulativi, somma, conteggio; GeoServer per richiesta OGC; upstream solo se ha risposto", async () => {
    req({ uri: "/geoserver/wms", arg_request: "GetMap", request_time: "0.310", upstream_response_time: "0.300", upstream_status: "200", upstream_cache_status: "MISS" });
    req({ uri: "/geoserver/wms", arg_request: "GetMap", request_time: "0.000", upstream_response_time: "0.000", upstream_status: "-", upstream_cache_status: "HIT" }); // dalla cache
    req({ uri: "/geoserver/wfs", request_method: "POST", request_time: "1.200", upstream_response_time: "1.190", upstream_status: "200" });
    req({ uri: "/geoserver/wms", arg_request: "GetMap", status: "429", request_time: "0.000" }); // respinta dal limite: nessun upstream
    req({ uri: "/geocode/search", request_time: "0.050", upstream_response_time: "0.045", upstream_status: "200" });
    req({ uri: "/index.html", request_time: "0.001", upstream_response_time: "0.5", upstream_status: "200" }); // non è un upstream dell'app
    const { m } = await scrape();

    const all = histogram(m, "gema_http_request_duration_seconds", { route: "geoserver" });
    expect(all.count).toBe(4);
    expect(all.sum).toBeCloseTo(1.51, 6);
    expect(all.buckets["0.25"]).toBe(2);
    expect(all.buckets["0.5"]).toBe(3);
    expect(all.buckets["1"]).toBe(3);
    expect(all.buckets["2.5"]).toBe(4);
    expect(all.buckets["+Inf"]).toBe(4);

    const getmap = histogram(m, "gema_geoserver_request_duration_seconds", { request: "GetMap" });
    expect([getmap.count, getmap.buckets["0.005"], getmap.buckets["0.5"]]).toEqual([3, 2, 3]);
    expect(histogram(m, "gema_geoserver_request_duration_seconds", { request: "Transaction" }).count).toBe(1);

    const up = histogram(m, "gema_upstream_response_duration_seconds", { route: "geoserver" });
    expect(up.count).toBe(2); // MISS e transazione; non il tile dalla cache né il 429
    expect(up.sum).toBeCloseTo(1.49, 6);
    expect(histogram(m, "gema_upstream_response_duration_seconds", { route: "geocode" }).count).toBe(1);
    expect(histogram(m, "gema_upstream_response_duration_seconds", { route: "app" }).count).toBe(0);

    expect(sample(m, "gema_tile_cache_requests_total", { status: "MISS" })).toBe(1);
    expect(sample(m, "gema_tile_cache_requests_total", { status: "HIT" })).toBe(1);
  });

  it("valori arbitrari dal client (request, metodo) non creano etichette nuove né rompono il formato", async () => {
    for (const q of ['GetMap"}', "a\nb", "constructor", "x".repeat(500), "GetMap,status=\"1\""]) req({ uri: "/geoserver/wms", arg_request: q, request_method: 'G"ET' });
    req({ uri: '/geoserver/"evil"\n', arg_request: "GetMap" });
    const { text, m } = await scrape();
    const reqs = new Set(m.get("gema_geoserver_requests_total")!.samples.map((s) => s.labels.request));
    expect([...reqs].sort()).toEqual(["GetMap", "other"]);
    expect(text).not.toContain("evil");
    expect(text).not.toContain("xxxxx");
  });

  it("zona piena o variabili mancanti: la richiesta passa comunque (record restituisce \"\" senza eccezioni)", () => {
    dict.full = true;
    expect(req({ uri: "/index.html" })).toBe("");
    expect(M.record({ variables: undefined })).toBe("");
    delete g.ngx;
    expect(req({ uri: "/index.html" })).toBe("");
  });

  it("stub_status non raggiungibile o illeggibile: solo le metriche delle richieste", async () => {
    req({ uri: "/index.html" });
    fetchResult = async () => { throw new Error("connessione rifiutata"); };
    const a = await scrape();
    expect(a.status).toBe(200);
    expect(a.text).not.toContain("gema_nginx_connections");
    expect(sample(a.m, "gema_http_requests_total", { route: "app" })).toBe(1);
    fetchResult = async () => ({ status: 403, text: async () => "vietato" });
    expect((await scrape()).text).not.toContain("gema_nginx_connections");
    fetchResult = async () => ({ status: 200, text: async () => "altro" });
    expect((await scrape()).text).not.toContain("gema_nginx_connections");
  });

  it("indirizzo IPv6: tra parentesi quadre nella richiesta a stub_status", async () => {
    await scrape({ server_addr: "::1", server_port: "9145" });
    expect(fetched).toEqual(["http://[::1]:9145/stub_status"]);
  });

  it("parseStubStatus legge la pagina di nginx", () => {
    expect(M.parseStubStatus(STUB)).toEqual({ active: 3, accepted: 10, handled: 9, requests: 42, reading: 0, writing: 1, waiting: 2 });
    expect(M.parseStubStatus("")).toBeNull();
  });
});

describe("e2e/prom.mjs: il controllo del formato rifiuta ciò che Prometheus rifiuterebbe", () => {
  it.each([
    ["senza a capo finale", "# TYPE a counter\na 1"],
    ["campione senza TYPE", "a 1\n"],
    ["valore non numerico", "# TYPE a counter\na uno\n"],
    ["etichetta senza virgolette", "# TYPE a counter\na{x=1} 1\n"],
    ["serie duplicata", "# TYPE a counter\na{x=\"1\"} 1\na{x=\"1\"} 2\n"],
    ["istogramma senza +Inf", "# TYPE h histogram\nh_bucket{le=\"1\"} 1\nh_sum 1\nh_count 1\n"],
    ["bucket non cumulativi", "# TYPE h histogram\nh_bucket{le=\"1\"} 2\nh_bucket{le=\"+Inf\"} 1\nh_sum 1\nh_count 1\n"],
    ["_count diverso da +Inf", "# TYPE h histogram\nh_bucket{le=\"+Inf\"} 2\nh_sum 1\nh_count 1\n"],
  ])("%s", (_n, text) => expect(() => parsePrometheus(text)).toThrow());

  it("accetta un'esposizione corretta", () => {
    const m = parsePrometheus('# HELP a x\n# TYPE a counter\na{x="1",y="a\\"b"} 3\n# TYPE h histogram\nh_bucket{le="0.5"} 1\nh_bucket{le="+Inf"} 2\nh_sum 0.7\nh_count 2\n');
    expect(sample(m, "a", { y: 'a"b' })).toBe(3);
    expect(histogram(m, "h")).toEqual({ buckets: { "0.5": 1, "+Inf": 2 }, sum: 0.7, count: 2 });
  });
});
