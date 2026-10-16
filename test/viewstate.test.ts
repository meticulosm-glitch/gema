import { describe, expect, it } from "vitest";
import { captureView, encodeHash, parseHash, sanitizeViewState } from "../src/viewState";

describe("sanitizeViewState / parseHash", () => {
  it("un oggetto non valido dà una vista vuota", () => {
    for (const x of [null, undefined, 5, "x", []]) expect(sanitizeViewState(x)).toEqual({ l: [], v: undefined });
  });
  it("tiene vista, layer e sfondo; completa i campi mancanti dei layer", () => {
    const s = sanitizeViewState({ v: [12, 42, 6, 0, 0], l: [["a:b", 0.5, "x=1", "2026-01-01", "s1"], ["c:d"]], b: "sat" });
    expect(s.v).toEqual([12, 42, 6, 0, 0]);
    expect(s.l).toEqual([["a:b", 0.5, "x=1", "2026-01-01", "s1"], ["c:d", 1, "", "", ""]]);
    expect(s.b).toBe("sat");
  });
  it("scarta vista non numerica, layer senza nome e sfondo con caratteri strani", () => {
    const s = sanitizeViewState({ v: [1, "x", 3], l: [[""], [5], "z", ["ok"]], b: "<script>" });
    expect(s.v).toBeUndefined();
    expect(s.l.map((x) => x[0])).toEqual(["ok"]);
    expect(s.b).toBeUndefined();
  });
  it("parseHash legge #s=… ed è tollerante con link rotti o di versioni precedenti (senza sfondo)", () => {
    const h = encodeHash({ v: [1, 2, 3, 0, 0], l: [["x:y", 1, "", "", ""]], b: "dark" });
    expect(h.startsWith("#s=")).toBe(true);
    expect(parseHash(h)).toEqual({ v: [1, 2, 3, 0, 0], l: [["x:y", 1, "", "", ""]], b: "dark" });
    expect(parseHash("")).toEqual({ l: [] });
    expect(parseHash("#s=%E0%A4%A")).toEqual({ l: [] });
    expect(parseHash("#s=" + encodeURIComponent("{non json"))).toEqual({ l: [] });
    expect(parseHash("#altro")).toEqual({ l: [] });
    const old = parseHash("#s=" + encodeURIComponent(JSON.stringify({ v: [1, 2, 3], l: [["a", 1, "", ""]] })));
    expect(old.l[0]).toEqual(["a", 1, "", "", ""]);
    expect(old.b).toBeUndefined();
  });
});

describe("captureView", () => {
  const map = { getCenter: () => ({ lng: 12.1234567, lat: 41.9876543 }), getZoom: () => 7.456, getPitch: () => 59.6, getBearing: () => -19.5 };
  it("arrotonda e riporta layer nell'ordine di accensione, con i valori di default", () => {
    const s = captureView(map, ["a", "b"], { a: { opacity: 0.4, cql: "x=1", time: "t", style: "st" } }, "sat");
    expect(s.v).toEqual([12.12346, 41.98765, 7.46, 60, -19]);
    expect(s.l).toEqual([["a", 0.4, "x=1", "t", "st"], ["b", 1, "", "", ""]]);
    expect(s.b).toBe("sat");
  });
  it("senza sfondo non scrive la chiave b", () => {
    expect("b" in captureView(map, [], {})).toBe(false);
  });
  it("sopravvive all'andata e ritorno nel link", () => {
    const s = captureView(map, ["a"], { a: { opacity: 0.5 } }, "osm");
    expect(parseHash(encodeHash(s))).toEqual(s);
  });
});
