import { describe, expect, it } from "vitest";
import { aggregate, buildItems, isDate, isNum } from "../src/Widgets";
import type { WidgetDef } from "../src/configStore";

const def = (partial: Partial<WidgetDef> & Pick<WidgetDef, "type">): WidgetDef => ({
  id: "w", title: "t", layer: "iride:a", agg: "count", w: 1, ...partial,
});

const fmt = (n: number) => n.toLocaleString("it-IT", { maximumFractionDigits: 2 });

describe("tipi attributo", () => {
  it("riconosce numeri e date in modo case-insensitive", () => {
    expect(isNum("Double")).toBe(true);
    expect(isNum("string")).toBe(false);
    expect(isDate("dateTime")).toBe(true);
    expect(isDate("Date")).toBe(true);
    expect(isDate("updated")).toBe(false);
  });
});

describe("aggregate", () => {
  const rows = [{ v: 2 }, { v: "4" }, { v: "x" }, { v: undefined }];

  it("count conta le righe anche senza campo valore", () => {
    expect(aggregate(rows, "count")).toBe(4);
    expect(aggregate(rows, "sum")).toBe(4);
  });

  it("calcola sum, avg, min e max ignorando i non numerici", () => {
    expect(aggregate(rows, "sum", "v")).toBe(6);
    expect(aggregate(rows, "avg", "v")).toBe(3);
    expect(aggregate(rows, "min", "v")).toBe(2);
    expect(aggregate(rows, "max", "v")).toBe(4);
    expect(aggregate([{ v: "x" }], "avg", "v")).toBe(0);
    expect(aggregate([{ v: null }], "sum", "v")).toBe(0);
  });
});

describe("buildItems", () => {
  it("raggruppa le barre, quota i letterali e tiene solo le prime 8", () => {
    const rows = [
      ...Array.from({ length: 9 }, (_, i) => ({ classe: `c${i}`, n: 1 })),
      { classe: "", n: 1 },
      { classe: null, n: 1 },
      { classe: "a-b", n: 20 },
      { classe: `o'brien`, n: 15 },
    ];
    const items = buildItems(def({ type: "bar", field: "classe", agg: "sum", valueField: "n" }), rows);
    expect(items.length).toBeLessThanOrEqual(8);
    expect(items.map((i) => i.value)).toEqual([...items.map((i) => i.value)].sort((a, b) => b - a));
    const empty = items.find((i) => i.key === "\u0000");
    expect(empty).toMatchObject({ label: "(vuoto)", value: 2, cql: "classe IS NULL" });
    expect(items.find((i) => i.key === "a-b")?.cql).toBe("classe = 'a-b'");
    expect(items.find((i) => i.key === "o'brien")?.cql).toBe("classe = 'o''brien'");
    const quoted = buildItems(def({ type: "bar", field: "a-b", agg: "count" }), [{ "a-b": "x" }]);
    expect(quoted[0].cql).toBe(`"a-b" = 'x'`);
  });

  it("non quota i valori numerici", () => {
    const items = buildItems(def({ type: "bar", field: "anno", agg: "count" }), [{ anno: 2024 }, { anno: 2024 }, { anno: 2020 }]);
    expect(items[0]).toMatchObject({ key: "2024", value: 2, cql: "anno = 2024" });
    expect(items.find((i) => i.key === "2020")?.cql).toBe("anno = 2020");
  });

  it("aggrega le serie temporali per mese e tiene gli ultimi 36", () => {
    const rows = Array.from({ length: 40 }, (_, i) => {
      const month = (i % 12) + 1;
      const year = 2020 + Math.floor(i / 12);
      return { t: `${year}-${String(month).padStart(2, "0")}-15`, n: 1 };
    });
    rows.push({ t: "non-una-data", n: 9 });
    const items = buildItems(def({ type: "time", field: "t", agg: "count" }), rows);
    expect(items).toHaveLength(36);
    expect(items[0].key < items[items.length - 1].key).toBe(true);
    expect(items[0].key).toBe("2020-05");
    expect(items.every((i) => i.cql === undefined)).toBe(true);
  });

  it("costruisce un istogramma a classi uguali", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ v: i }));
    const items = buildItems(def({ type: "hist", field: "v" }), rows);
    expect(items).toHaveLength(10);
    expect(items.map((i) => i.value)).toEqual(Array(10).fill(1));
    expect(items[0].label).toBe(fmt(0));
    expect(items[1].label).toBe(fmt(0.9));
    expect(buildItems(def({ type: "hist", field: "v" }), [{ v: "x" }])).toEqual([]);
    expect(buildItems(def({ type: "kpi", field: "v" }), [{ v: 1 }])).toEqual([]);
    expect(buildItems(def({ type: "bar" }), [])).toEqual([]);
  });
});
