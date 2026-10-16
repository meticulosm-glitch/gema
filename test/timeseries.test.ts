// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fetchSeries, numericProps, runPool, seriesCsv, toNumber } from "../src/timeseries";
import { mockFetch } from "./support";

const map: any = { project: ([x, y]: number[]) => ({ x: x * 100, y: y * 100 }), unproject: ([x, y]: number[]) => ({ lng: x / 100, lat: y / 100 }) };
const feat = (props: Record<string, unknown> | null) => JSON.stringify({ features: props ? [{ id: "", geometry: null, properties: props }] : [] });

describe("toNumber / numericProps", () => {
  it("numeri e stringhe numeriche; NaN, vuoti e testo -> null", () => {
    expect(toNumber(0.5)).toBe(0.5);
    expect(toNumber("12.5")).toBe(12.5);
    for (const v of [NaN, "NaN", "", "  ", "abc", null, undefined, {}, Infinity]) expect(toNumber(v), String(v)).toBeNull();
  });
  it("prende le proprietà del primo oggetto con proprietà", () => {
    expect(numericProps([{ geometry: null, properties: null }, { geometry: null, properties: { b1: 1, b2: "x", b3: "3" } }])).toEqual({ b1: 1, b2: null, b3: 3 });
    expect(numericProps([])).toEqual({});
  });
});

describe("runPool", () => {
  it("rispetta il limite di richieste contemporanee e l'ordine dei risultati", async () => {
    let running = 0, peak = 0;
    const out = await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5 * (8 - n)));
      running--;
      return n * 10;
    });
    expect(peak).toBe(3);
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });
  it("si ferma quando il segnale è annullato", async () => {
    const ctrl = new AbortController();
    const seen: number[] = [];
    await runPool([1, 2, 3, 4, 5], 1, async (n) => { seen.push(n); if (n === 2) ctrl.abort(); }, ctrl.signal);
    expect(seen).toEqual([1, 2]);
  });
});

describe("fetchSeries", () => {
  const base = { gsUrl: "/g", kc: null, layer: "a:ndvi", map, ll: { lng: 12, lat: 42 }, params: { style: "ramp", cql: "q=1" } };

  it("una GetFeatureInfo per istante, con il TIME di ciascuno, e serie ordinata nel tempo", async () => {
    const f = mockFetch((url) => {
      const t = /time=([^&]+)/.exec(url)![1];
      return { body: feat({ GRAY_INDEX: t.startsWith("2026-02") ? "NaN" : Number(t.slice(8, 10)) }) };
    });
    const r = await fetchSeries({ ...base, times: ["2026-03-05", "2026-01-10", "2026-02-01"] });
    expect(r.points.map((p) => p.t)).toEqual(["2026-01-10", "2026-02-01", "2026-03-05"]);
    expect(r.points.map((p) => p.values.GRAY_INDEX)).toEqual([10, null, 5]);
    expect(r.fields).toEqual(["GRAY_INDEX"]);
    expect(r.failed).toBe(0);
    const urls = f.mock.calls.map(([u]) => String(u));
    expect(urls).toHaveLength(3);
    for (const u of urls) { expect(u).toContain("request=GetFeatureInfo"); expect(u).toContain("&styles=ramp"); expect(u).toContain("&cql_filter=q%3D1"); }
    expect(urls.some((u) => u.includes("&time=2026-02-01"))).toBe(true);
  });

  it("date non interpretabili: l'asse x è l'indice", async () => {
    mockFetch(() => ({ body: feat({ v: 1 }) }));
    const r = await fetchSeries({ ...base, times: ["a", "b", "c"] });
    expect(r.points.map((p) => p.x)).toEqual([0, 1, 2]);
  });

  it("una richiesta fallita non butta via le altre", async () => {
    mockFetch((url) => (url.includes("time=2026-02-01") ? { status: 500, body: "boom" } : { body: feat({ v: 2 }) }));
    const r = await fetchSeries({ ...base, times: ["2026-01-01", "2026-02-01", "2026-03-01"] });
    expect(r.failed).toBe(1);
    expect(r.points[1].error).toMatch(/HTTP 500/);
    expect(r.points[0].values.v).toBe(2);
  });

  it("nessun oggetto nel punto: valori vuoti, nessun errore", async () => {
    mockFetch(() => ({ body: feat(null) }));
    const r = await fetchSeries({ ...base, times: ["2026-01-01", "2026-02-01"] });
    expect(r.fields).toEqual([]);
    expect(r.failed).toBe(0);
  });

  it("annullata: nessun risultato e aborted", async () => {
    const ctrl = new AbortController();
    mockFetch(async () => { ctrl.abort(); return { body: feat({ v: 1 }) }; });
    const r = await fetchSeries({ ...base, times: ["2026-01-01", "2026-02-01", "2026-03-01"], signal: ctrl.signal, concurrency: 1 });
    expect(r.aborted).toBe(true);
  });

  it("segnala l'avanzamento", async () => {
    mockFetch(() => ({ body: feat({ v: 1 }) }));
    const seen: number[] = [];
    await fetchSeries({ ...base, times: ["2026-01-01", "2026-02-01"], onProgress: (d) => seen.push(d) });
    expect(seen).toEqual([1, 2]);
  });
});

describe("seriesCsv", () => {
  it("istante e valore, vuoto dove manca il dato", () => {
    const csv = seriesCsv([{ t: "2026-01-01", x: 1, values: { a: 1.5 } }, { t: "2026-02-01", x: 2, values: { a: null } }], "a");
    expect(csv).toBe("time,a\n2026-01-01,1.5\n2026-02-01,\n");
  });
});
