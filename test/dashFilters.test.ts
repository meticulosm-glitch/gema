import { describe, expect, it } from "vitest";
import {
  areaCql, dateCql, decodeDefinition, encodeDefinition, initialState, presetRange, sanitizeFilters, stateToSearch, widgetFilter, type DashFilters,
} from "../src/dashFilters";
import { duplicate, exportDashboards, parseImport, remapLayers } from "../src/dashboardIO";
import type { DashboardDef } from "../src/configStore";

const NOW = new Date("2026-10-20T15:00:00Z");
const F: DashFilters = { date: { fields: { "ws:a": "d", "ws:b": "data rilievo" }, preset: "30d" }, area: true };
const geom = (l: string) => ({ "ws:a": "geom", "ws:c": "the_geom" } as Record<string, string>)[l];

describe("periodi", () => {
  it("preset rispetto a oggi, fine compresa", () => {
    expect(presetRange("7d", NOW)).toEqual({ from: "2026-10-14", to: "2026-10-20" });
    expect(presetRange("30d", NOW)).toEqual({ from: "2026-09-21", to: "2026-10-20" });
    expect(presetRange("365d", NOW)).toEqual({ from: "2025-10-21", to: "2026-10-20" });
    expect(presetRange("ytd", NOW)).toEqual({ from: "2026-01-01", to: "2026-10-20" });
    expect(presetRange("all", NOW)).toEqual({ from: "", to: "" });
    expect(presetRange(undefined, NOW)).toEqual({ from: "", to: "" });
  });
  it("cambio di mese e anno bisestile", () => {
    expect(presetRange("7d", new Date("2028-03-02T00:00:00Z"))).toEqual({ from: "2028-02-25", to: "2028-03-02" });
    expect(dateCql("d", "", "2028-02-28")).toBe("d < '2028-02-29'");
    expect(dateCql("d", "", "2026-12-31")).toBe("d < '2027-01-01'");
  });
});

describe("stato e indirizzo", () => {
  it("dall'indirizzo, altrimenti dal preset", () => {
    expect(initialState(F, "", NOW)).toEqual({ from: "2026-09-21", to: "2026-10-20" });
    expect(initialState(F, "?dal=2026-01-01&al=2026-01-31&area=1,2,3,4", NOW)).toEqual({ from: "2026-01-01", to: "2026-01-31", bbox: [1, 2, 3, 4] });
    expect(initialState(F, "?dal=&al=", NOW)).toEqual({ from: "", to: "" }); // "tutto" scelto esplicitamente
    expect(initialState(F, "?dal=ieri&area=x", NOW)).toEqual({ from: "", to: "2026-10-20" }); // valori non validi ignorati
  });
  it("filtri non configurati: parametri ignorati", () => {
    expect(initialState(undefined, "?dal=2026-01-01&area=1,2,3,4", NOW)).toEqual({ from: "", to: "" });
    expect(initialState({ date: F.date }, "?area=1,2,3,4", NOW)).toEqual({ from: "2026-09-21", to: "2026-10-20" });
  });
  it("nell'indirizzo solo ciò che differisce dal predefinito; gli altri parametri restano", () => {
    expect(stateToSearch(F, { from: "2026-09-21", to: "2026-10-20" }, "", NOW)).toBe("");
    expect(stateToSearch(F, { from: "", to: "" }, "?x=1", NOW)).toBe("?x=1&dal=&al=");
    expect(stateToSearch(F, { from: "2026-09-21", to: "2026-10-20", bbox: [1, 2, 3, 4] }, "?dal=2026-01-01", NOW)).toBe("?area=1%2C2%2C3%2C4");
    const s = { from: "2026-02-01", to: "2026-02-28", bbox: [12.1, 41.2, 12.3, 41.4] as [number, number, number, number] };
    expect(initialState(F, stateToSearch(F, s, "", NOW), NOW)).toEqual(s); // andata e ritorno
  });
});

describe("CQL", () => {
  it("date: inizio compreso, fine compresa come < giorno dopo; nomi non semplici tra virgolette", () => {
    expect(dateCql("d", "2026-02-01", "2026-02-28")).toBe("d >= '2026-02-01' AND d < '2026-03-01'");
    expect(dateCql("data rilievo", "2026-02-01", "")).toBe(`"data rilievo" >= '2026-02-01'`);
    expect(dateCql("d", "x'; DROP", "")).toBe("");
  });
  it("area", () => expect(areaCql("geom", [1, 2, 3.5, 4])).toBe("BBOX(geom, 1, 2, 3.5, 4)"));
  it("per widget: data e area combinate; cosa non si applica viene detto", () => {
    const s = { from: "2026-02-01", to: "", bbox: [1, 2, 3, 4] as [number, number, number, number] };
    expect(widgetFilter("ws:a", F, s, geom)).toEqual({ cql: "d >= '2026-02-01' AND BBOX(geom, 1, 2, 3, 4)", skipped: [] });
    expect(widgetFilter("ws:b", F, s, geom)).toEqual({ cql: `"data rilievo" >= '2026-02-01'`, skipped: ["area"] });
    expect(widgetFilter("ws:c", F, s, geom)).toEqual({ cql: "BBOX(the_geom, 1, 2, 3, 4)", skipped: ["data"] });
    expect(widgetFilter("ws:z", F, s, geom)).toEqual({ cql: "", skipped: ["data", "area"] });
  });
  it("niente da filtrare: nessun avviso", () => {
    expect(widgetFilter("ws:z", F, { from: "", to: "" }, geom)).toEqual({ cql: "", skipped: [] });
    expect(widgetFilter("", F, { from: "2026-01-01", to: "" }, geom)).toEqual({ cql: "", skipped: [] }); // testo
    expect(widgetFilter("ws:a", undefined, { from: "2026-01-01", to: "" }, geom)).toEqual({ cql: "", skipped: [] });
  });
});

describe("salvataggio", () => {
  it("sanitize: tiene solo ciò che ha senso", () => {
    expect(sanitizeFilters({ date: { fields: { a: "d", b: "", c: 3 }, preset: "boh" }, area: "si" })).toEqual({ date: { fields: { a: "d" } } });
    expect(sanitizeFilters({ date: { fields: {} }, area: false })).toBeUndefined();
    expect(sanitizeFilters("x")).toBeUndefined();
    expect(sanitizeFilters({ area: true })).toEqual({ area: true });
  });
  it("definizione: elenco se senza filtri (compatibile), oggetto se con filtri", () => {
    expect(encodeDefinition([1])).toBe("[1]");
    expect(JSON.parse(encodeDefinition([1], F))).toEqual({ widgets: [1], filters: F });
    expect(decodeDefinition([1])).toEqual({ widgets: [1] });
    expect(decodeDefinition({ widgets: [1], filters: F })).toEqual({ widgets: [1], filters: F });
    expect(decodeDefinition({ widgets: [1], filters: { area: 1 } })).toEqual({ widgets: [1] });
    expect(decodeDefinition({ nope: 1 })).toEqual({ widgets: [] });
    expect(decodeDefinition(null)).toEqual({ widgets: [] });
  });
});

describe("esporta, duplica, importa con i filtri", () => {
  const D: DashboardDef = { fid: "dashboards.1", title: "T", description: "", roles: [], widgets: [{ id: "a", type: "kpi", title: "a", layer: "ws:a", agg: "count", w: 1 }], filters: F };
  it("esporta e duplica portano i filtri", () => {
    expect(exportDashboards([D], "h").dashboards[0].filters).toEqual(F);
    const c = duplicate(D, () => "u");
    expect(c.filters).toEqual(F);
    expect(c.filters).not.toBe(F);
  });
  it("importa: filtri puliti; rimappando un layer si sposta anche il suo campo data", () => {
    const r = parseImport(JSON.stringify({ format: "gema-dashboards", version: 1, dashboards: [{ ...D, fid: undefined, filters: { ...F, area: "x" } }] }), () => "u");
    expect(r.items[0].filters).toEqual({ date: F.date });
    const m = remapLayers(r.items, { "ws:a": "ws:nuovo" });
    expect(m[0].widgets[0].layer).toBe("ws:nuovo");
    expect(m[0].filters!.date!.fields).toEqual({ "ws:nuovo": "d", "ws:b": "data rilievo" });
  });
});
