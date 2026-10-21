// nginx reale con la configurazione generata dagli script di entrypoint (35, 40, 45) e da nginx/default.conf, davanti a un
// upstream HTTP locale al posto di GeoServer: ogni combinazione di CSP, CLIENT_ERRORS, RATE_LIMIT, cache dei tile e geocoder
// passa `nginx -t` e parte; intestazioni su tutte le location; segnalazioni del browser nel log JSON senza cookie né token e
// senza arrivare all'upstream; limite per client verso GeoServer (l'upstream vede solo le richieste ammesse).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { ROOT, hasNginx, required } from "./support";

const built = fs.existsSync(path.join(ROOT, "dist/index.html"));
if (required && !hasNginx) throw new Error("nginx non installato: serve a security.int.test.ts");
if (required && !built) throw new Error("build mancante: esegui `npm run build` prima di security.int.test.ts");

type Inst = { d: string; url: string; stop: () => void };
// e2e/lib.mjs avvia nginx esattamente come nell'immagine (stessi script, stessa default.conf)
const lib = () => import("../../e2e/lib.mjs") as Promise<{ startNginx: (n: string, p: number, e: Record<string, string>) => Inst; stopAll: () => void }>;

describe.skipIf(!hasNginx || !built)("nginx reale: sicurezza, segnalazioni dal browser, limiti per client", () => {
  let upstream: http.Server;
  let up = "";
  const seen: { method: string; url: string; auth: string; cookie: string }[] = [];
  let L: Awaited<ReturnType<typeof lib>>;
  const base = () => ({ AUTH_ENABLED: "false", GEOSERVER_PROXY_URL: `${up}/geoserver`, GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass", GEOCODER: "off", BASEMAPS: `osm|Mappa|${up}/tiles/{z}/{x}/{y}.png|t` });
  const logLines = (i: Inst) => (fs.existsSync(path.join(i.d, "access.log")) ? fs.readFileSync(path.join(i.d, "access.log"), "utf8").split("\n").filter(Boolean) : []);

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: String(req.headers.authorization ?? ""), cookie: String(req.headers.cookie ?? "") });
      req.resume();
      req.on("end", () => {
        if (/request=GetMap/i.test(req.url ?? "")) { res.writeHead(200, { "Content-Type": "image/png" }); res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47])); return; }
        res.writeHead(200, { "Content-Type": "application/xml" });
        res.end("<ok/>");
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    up = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    L = await lib();
  });
  afterAll(async () => { L?.stopAll(); await new Promise((r) => upstream?.close(r)); });

  it.each([
    ["default", {}, 8064],
    ["tutto spento", { CSP: "off", CLIENT_ERRORS: "false", RATE_LIMIT: "false" }, 8065],
    ["report-only, incorporabile, extra", { CSP: "report-only", FRAME_ANCESTORS: "https://intranet.ente.it", CSP_EXTRA_ORIGINS: "https://cdn.example.org" }, 8066],
    ["con scritture, cache dei tile, geocoder, log JSON", { EDIT_ENABLED: "true", TILE_CACHE: "true", GEOCODER: "photon", GEOCODER_URL: "__UP__", ACCESS_LOG_FORMAT: "json", GEOSERVER_RATE: "3000r/m" }, 8067],
  ] as [string, Record<string, string>, number][])("%s: nginx -t accetta la configurazione e risponde", async (name, env, port) => {
    const e = Object.fromEntries(Object.entries({ ...base(), ...env }).map(([k, v]) => [k, v === "__UP__" ? up : v]));
    const i = L.startNginx(`INT-SEC-${name.replace(/\W+/g, "-")}`, port, e); // startNginx esegue nginx -t: lancia se non valida
    try {
      const r = await fetch(i.url + "/");
      expect(r.status).toBe(200);
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect((await fetch(i.url + "/geoserver/ows?service=WMS&request=GetCapabilities")).status).toBe(200);
    } finally { i.stop(); }
  });

  it("intestazioni su ogni location, segnalazione nel log senza cookie e senza toccare l'upstream, limiti verso GeoServer", async () => {
    const i = L.startNginx("INT-SEC", 8068, { ...base(), EDIT_ENABLED: "true", GEOSERVER_BURST: "5", GEOSERVER_RATE: "1r/s", GEOSERVER_WRITE_BURST: "1", GEOSERVER_WRITE_RATE: "1r/m" });
    try {
      const asset = fs.readdirSync(path.join(i.d, "html/assets")).find((f) => f.endsWith(".js"));
      for (const u of ["/", "/admin/roles", "/config.json", `/assets/${asset}`, "/healthz", "/geoserver/wms?request=GetCapabilities"]) {
        const h = (await fetch(i.url + u)).headers;
        expect([u, h.get("content-security-policy")?.startsWith("default-src 'self'")]).toEqual([u, true]);
        expect([u, h.get("x-frame-options")]).toEqual([u, "SAMEORIGIN"]);
      }
      await new Promise((r) => setTimeout(r, 1100));

      seen.length = 0;
      const body = JSON.stringify({ kind: "error", message: 'TypeError: "x" non definito', page: "/" });
      const r = await fetch(i.url + "/client-errors", { method: "POST", body, headers: { "Content-Type": "application/json", Cookie: "_oauth2_proxy=SEGRETO", Authorization: "Bearer SEGRETO" } });
      expect(r.status).toBe(204);
      const line = logLines(i).find((l) => l.includes('"type":"client-error"'));
      expect(line).toBeDefined();
      const o = JSON.parse(line!);
      expect(JSON.parse(o.report)).toEqual(JSON.parse(body)); // corpo intatto, virgolette comprese
      expect(o.status).toBe(204);
      expect(line).not.toContain("SEGRETO");
      expect(seen).toHaveLength(0); // il sink è nginx stesso
      expect(logLines(i).some((l) => l.includes("__report-sink"))).toBe(false);

      seen.length = 0;
      const reads = await Promise.all(Array.from({ length: 12 }, () => fetch(i.url + "/geoserver/wms?request=GetCapabilities").then((x) => x.status)));
      expect(reads.filter((s) => s === 429).length).toBeGreaterThanOrEqual(5);
      expect(seen.length).toBe(reads.filter((s) => s === 200).length);
      expect(seen.every((s) => s.auth.startsWith("Basic "))).toBe(true);
      await new Promise((res) => setTimeout(res, 6500)); // il secchio delle letture si svuota
      const w1 = await fetch(i.url + "/geoserver/wfs", { method: "POST", body: "<t/>" });
      const w2 = await fetch(i.url + "/geoserver/wfs", { method: "POST", body: "<t/>" });
      const w3 = await fetch(i.url + "/geoserver/wfs", { method: "POST", body: "<t/>" });
      expect([w1.status, w2.status, w3.status]).toEqual([200, 200, 429]);
    } finally { i.stop(); }
  });
});
