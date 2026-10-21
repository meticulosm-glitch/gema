// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  MVT_FORMAT, addVectorLayer, hoverLabel, identityFilter, removeVectorLayer, setVectorHover, setVectorOpacity, setVectorTiles, setVectorVisible,
  sourceLayer, supportsMvt, vtColor, vtHoverId, vtLayerIds, vtTileUrl,
} from "../src/vectorTiles";
import { captureView, parseHash, sanitizeViewState } from "../src/viewState";

/** Mappa finta: tiene sorgenti e layer, registra le chiamate. */
function fakeMap() {
  const sources = new Map<string, any>(); const layers = new Map<string, any>(); const calls: unknown[][] = [];
  const m = {
    addSource: (id: string, s: any) => { sources.set(id, { ...s, setTiles: vi.fn() }); },
    getSource: (id: string) => sources.get(id),
    removeSource: (id: string) => { sources.delete(id); },
    addLayer: (l: any, before?: string) => { layers.set(l.id, { ...l, before }); },
    getLayer: (id: string) => layers.get(id),
    removeLayer: (id: string) => { layers.delete(id); },
    setPaintProperty: (...a: unknown[]) => calls.push(["paint", ...a]),
    setLayoutProperty: (...a: unknown[]) => calls.push(["layout", ...a]),
    setFilter: (...a: unknown[]) => calls.push(["filter", ...a]),
  };
  return { m: m as any, sources, layers, calls };
}

describe("vector tiles: GeoServer e URL", () => {
  it("formato MVT riconosciuto nelle GetMap del GetCapabilities (anche il nome vecchio)", () => {
    expect(supportsMvt(`<Capability><Request><GetMap><Format>image/png</Format><Format>application/vnd.mapbox-vector-tile</Format></GetMap><GetFeatureInfo><Format>x</Format></GetFeatureInfo></Request>`)).toBe(true);
    expect(supportsMvt(`<wms:GetMap><wms:Format>application/x-protobuf;type=mapbox-vector</wms:Format></wms:GetMap>`)).toBe(true);
    expect(supportsMvt(`<GetMap><Format>image/png</Format></GetMap><GetLegendGraphic><Format>application/vnd.mapbox-vector-tile</Format></GetLegendGraphic>`)).toBe(false);
  });
  it("URL dei tile: formato MVT, filtro, data e contatore come per le immagini; stile no", () => {
    const u = vtTileUrl("/gs", "iride:parcels", { cql: " kind = 'A' ", time: "2026-01-01", style: "x" }, 3);
    expect(u).toContain(`format=${encodeURIComponent(MVT_FORMAT)}`);
    expect(u).toContain("layers=iride%3Aparcels&styles=&");
    expect(u).toContain(`cql_filter=${encodeURIComponent("kind = 'A'")}`);
    expect(u).toMatch(/&time=2026-01-01&_r=3&bbox=\{bbox-epsg-3857\}$/);
    expect(sourceLayer("iride:parcels")).toBe("parcels");
  });
  it("colori dalla palette categorica, ciclici", () => {
    expect([0, 1, 5, -1].map((i) => vtColor(i))).toEqual(["#2a78d6", "#eb6834", "#2a78d6", "#e87ba4"]);
    expect(vtColor(0, true)).toBe("#3987e5");
  });
});

describe("vector tiles: layer sulla mappa", () => {
  it("aggiunge sorgente e stili per poligoni, linee e punti sotto al segnaposto; li toglie tutti", () => {
    const { m, sources, layers } = fakeMap();
    addVectorLayer(m, "iride:parcels", "u", "#2a78d6", 0.5, "anchor");
    expect(sources.get("vt-iride:parcels")).toMatchObject({ type: "vector", tiles: ["u"] });
    expect([...layers.keys()]).toEqual([...vtLayerIds("iride:parcels"), vtHoverId("iride:parcels")]);
    const fill = layers.get("vt-iride:parcels-fill");
    expect(fill).toMatchObject({ type: "fill", "source-layer": "parcels", before: "anchor", paint: { "fill-color": "#2a78d6", "fill-opacity": 0.15 } });
    expect(layers.get("vt-iride:parcels-circle").filter).toEqual(["==", ["geometry-type"], "Point"]);
    addVectorLayer(m, "iride:parcels", "u2", "#000", 1); // già presenti: niente doppioni
    expect(layers.size).toBe(4);
    removeVectorLayer(m, "iride:parcels");
    expect(layers.size).toBe(0);
    expect(sources.size).toBe(0);
  });
  it("opacità, visibilità, nuovi tile, evidenziazione", () => {
    const { m, sources, calls } = fakeMap();
    addVectorLayer(m, "a", "u", "#000", 1);
    setVectorOpacity(m, "a", 0.4);
    expect(calls).toContainEqual(["paint", "vt-a-fill", "fill-opacity", 0.4 * 0.3]);
    expect(calls).toContainEqual(["paint", "vt-a-circle", "circle-stroke-opacity", 0.4]);
    setVectorVisible(m, "a", false);
    expect(calls.filter((c) => c[0] === "layout")).toHaveLength(4);
    setVectorTiles(m, "a", "nuovo");
    expect(sources.get("vt-a").setTiles).toHaveBeenCalledWith(["nuovo"]);
    setVectorHover(m, "a", ["==", ["id"], 3]);
    expect(calls.at(-1)).toEqual(["filter", "vt-a-hover", ["==", ["id"], 3]]);
    setVectorHover(m, "a", null);
    expect((calls.at(-1) as any[])[2]).toEqual(["==", ["get", "__gema_none__"], "__gema_none__"]);
  });
  it("oggetto sotto il mouse: per id, altrimenti per attributi semplici", () => {
    expect(identityFilter(7, {})).toEqual(["==", ["id"], 7]);
    expect(identityFilter(undefined, { name: "P1", area: 100, geom: { a: 1 }, ok: true })).toEqual(["all", ["==", ["get", "name"], "P1"], ["==", ["get", "area"], 100], ["==", ["get", "ok"], true]]);
    expect(identityFilter(undefined, { x: null })).toEqual(["==", ["get", "__gema_none__"], "__gema_none__"]);
  });
  it("etichetta: nome se c'è, altrimenti il primo testo; al più 5 attributi", () => {
    expect(hoverLabel({ kind: "A", name: "Particella 1", area: 100 })).toEqual({ title: "Particella 1", rows: [["kind", "A"], ["area", "100"]] });
    expect(hoverLabel({ id: 3, code: "S1", a: 1, b: 2, c: 3, d: 4, e: 5, f: "" }).rows).toHaveLength(5);
    expect(hoverLabel({ n: 3 }).title).toBe("oggetto");
  });
});

describe("link e viste salvate: disegno vettoriale", () => {
  it("'v' come sesto elemento, solo se vettoriale; link vecchi invariati", () => {
    const map = { getCenter: () => ({ lng: 12, lat: 42 }), getZoom: () => 9, getPitch: () => 0, getBearing: () => 0 };
    const s = captureView(map, ["a", "b"], { a: { vt: true }, b: { opacity: 0.5 } });
    expect(s.l).toEqual([["a", 1, "", "", "", "v"], ["b", 0.5, "", "", ""]]);
    expect(sanitizeViewState({ l: [["a", 1, "", "", "", "v"], ["b", 1, "", "", "", "x"], ["c", 1]] }).l).toEqual([["a", 1, "", "", "", "v"], ["b", 1, "", "", ""], ["c", 1, "", "", ""]]);
    expect(parseHash("#s=" + encodeURIComponent(JSON.stringify(s))).l[0][5]).toBe("v");
  });
});
