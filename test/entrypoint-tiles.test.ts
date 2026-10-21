import { describe, expect, it } from "vitest";
import { runEntrypoint } from "./shell";

const GS = { GEOSERVER_PROXY_URL: "http://geoserver:8080/geoserver", GEOCODER: "off" };
const READ = { GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass" };
const run = async (env: Record<string, string>) => {
  const r = await runEntrypoint("35-proxy-config.sh", { ...GS, ...env });
  expect(r.code, r.stderr).toBe(0);
  const conf = r.proxyConf ?? "";
  const start = conf.indexOf("location /geoserver/ {");
  const gsLoc = conf.slice(start, conf.indexOf("\n}", start));
  return { map: r.tilesMap ?? "", gsLoc, out: r.stdout };
};

describe("nginx: cache dei tile (TILE_CACHE)", () => {
  it("spenta di default", async () => {
    const { map, gsLoc } = await run(READ);
    expect(map).toBe("");
    expect(gsLoc).not.toContain("proxy_cache");
  });

  it("accesa con credenziali di lettura fisse: zona, regole su richieste e risposte, direttive sulla route di GeoServer", async () => {
    const { map, gsLoc, out } = await run({ ...READ, TILE_CACHE: "true", TILE_CACHE_TTL: "2H", TILE_CACHE_SIZE: "500m" });
    expect(map).toContain("proxy_cache_path /tmp/nginx-tiles levels=1:2 keys_zone=gs_tiles:20m max_size=500m inactive=2h use_temp_path=off;");
    expect(map).toContain('map "$request_method:$arg_request" $gs_tile_getmap { default 0; "~*^(GET|HEAD):getmap$" 1; }');
    expect(map).toContain('map $uri $gs_tile_gwc { default 0; "~^/geoserver/gwc/" 1; }');
    expect(map).toContain('map $upstream_http_content_type $gs_tile_notimage { default 1; "~^image/" 0; }'); // eccezioni WMS (200, XML) escluse
    for (const d of ["proxy_cache gs_tiles;", 'proxy_cache_key "$request_uri";', "proxy_cache_valid 200 2h;", "proxy_cache_bypass $gs_tile_skip;", "proxy_no_cache $gs_tile_skip $gs_tile_notimage;", "proxy_cache_lock on;", "proxy_ignore_headers Cache-Control Expires Set-Cookie;"])
      expect(gsLoc).toContain(d);
    expect(out).toContain("cache dei tile attiva: GetMap e GeoWebCache, durata 2h, al massimo 500m");
  });

  it("senza credenziali fisse (passa il token dell'utente): resta spenta e lo dice", async () => {
    const { map, gsLoc, out } = await run({ TILE_CACHE: "true" });
    expect(map).toBe("");
    expect(gsLoc).not.toContain("proxy_cache");
    expect(out).toContain("TILE_CACHE ignorata: senza credenziali di lettura fisse");
  });

  it.each([["TILE_CACHE_TTL", "10 minuti", "10m"], ["TILE_CACHE_TTL", "0s", "10m"], ["TILE_CACHE_SIZE", "2tb", "1g"], ["TILE_CACHE_SIZE", "-1g", "1g"]])("%s=%s non valido: default (%s) e avviso", async (k, v, d) => {
    const { map, out } = await run({ ...READ, TILE_CACHE: "true", [k]: v });
    expect(map).toContain(k === "TILE_CACHE_TTL" ? `inactive=${d}` : `max_size=${d}`);
    expect(out).toContain(`${k} ignorato`);
  });
});

describe("config.json: WMS_TILED", () => {
  const cfgOf = async (env: Record<string, string>) => {
    const r = await runEntrypoint("40-runtime-config.sh", { AUTH_ENABLED: "false", ...env });
    expect(r.code, r.stderr).toBe(0);
    return JSON.parse(r.configJson ?? "");
  };
  it("di default false; true se richiesto", async () => {
    expect((await cfgOf({})).wmsTiled).toBe(false);
    expect((await cfgOf({ WMS_TILED: "true" })).wmsTiled).toBe(true);
    expect((await cfgOf({ WMS_TILED: "forse" })).wmsTiled).toBe(false);
  });
});
