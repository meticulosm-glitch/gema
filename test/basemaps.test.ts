import { describe, expect, it, vi } from "vitest";
import { applyBasemap, basemapStyle, defaultBasemaps, pickBasemap, resolveBasemaps, sanitizeBasemaps } from "../src/basemaps";

const T = "https://t.example/{z}/{x}/{y}.png";

describe("elenco sfondi", () => {
  it("il predefinito ha mappa (con BASEMAP_TILES), satellite, scuro e nessuno", () => {
    const l = defaultBasemaps(T);
    expect(l.map((b) => b.id)).toEqual(["osm", "sat", "dark", "none"]);
    expect(l[0].tiles).toBe(T);
    expect(l[3].tiles).toBeUndefined();
    for (const b of l.filter((x) => x.tiles)) expect(b.tiles).toMatch(/\{z\}.*\{x\}|\{z\}.*\{y\}/);
  });
  it("sanitizeBasemaps scarta voci non valide, doppioni, tile senza {z}/{x}/{y} e schemi strani", () => {
    const out = sanitizeBasemaps([
      { id: "a", label: "A", tiles: T, attribution: "© a", maxzoom: 18 },
      { id: "a", label: "doppione", tiles: T },
      { id: "b", tiles: "https://x/senza-segnaposto.png" },
      { id: "c", tiles: "javascript:alert(1)/{z}/{x}/{y}" },
      { id: "bad id!", tiles: T },
      { id: "n", label: "Nessuno", tiles: "" },
      { id: "rel", tiles: "/tiles/{z}/{x}/{y}.png" },
      null, 3, "x",
    ]);
    expect(out.map((b) => b.id)).toEqual(["a", "n", "rel"]);
    expect(out[0]).toEqual({ id: "a", label: "A", tiles: T, attribution: "© a", maxzoom: 18 });
    expect(out[1]).toEqual({ id: "n", label: "Nessuno" });
    expect(out[2].label).toBe("rel");
    expect(sanitizeBasemaps("x")).toEqual([]);
  });
  it("resolveBasemaps: elenco configurato se valido, altrimenti quello predefinito", () => {
    expect(resolveBasemaps({ basemapTiles: T }).length).toBe(4);
    expect(resolveBasemaps({ basemapTiles: T, basemaps: [{ id: "x", tiles: T }] }).map((b) => b.id)).toEqual(["x"]);
    expect(resolveBasemaps({ basemapTiles: T, basemaps: [{ id: "bad", tiles: "ftp://x" }] }).length).toBe(4);
  });
  it("pickBasemap ricade sul primo se l'id non esiste", () => {
    const l = defaultBasemaps(T);
    expect(pickBasemap(l, "sat").id).toBe("sat");
    expect(pickBasemap(l, "boh").id).toBe("osm");
    expect(pickBasemap(l).id).toBe("osm");
  });
});

describe("stile e cambio di sfondo", () => {
  const list = defaultBasemaps(T);
  it("crea sfondo + un raster per sfondo con tile; solo quello scelto è visibile; 'nessuno' non crea sorgenti", () => {
    const st = basemapStyle(list, "dark");
    expect(Object.keys(st.sources)).toEqual(["bm-osm", "bm-sat", "bm-dark"]);
    expect(st.layers.map((l) => l.id)).toEqual(["bg", "bm-osm", "bm-sat", "bm-dark"]);
    const vis = Object.fromEntries(st.layers.slice(1).map((l: any) => [l.id, l.layout.visibility]));
    expect(vis).toEqual({ "bm-osm": "none", "bm-sat": "none", "bm-dark": "visible" });
    expect((st.sources["bm-sat"] as any).attribution).toMatch(/Esri/);
    expect((st.sources["bm-sat"] as any).maxzoom).toBe(19);
  });
  it("con 'nessuno' tutti i raster sono nascosti e resta lo sfondo", () => {
    const st = basemapStyle(list, "none");
    expect(st.layers.slice(1).every((l: any) => l.layout.visibility === "none")).toBe(true);
  });
  it("id sconosciuto -> il primo sfondo", () => {
    expect((basemapStyle(list, "zzz").layers[1] as any).layout.visibility).toBe("visible");
  });
  it("applyBasemap accende solo lo sfondo scelto e ignora layer mancanti", () => {
    const calls: [string, string][] = [];
    const map = {
      getLayer: (id: string) => id !== "bm-dark",
      setLayoutProperty: vi.fn((id: string, _p: string, v: string) => { calls.push([id, v]); }),
    };
    applyBasemap(map, list, "sat");
    expect(calls).toEqual([["bm-osm", "none"], ["bm-sat", "visible"]]);
  });
});
