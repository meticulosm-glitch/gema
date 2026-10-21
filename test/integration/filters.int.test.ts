// @vitest-environment jsdom
// Filtri globali delle dashboard su GeoServer reale: il CQL del periodo (fine compresa) su colonne date e timestamp,
// il BBOX sulla colonna geometrica, e la combinazione con il filtro proprio del widget.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { describeLayer, getWfsFeatures } from "../../src/api";
import { andCql } from "../../src/Widgets";
import { widgetFilter, type DashFilters } from "../../src/dashFilters";
import { gs, missing, pg, preparedWorkspace, psqlAdmin, required } from "./support";

const withGs = !!gs && gs.publish && !!pg;
if (!withGs && required) throw new Error(missing("GeoServer", "INT_GEOSERVER_URL e PostgreSQL (INT_PGHOST, ...)"));

describe.skipIf(!withGs)("filtri globali su GeoServer reale", () => {
  let w: Awaited<ReturnType<typeof preparedWorkspace>>;
  const G = gs ?? { url: "" };
  const layer = () => `${w.ws}:rilievi_f`;
  const count = async (cql: string) => (await getWfsFeatures(G.url, null, layer(), cql, 5000, ["id"])).length;
  const geomOf = async () => (await describeLayer(G.url, null, layer())).geomName;

  beforeAll(async () => {
    w = await preparedWorkspace("gema_fl");
    // 10 punti, uno al giorno dal 1 al 10 febbraio 2026 (alle 23:30 per il timestamp: la fine deve comprendere tutto il giorno)
    psqlAdmin(
      "CREATE TABLE gema_config.rilievi_f (id serial PRIMARY KEY, tipo text, giorno date, ora timestamp, geom geometry(Point, 4326));" +
        "INSERT INTO gema_config.rilievi_f (tipo, giorno, ora, geom) SELECT (ARRAY['A','B'])[1 + i % 2], DATE '2026-01-31' + i, TIMESTAMP '2026-01-31 23:30' + i * INTERVAL '1 day', ST_SetSRID(ST_MakePoint(12 + i * 0.1, 42), 4326) FROM generate_series(1, 10) i;",
      w.db,
    );
    const ft = await w.rest("POST", `/workspaces/${w.ws}/datastores/gema_config/featuretypes`, { featureType: { name: "rilievi_f", nativeName: "rilievi_f", srs: "EPSG:4326", enabled: true } });
    if (ft.status !== 201) throw new Error(`pubblicazione: HTTP ${ft.status}`);
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(G.url)) return realFetch(input, init);
      const headers = new Headers(init.headers);
      if (!headers.has("Authorization")) headers.set("Authorization", w.basic);
      return realFetch(input, { ...init, headers });
    });
  });
  afterAll(async () => { vi.unstubAllGlobals(); await w?.cleanup(); });

  it("periodo su una colonna date: inizio e fine compresi", async () => {
    const f: DashFilters = { date: { fields: { [layer()]: "giorno" } } };
    const { cql } = widgetFilter(layer(), f, { from: "2026-02-03", to: "2026-02-05" }, () => undefined);
    expect(await count(cql)).toBe(3);
  });

  it("periodo su un timestamp: l'ultimo giorno è compreso fino a mezzanotte", async () => {
    const f: DashFilters = { date: { fields: { [layer()]: "ora" } } };
    // le 23:30 del 2 febbraio sono comprese in "fino al 2 febbraio"; quelle del 31 gennaio no in "dal 1 febbraio"
    expect(await count(widgetFilter(layer(), f, { from: "2026-02-01", to: "2026-02-02" }, () => undefined).cql)).toBe(2);
    expect(await count(widgetFilter(layer(), f, { from: "", to: "2026-02-01" }, () => undefined).cql)).toBe(1);
  });

  it("area con la colonna geometrica letta dallo schema, insieme al periodo e al filtro del widget", async () => {
    const g = await geomOf();
    expect(g).toBe("geom");
    const f: DashFilters = { date: { fields: { [layer()]: "giorno" } }, area: true };
    const { cql, skipped } = widgetFilter(layer(), f, { from: "2026-02-01", to: "2026-02-06", bbox: [12.25, 41.9, 12.55, 42.1] }, () => g);
    expect(skipped).toEqual([]);
    expect(await count(cql)).toBe(3); // nel riquadro i punti 3, 4, 5 (x 12.3..12.5), tutti nel periodo 1..6 febbraio
    expect(await count(andCql("tipo = 'A'", cql))).toBe(1); // tipo A = i pari: solo il punto 4
  });
});
