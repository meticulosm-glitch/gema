import { describe, expect, it } from "vitest";
import { runEntrypoint } from "./shell";

const cfgOf = async (env: Record<string, string> = {}) => {
  const r = await runEntrypoint("40-runtime-config.sh", { AUTH_ENABLED: "false", ...env });
  expect(r.code, r.stderr).toBe(0);
  return { cfg: JSON.parse(r.configJson ?? ""), out: r.stdout };
};
const proxyOf = async (env: Record<string, string> = {}) => {
  const r = await runEntrypoint("35-proxy-config.sh", { AUTH_ENABLED: "false", GEOSERVER_PROXY_URL: "http://gs:8080/geoserver", ...env });
  expect(r.code, r.stderr).toBe(0);
  return r;
};

describe("config.json: geocoder", () => {
  it("di default Nominatim via /geocode, in italiano", async () => {
    expect((await cfgOf()).cfg.geocoder).toEqual({ type: "nominatim", url: "/geocode", country: "", lang: "it" });
  });
  it("Photon, paesi e lingua normalizzati", async () => {
    const { cfg } = await cfgOf({ GEOCODER: "PHOTON", GEOCODER_COUNTRY: "IT, sm", GEOCODER_LANG: "DE" });
    expect(cfg.geocoder).toEqual({ type: "photon", url: "/geocode", country: "it,sm", lang: "de" });
  });
  it.each(["off", "none", "false"])("GEOCODER=%s: nessun blocco", async (v) => {
    expect((await cfgOf({ GEOCODER: v })).cfg.geocoder).toBeUndefined();
  });
  it("valore sconosciuto: nessun blocco; paese e lingua non validi: ignorati, JSON sempre valido", async () => {
    expect((await cfgOf({ GEOCODER: "google" })).cfg.geocoder).toBeUndefined();
    const { cfg, out } = await cfgOf({ GEOCODER_COUNTRY: 'it"}, "x": {"', GEOCODER_LANG: "italiano" });
    expect(cfg.geocoder.country).toBe("");
    expect(cfg.geocoder.lang).toBe("it");
    expect(out).toContain("GEOCODER_COUNTRY ignorato");
  });
  it("l'URL del geocoder non finisce mai nel config del browser (passa dal proxy)", async () => {
    const { cfg } = await cfgOf({ GEOCODER_URL: "https://interno.example" });
    expect(JSON.stringify(cfg)).not.toContain("interno.example");
  });
});

describe("config.json: BASEMAPS", () => {
  it("senza BASEMAPS non c'è l'elenco (usa quello predefinito del browser)", async () => {
    expect((await cfgOf()).cfg.basemaps).toBeUndefined();
  });
  it('formato "id|Etichetta|tile|attribuzione;…"; tile vuoto = nessuno; etichetta mancante = id', async () => {
    const { cfg } = await cfgOf({
      BASEMAPS: "osm|Mappa|https://t.example/{z}/{x}/{y}.png|© OSM contributors; sat|Satellite|/tiles/sat/{z}/{x}/{y}.jpg|;none|Nessuno| ;solo",
    });
    expect(cfg.basemaps).toEqual([
      { id: "osm", label: "Mappa", tiles: "https://t.example/{z}/{x}/{y}.png", attribution: "© OSM contributors" },
      { id: "sat", label: "Satellite", tiles: "/tiles/sat/{z}/{x}/{y}.jpg", attribution: "" },
      { id: "none", label: "Nessuno", tiles: "", attribution: "" },
      { id: "solo", label: "solo", tiles: "", attribution: "" },
    ]);
  });
  it("virgolette e backslash vengono escapati: il JSON resta valido", async () => {
    const { cfg } = await cfgOf({ BASEMAPS: 'a|Et "x" \\ y|https://t/{z}/{x}/{y}|attr "q"' });
    expect(cfg.basemaps[0].label).toBe('Et "x" \\ y');
    expect(cfg.basemaps[0].attribution).toBe('attr "q"');
  });
});

describe("proxy nginx: /geocode/", () => {
  it("di default inoltra a Nominatim pubblico con cache e limite per client, senza Authorization né cookie", async () => {
    const r = await proxyOf();
    const c = r.proxyConf!;
    expect(c).toContain("location /geocode/ {");
    expect(c).toContain("proxy_pass https://nominatim.openstreetmap.org/;");
    expect(c).toContain("proxy_set_header Host nominatim.openstreetmap.org;");
    expect(c).toContain("proxy_ssl_server_name on;");
    expect(c).toContain('proxy_set_header Authorization "";');
    expect(c).toContain('proxy_set_header Cookie "";');
    expect(c).toContain("limit_except GET { deny all; }");
    expect(c).toContain("proxy_cache geocode_cache;");
    expect(c).toContain('proxy_cache_key "$request_uri";');
    expect(c).toContain('proxy_set_header User-Agent "mapp-web";');
    expect(r.geocodeMap).toContain("zone=geocode_rl:1m rate=1r/s");
    expect(r.geocodeMap).toContain("keys_zone=geocode_cache");
  });
  it("Photon: URL proprio, più richieste al secondo; User-Agent ripulito da caratteri pericolosi", async () => {
    const r = await proxyOf({ GEOCODER: "photon", GEOCODER_URL: "http://photon.ns.svc:2322/", GEOCODER_USER_AGENT: 'IRIDE "x"; rm -rf' });
    expect(r.proxyConf).toContain("proxy_pass http://photon.ns.svc:2322/;");
    expect(r.proxyConf).not.toContain("proxy_ssl_server_name on;\n  proxy_ssl_name photon");
    expect(r.proxyConf).toContain('proxy_set_header User-Agent "IRIDE x rm -rf";');
    expect(r.geocodeMap).toContain("rate=5r/s");
  });
  it("GEOCODER=off o valore sconosciuto: nessuna route e nessuna direttiva http", async () => {
    for (const g of ["off", "boh"]) {
      const r = await proxyOf({ GEOCODER: g });
      expect(r.proxyConf).not.toContain("/geocode/");
      expect(r.geocodeMap).toBe("");
    }
  });
  it("la route /geocode/ non porta mai le credenziali di GeoServer", async () => {
    const r = await proxyOf({ GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "segretissima" });
    const block = r.proxyConf!.split("location /geocode/")[1];
    expect(block).not.toContain("gs_auth");
    expect(`${r.proxyConf}${r.geocodeMap}`).not.toContain("segretissima");
  });
});
