// @vitest-environment jsdom
// Vector tiles e conteggi contro GeoServer reale: se GeoServer ha l'estensione vectortiles, la GetMap in MVT di un layer
// PostGIS risponde con un tile valido (letto con @mapbox/vector-tile); il conteggio esatto (resultType=hits) di un layer
// oltre il limite dei widget coincide con le righe in tabella.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Pbf from "pbf";
import { VectorTile } from "@mapbox/vector-tile";
import { getWfsCount } from "../../src/api";
import { MVT_FORMAT, supportsMvt, vtTileUrl } from "../../src/vectorTiles";
import { gs, missing, pg, preparedWorkspace, psqlAdmin, required } from "./support";

const withGs = !!gs && gs.publish && !!pg;
if (!withGs && required) throw new Error(missing("GeoServer", "INT_GEOSERVER_URL e PostgreSQL (INT_PGHOST, ...)"));

describe.skipIf(!withGs)("vector tiles e conteggi su GeoServer reale", () => {
  let w: Awaited<ReturnType<typeof preparedWorkspace>>;
  const G = gs ?? { url: "" };
  let mvt = false;

  beforeAll(async () => {
    w = await preparedWorkspace("gema_vt");
    psqlAdmin(
      "CREATE TABLE gema_config.punti_vt (id serial PRIMARY KEY, nome text, geom geometry(Point, 4326));" +
        "INSERT INTO gema_config.punti_vt (nome, geom) SELECT 'P' || i, ST_SetSRID(ST_MakePoint(12 + (i % 100) * 0.001, 42 + (i / 100) * 0.001), 4326) FROM generate_series(1, 6000) i;",
      w.db,
    );
    const ft = await w.rest("POST", `/workspaces/${w.ws}/datastores/gema_config/featuretypes`, { featureType: { name: "punti_vt", nativeName: "punti_vt", srs: "EPSG:4326", enabled: true } });
    if (ft.status !== 201) throw new Error(`pubblicazione: HTTP ${ft.status}`);
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(G.url)) return realFetch(input, init);
      const headers = new Headers(init.headers);
      if (!headers.has("Authorization")) headers.set("Authorization", w.basic);
      return realFetch(input, { ...init, headers });
    });
    mvt = supportsMvt(await (await fetch(`${G.url}/ows?service=WMS&version=1.3.0&request=GetCapabilities`)).text());
  });
  afterAll(async () => { vi.unstubAllGlobals(); await w?.cleanup(); });

  it("conteggio esatto oltre il limite dei widget", async () => {
    expect(await getWfsCount(G.url, null, `${w.ws}:punti_vt`)).toBe(6000);
    expect(await getWfsCount(G.url, null, `${w.ws}:punti_vt`, "nome LIKE 'P1%'")).toBe(1111);
  });

  it("MVT: tile valido con il layer e gli attributi (se l'estensione c'è)", async (ctx) => {
    if (!mvt) { ctx.skip(); return; }
    // tile 3857 che contiene i punti (zoom 14 intorno a 12.05, 42.03)
    const bbox = "1335833.8895192828,5165920.119625352,1338279.8744235812,5168366.104529651";
    const r = await fetch(vtTileUrl(G.url, `${w.ws}:punti_vt`).replace("{bbox-epsg-3857}", bbox));
    expect(r.headers.get("content-type")).toContain(MVT_FORMAT);
    const tile = new VectorTile(new Pbf(new Uint8Array(await r.arrayBuffer())));
    const layer = tile.layers.punti_vt;
    expect(layer).toBeTruthy();
    expect(layer.length).toBeGreaterThan(0);
    expect(String(layer.feature(0).properties.nome)).toMatch(/^P\d+$/);
  });
});
