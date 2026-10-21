// @vitest-environment jsdom
// Widget delle dashboard su GeoServer reale: gli attributi richiesti (propertyName), date e numeri come li restituisce
// GeoServer in JSON, e i calcoli di torta, linea, tabella e indicatore su un layer PostGIS pubblicato per il test.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getWfsFeatures } from "../../src/api";
import type { WidgetDef } from "../../src/configStore";
import { aggregate, buildItems } from "../../src/Widgets";
import { gaugeLevel, pieSlices, propsFor, tableRows } from "../../src/widgetKinds";
import { gs, missing, pg, preparedWorkspace, psqlAdmin, required } from "./support";

const withGs = !!gs && gs.publish && !!pg;
if (!withGs && required) throw new Error(missing("GeoServer", "INT_GEOSERVER_URL e PostgreSQL (INT_PGHOST, ...)"));

describe.skipIf(!withGs)("widget su GeoServer reale", () => {
  let w: Awaited<ReturnType<typeof preparedWorkspace>>;
  const G = gs ?? { url: "" };
  const layer = () => `${w.ws}:rilievi_w`;
  const W = (extra: Partial<WidgetDef>): WidgetDef => ({ id: "w", type: "kpi", title: "", layer: layer(), agg: "count", w: 1, ...extra });
  const data = async (def: WidgetDef) => (await getWfsFeatures(G.url, null, def.layer, def.cql, 5000, propsFor(def))).map((f) => f.properties ?? {});

  beforeAll(async () => {
    w = await preparedWorkspace("gema_wg");
    psqlAdmin(
      "CREATE TABLE gema_config.rilievi_w (id serial PRIMARY KEY, tipo text, area double precision, giorno date, geom geometry(Point, 4326));" +
        "INSERT INTO gema_config.rilievi_w (tipo, area, giorno, geom) SELECT (ARRAY['A','B','C'])[1 + i % 3], i * 10, DATE '2026-01-01' + i * 20, ST_SetSRID(ST_MakePoint(12 + i * 0.01, 42), 4326) FROM generate_series(1, 12) i;",
      w.db,
    );
    const ft = await w.rest("POST", `/workspaces/${w.ws}/datastores/gema_config/featuretypes`, { featureType: { name: "rilievi_w", nativeName: "rilievi_w", srs: "EPSG:4326", enabled: true } });
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

  it("torta: categorie dai valori del layer", async () => {
    const def = W({ type: "pie", field: "tipo" });
    const slices = pieSlices(buildItems(def, await data(def)));
    expect(slices.map((s) => [s.label, s.value]).sort()).toEqual([["A", 4], ["B", 4], ["C", 4]]);
  });

  it("linea: le date di GeoServer (con o senza 'Z') raggruppate per mese", async () => {
    const def = W({ type: "line", field: "giorno", granularity: "month" });
    const items = buildItems(def, await data(def));
    expect(items[0].label).toBe("2026-01");
    expect(items.reduce((n, i) => n + i.value, 0)).toBe(12);
  });

  it("tabella e indicatore: numeri come numeri; filtro CQL applicato dal server", async () => {
    const t = W({ type: "table", columns: ["tipo", "area"], sortField: "area", sortDesc: true, limit: 2 });
    const rows = await data(t);
    expect(Object.keys(rows[0]).sort()).toEqual(["area", "tipo"]);
    expect(tableRows(rows, t).map((r) => r.area)).toEqual([120, 110]);
    const g = W({ type: "gauge", agg: "sum", valueField: "area", cql: "tipo = 'A'", warn: 200, crit: 300 });
    const sum = aggregate(await data(g), g.agg, g.valueField);
    expect(sum).toBe(30 + 60 + 90 + 120);
    expect(gaugeLevel(sum, g)).toBe("critical");
  });
});
