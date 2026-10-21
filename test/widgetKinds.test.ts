import { describe, expect, it } from "vitest";
import type { WidgetDef } from "../src/configStore";
import { buildItems } from "../src/Widgets";
import { gaugeLevel, gaugeScale, periodKey, pieSlices, propsFor, tableRows, widgetProblems } from "../src/widgetKinds";
import { sanitizeWidget } from "../src/dashboardIO";

const W = (extra: Partial<WidgetDef>): WidgetDef => ({ id: "w", type: "kpi", title: "T", layer: "ws:l", agg: "count", w: 1, ...extra });

describe("widgetProblems", () => {
  it("campi richiesti per tipo", () => {
    expect(widgetProblems(W({ layer: "" }))).toEqual(["«T»: scegli un layer."]);
    expect(widgetProblems(W({ type: "pie" }))).toEqual(["«T»: scegli il campo."]);
    expect(widgetProblems(W({ type: "line", field: "d", agg: "sum" }))).toEqual(["«T»: somma, media, minimo e massimo hanno bisogno di un campo del valore."]);
    expect(widgetProblems(W({ type: "table" }))).toEqual(["«T»: scegli almeno una colonna."]);
    expect(widgetProblems(W({ type: "text", layer: "", text: "  " }))).toEqual(["«T»: scrivi il testo."]);
    expect(widgetProblems(W({ type: "text", layer: "", text: "ok" }))).toEqual([]);
    expect(widgetProblems(W({ type: "map" }))).toEqual([]);
  });
  it("indicatore: soglie presenti e nell'ordine della direzione, scala coerente", () => {
    expect(widgetProblems(W({ type: "gauge" }))).toEqual(["«T»: indica le due soglie."]);
    expect(widgetProblems(W({ type: "gauge", warn: 10, crit: 5 }))).toEqual(["«T»: la soglia critica deve venire dopo quella di attenzione."]);
    expect(widgetProblems(W({ type: "gauge", warn: 10, crit: 5, higherIsWorse: false }))).toEqual([]);
    expect(widgetProblems(W({ type: "gauge", warn: 1, crit: 2, min: 5, max: 5 }))).toEqual(["«T»: il minimo della scala deve essere minore del massimo."]);
  });
});

describe("dati e calcoli", () => {
  it("propsFor: attributi da scaricare", () => {
    expect(propsFor(W({ type: "bar", field: "k", agg: "sum", valueField: "v" }))).toEqual(["k", "v"]);
    expect(propsFor(W({ type: "table", columns: ["a", "b"], sortField: "c" }))).toEqual(["a", "b", "c"]);
    expect(propsFor(W({ type: "table", columns: ["a"], sortField: "a" }))).toEqual(["a"]);
    expect(propsFor(W({ type: "text" }))).toEqual([]);
    expect(propsFor(W({ type: "map" }))).toEqual([]);
  });
  it("torta: le prime 5 categorie e il resto in 'Altri'; niente spicchi a zero", () => {
    const items = ["a", "b", "c", "d", "e", "f", "g"].map((k, i) => ({ key: k, label: k, value: 10 - i }));
    const s = pieSlices([...items, { key: "z", label: "z", value: 0 }]);
    expect(s.map((x) => x.label)).toEqual(["a", "b", "c", "d", "e", "Altri (2)"]);
    expect(s.at(-1)!.value).toBe(5 + 4); // f e g
    expect(pieSlices(items.slice(0, 6)).length).toBe(6); // 6 categorie: nessun "Altri" con una sola voce
  });
  it("torta e linea da buildItems", () => {
    const rows = [{ k: "A", d: "2026-01-05" }, { k: "A", d: "2026-01-20" }, { k: "B", d: "2026-03-01T10:00:00Z" }, { k: null, d: "rotto" }];
    expect(buildItems(W({ type: "pie", field: "k" }), rows).map((i) => [i.label, i.value])).toEqual([["A", 2], ["B", 1], ["(vuoto)", 1]]);
    expect(buildItems(W({ type: "line", field: "d" }), rows).map((i) => [i.label, i.value])).toEqual([["2026-01", 2], ["2026-03", 1]]);
    expect(buildItems(W({ type: "line", field: "d", granularity: "day" }), rows).map((i) => i.label)).toEqual(["2026-01-05", "2026-01-20", "2026-03-01"]);
    expect(buildItems(W({ type: "line", field: "d", granularity: "year" }), rows).map((i) => [i.label, i.value])).toEqual([["2026", 3]]);
  });
  it("periodKey", () => {
    expect(periodKey("2026-05-07T00:00:00Z", "day")).toBe("2026-05-07");
    expect(periodKey("2026-05", "day")).toBeNull();
    expect(periodKey("2026-05", "month")).toBe("2026-05");
    expect(periodKey(null, "year")).toBeNull();
  });
  it("tabella: ordinamento con numeri, testo naturale e vuoti in fondo; limite tra 1 e 100", () => {
    const rows = [{ n: 2, s: "b10" }, { n: null, s: "b2" }, { n: 10, s: "" }, { n: 1, s: "a" }];
    expect(tableRows(rows, W({ type: "table", sortField: "n", limit: 10 })).map((r) => r.n)).toEqual([1, 2, 10, null]);
    expect(tableRows(rows, W({ type: "table", sortField: "n", sortDesc: true, limit: 10 })).map((r) => r.n)).toEqual([10, 2, 1, null]);
    expect(tableRows(rows, W({ type: "table", sortField: "s", limit: 10 })).map((r) => r.s)).toEqual(["a", "b2", "b10", ""]);
    expect(tableRows(rows, W({ type: "table", limit: 2 }))).toHaveLength(2);
    expect(tableRows(rows, W({ type: "table", limit: 0 }))).toHaveLength(1);
    expect(tableRows(Array.from({ length: 300 }, (_, i) => ({ i })), W({ type: "table", limit: 500 }))).toHaveLength(100);
    expect(tableRows(rows, W({ type: "table" }))).toHaveLength(4); // predefinito 10
  });
  it("indicatore: livelli nelle due direzioni e scala", () => {
    const hi = { warn: 50, crit: 80 };
    expect([10, 50, 79, 80, 200].map((v) => gaugeLevel(v, hi))).toEqual(["good", "warning", "warning", "critical", "critical"]);
    const lo = { warn: 20, crit: 10, higherIsWorse: false };
    expect([30, 20, 11, 10, 0].map((v) => gaugeLevel(v, lo))).toEqual(["good", "warning", "warning", "critical", "critical"]);
    expect(gaugeScale(50, { warn: 50, crit: 80 })).toEqual([0, 96]);
    expect(gaugeScale(-5, { warn: 1, crit: 2 })).toEqual([-5, 2.4]);
    expect(gaugeScale(5, { min: 0, max: 10 })).toEqual([0, 10]);
    expect(gaugeScale(0, {})).toEqual([0, 1]);
  });
});

describe("importazione dei nuovi tipi", () => {
  const uid = () => "u1";
  it("opzioni dei nuovi tipi tenute e pulite", () => {
    expect(sanitizeWidget({ type: "gauge", layer: "l", warn: 5, crit: "x", higherIsWorse: false, min: 0, max: Infinity }, uid)).toMatchObject({ warn: 5, higherIsWorse: false, min: 0 });
    expect(sanitizeWidget({ type: "table", layer: "l", columns: ["a", 3, ""], sortField: "a", sortDesc: true, limit: 900 }, uid)).toMatchObject({ columns: ["a"], sortField: "a", sortDesc: true, limit: 100 });
    expect(sanitizeWidget({ type: "line", layer: "l", granularity: "week" }, uid)).not.toHaveProperty("granularity");
    expect(sanitizeWidget({ type: "line", layer: "l", granularity: "day" }, uid)).toMatchObject({ granularity: "day" });
  });
  it("testo: senza layer; senza testo scartato; il layer eventuale viene ignorato", () => {
    expect(sanitizeWidget({ type: "text", text: "ciao", layer: "x" }, uid)).toMatchObject({ type: "text", layer: "", text: "ciao" });
    expect(sanitizeWidget({ type: "text", text: "  " }, uid)).toBeNull();
    expect(sanitizeWidget({ type: "map" }, uid)).toBeNull();
  });
});
