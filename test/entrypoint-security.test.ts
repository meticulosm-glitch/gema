import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { defaultBasemaps } from "../src/basemaps";
import { runEntrypoint } from "./shell";

const CONFIG = JSON.stringify({
  geoserverUrl: "/geoserver",
  keycloak: { url: "https://sso.example.org/auth", realm: "r", clientId: "c" },
  basemapTiles: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  basemaps: [{ id: "orto", label: "Orto", tiles: "https://tiles.example.com:8443/wmts/{z}/{x}/{y}.jpg?key=1" }],
  terrainTiles: "",
  logo: "/logo.svg",
  partnerLogos: ["https://cdn.partner.it/logo.png", "/local.png"],
  note: "testo con https://ma non un url\"",
});
const run = (env: Record<string, string> = {}, config: string | null = CONFIG) =>
  runEntrypoint("45-security-config.sh", env, config === null ? {} : { preexistingConfig: config });
const csp = (inc: string | null) => inc?.match(/add_header Content-Security-Policy(?:-Report-Only)? "([^"]*)" always;/)?.[1] ?? "";
const directive = (policy: string, name: string) => policy.split(";").map((d) => d.trim()).find((d) => d.startsWith(name + " "))?.slice(name.length + 1).split(" ") ?? [];

describe("45-security-config.sh: intestazioni di sicurezza e CSP", () => {
  it("default: CSP applicata, solo questo sito più le origini di config.json ({s} -> *), nessuno stile o script inline", async () => {
    const r = await run();
    expect(r.code, r.stderr).toBe(0);
    const inc = r.securityInc ?? "";
    for (const h of ['X-Content-Type-Options "nosniff"', 'Referrer-Policy "strict-origin-when-cross-origin"', 'X-Frame-Options "SAMEORIGIN"', "Permissions-Policy \"geolocation=(self), camera=()"])
      expect(inc).toContain(`add_header ${h}`);
    expect(inc).toMatch(/add_header Content-Security-Policy "/);
    const p = csp(inc);
    const origins = ["https://*.tile.openstreetmap.org", "https://cdn.partner.it", "https://sso.example.org", "https://tiles.example.com:8443"];
    expect(directive(p, "default-src")).toEqual(["'self'"]);
    expect(directive(p, "script-src")).toEqual(["'self'"]);
    expect(directive(p, "style-src")).toEqual(["'self'"]);
    expect(directive(p, "connect-src")).toEqual(["'self'", ...origins]);
    expect(directive(p, "img-src")).toEqual(["'self'", "data:", "blob:", ...origins]);
    expect(directive(p, "worker-src")).toEqual(["'self'", "blob:"]);
    expect(directive(p, "frame-ancestors")).toEqual(["'self'"]);
    expect(directive(p, "object-src")).toEqual(["'none'"]);
    expect(directive(p, "base-uri")).toEqual(["'self'"]);
    expect(directive(p, "report-uri")).toEqual(["/csp-report"]);
    expect(p).not.toMatch(/unsafe|\s;|;;|"/);
    expect(r.stdout).toContain("CSP enforce: origini esterne consentite: " + origins.join(" "));
  });

  it("CSP_EXTRA_ORIGINS (spazi o virgole, anche con percorso) e valori non validi", async () => {
    const r = await run({ CSP_EXTRA_ORIGINS: "https://cdn.example.org/lib, http://wms.ente.it:8080/geoserver/wms  ftp://no" });
    const p = csp(r.securityInc);
    expect(directive(p, "connect-src")).toEqual(expect.arrayContaining(["https://cdn.example.org", "http://wms.ente.it:8080"]));
    expect(p).not.toContain("ftp");
    expect(r.stdout).toContain("CSP_EXTRA_ORIGINS: 'ftp://no' ignorata");
  });

  it("senza elenco di sfondi l'app offre satellite e scuro: i loro server sono consentiti (gli stessi di src/basemaps.ts)", async () => {
    const presets = defaultBasemaps("").filter((b) => b.tiles).map((b) => new URL(b.tiles!).origin);
    expect(readFileSync(new URL("../docker-entrypoint.d/45-security-config.sh", import.meta.url), "utf8")).toContain(`PRESET_ORIGINS="${presets.join(" ")}"`);
    const own = await run({}, JSON.stringify({ geoserverUrl: "/geoserver", basemapTiles: "/tiles/{z}/{x}/{y}.png" }));
    expect(directive(csp(own.securityInc), "connect-src")).toEqual(["'self'", ...[...presets].sort()]);
    // con BASEMAPS l'elenco è quello: niente server predefiniti
    expect(csp((await run()).securityInc)).not.toContain("arcgisonline");
  });

  it("solo sfondi locali: solo 'self', frame-src 'none'", async () => {
    const r = await run({}, JSON.stringify({ basemaps: [{ id: "a", tiles: "/t/{z}/{x}/{y}.png" }] }));
    expect(r.code, r.stderr).toBe(0);
    const p = csp(r.securityInc);
    expect(directive(p, "connect-src")).toEqual(["'self'"]);
    expect(directive(p, "frame-src")).toEqual(["'none'"]);
    expect(r.stdout).toContain("origini esterne consentite: nessuna");
  });

  it("CSP=report-only: solo segnalazioni; CSP=off: nessuna CSP né /csp-report; valore sconosciuto: enforce", async () => {
    const ro = await run({ CSP: "Report-Only" });
    expect(ro.securityInc).toContain('add_header Content-Security-Policy-Report-Only "');
    expect(ro.securityInc).not.toMatch(/Content-Security-Policy "/);
    expect(ro.securityConf).toContain("location = /csp-report {");
    const off = await run({ CSP: "off" });
    expect(off.securityInc).not.toContain("Content-Security-Policy");
    expect(off.securityInc).toContain("X-Frame-Options");
    expect(off.securityConf).not.toContain("/csp-report");
    expect(off.stdout).toContain("CSP spenta");
    const bad = await run({ CSP: "strict" });
    expect(bad.securityInc).toMatch(/Content-Security-Policy "/);
    expect(bad.stdout).toContain("CSP=strict non riconosciuta");
  });

  it("FRAME_ANCESTORS: incorporabile dai siti indicati (niente X-Frame-Options, che non sa elencarli)", async () => {
    const r = await run({ FRAME_ANCESTORS: "https://intranet.ente.it/portale,https://www.ente.it" });
    expect(directive(csp(r.securityInc), "frame-ancestors")).toEqual(["'self'", "https://intranet.ente.it", "https://www.ente.it"]);
    expect(r.securityInc).not.toContain("X-Frame-Options");
    expect(r.stdout).toContain("può essere incorporata da: https://intranet.ente.it https://www.ente.it");
    const weak = await run({ FRAME_ANCESTORS: "https://www.ente.it", CSP: "off" });
    expect(weak.stdout).toContain("ATTENZIONE: FRAME_ANCESTORS senza CSP=enforce");
  });
});

describe("45-security-config.sh: errori del browser e violazioni CSP nel log", () => {
  it("default: /client-errors e /csp-report solo POST, corpo piccolo, limite per client, log JSON, nessun token verso il sink", async () => {
    const r = await run();
    const map = r.securityMap ?? "";
    expect(map).toContain("log_format client_json escape=json ");
    expect(map).toContain('"type":"$client_report_type"');
    expect(map).toContain('"report":"$request_body"');
    expect(map).not.toMatch(/http_authorization|http_cookie/);
    expect(map).toContain('map $uri $client_report_type { default "client-error"; /csp-report "csp-violation"; }');
    expect(map).toContain("limit_req_zone $security_client zone=client_reports:1m rate=1r/s;");
    const conf = r.securityConf ?? "";
    for (const path of ["/client-errors", "/csp-report"]) {
      const start = conf.indexOf(`location = ${path} {`);
      expect(start).toBeGreaterThanOrEqual(0);
      const loc = conf.slice(start, conf.indexOf("\n}", start));
      for (const d of ["limit_except POST { deny all; }", "limit_req zone=client_reports burst=20 nodelay;", "limit_req_status 429;", "client_max_body_size 16k;", "client_body_buffer_size 16k;", "access_log /dev/stdout client_json;", "proxy_pass http://127.0.0.1:$server_port/__report-sink;", 'proxy_set_header Authorization "";', 'proxy_set_header Cookie "";'])
        expect(loc).toContain(d);
    }
    expect(conf).toMatch(/location = \/__report-sink \{\s+allow 127\.0\.0\.1;\s+deny all;\s+access_log off;\s+return 204;/);
    expect(r.stdout).toContain("/client-errors attivo");
  });

  it("CLIENT_ERRORS=false: niente /client-errors (resta /csp-report); con anche CSP=off nessuna location", async () => {
    const r = await run({ CLIENT_ERRORS: "false" });
    expect(r.securityConf).not.toContain("/client-errors");
    expect(r.securityConf).toContain("/csp-report");
    const none = await run({ CLIENT_ERRORS: "no", CSP: "off" });
    expect(none.securityConf).toBe("");
    expect(none.securityMap).toBe("");
    expect(none.stdout).toContain("segnalazioni dal browser spente");
  });
});

describe("40-runtime-config.sh: clientErrors", () => {
  it("default true, CLIENT_ERRORS=false lo spegne", async () => {
    expect(JSON.parse((await runEntrypoint("40-runtime-config.sh", { AUTH_ENABLED: "false" })).configJson ?? "{}").clientErrors).toBe(true);
    expect(JSON.parse((await runEntrypoint("40-runtime-config.sh", { AUTH_ENABLED: "false", CLIENT_ERRORS: "false" })).configJson ?? "{}").clientErrors).toBe(false);
  });
});

describe("35-proxy-config.sh: limite di richieste verso GeoServer", () => {
  const GS = { GEOSERVER_PROXY_URL: "http://geoserver:8080/geoserver", GEOCODER: "off" };
  const loc = (conf: string, head: string) => { const s = conf.indexOf(head); return s < 0 ? "" : conf.slice(s, conf.indexOf("\n}", s)); };

  it("default: letture 100r/s (raffiche 600) su /geoserver/, scritture solo POST 10r/s (raffiche 40) sulla WFS-T", async () => {
    const r = await runEntrypoint("35-proxy-config.sh", { ...GS, EDIT_ENABLED: "true" });
    expect(r.code, r.stderr).toBe(0);
    expect(r.rateMap).toContain('map $http_x_forwarded_for $gs_client { default $http_x_forwarded_for; "" $binary_remote_addr; }');
    expect(r.rateMap).toContain('map $request_method $gs_write_client { default ""; POST $gs_client; }');
    expect(r.rateMap).toContain("limit_req_zone $gs_client zone=gs_read:10m rate=100r/s;");
    expect(r.rateMap).toContain("limit_req_zone $gs_write_client zone=gs_write:5m rate=10r/s;");
    const read = loc(r.proxyConf ?? "", "location /geoserver/ {");
    expect(read).toContain("limit_req zone=gs_read burst=600 nodelay;");
    expect(read).toContain("limit_req_status 429;");
    expect(read).not.toContain("gs_write");
    const write = loc(r.proxyConf ?? "", "location = /geoserver/wfs {");
    expect(write).toContain("limit_req zone=gs_read burst=600 nodelay;");
    expect(write).toContain("limit_req zone=gs_write burst=40 nodelay;");
    expect(r.stdout).toContain("letture 100r/s (raffiche di 600), scritture 10r/s (raffiche di 40), poi 429");
  });

  it("valori personalizzati; non validi: default e avviso", async () => {
    const r = await runEntrypoint("35-proxy-config.sh", { ...GS, GEOSERVER_RATE: "3000r/m", GEOSERVER_BURST: "50", GEOSERVER_WRITE_RATE: "molti", GEOSERVER_WRITE_BURST: "-1" });
    expect(r.rateMap).toContain("rate=3000r/m;");
    expect(r.rateMap).toContain("zone=gs_write:5m rate=10r/s;");
    expect(r.proxyConf).toContain("limit_req zone=gs_read burst=50 nodelay;");
    expect(r.stdout).toContain("GEOSERVER_WRITE_RATE ignorato");
    expect(r.stdout).toContain("GEOSERVER_WRITE_BURST ignorato");
  });

  it("RATE_LIMIT=false: nessun limite", async () => {
    const r = await runEntrypoint("35-proxy-config.sh", { ...GS, EDIT_ENABLED: "true", RATE_LIMIT: "false" });
    expect(r.rateMap).toBe("");
    expect(r.proxyConf).not.toContain("limit_req");
    expect(r.stdout).toContain("limite di richieste verso GeoServer spento");
  });
});
