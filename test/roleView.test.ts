import { describe, expect, it } from "vitest";
import { formatBbox, isEmptyView, parseBbox, startViewFor, validBbox, type RoleView } from "../src/roleView";

const V = (role: string, extra: Partial<RoleView> = {}): RoleView => ({ role, basemap: "", layers: [], ...extra });

describe("riquadro (bbox)", () => {
  it("parseBbox: quattro numeri in gradi, ovest < est e sud < nord", () => {
    expect(parseBbox("12.45,41.85,12.55,41.95")).toEqual([12.45, 41.85, 12.55, 41.95]);
    expect(parseBbox(" -10, -5 , 10 , 5 ")).toEqual([-10, -5, 10, 5]);
    for (const bad of ["", "  ", "1,2,3", "1,2,3,4,5", "a,b,c,d", "12,41,11,42", "12,42,13,41", "-181,0,0,1", "0,-91,1,0", "1e2,0,2e2,1", null, undefined, 42])
      expect(parseBbox(bad as never), String(bad)).toBeUndefined();
  });
  it("formatBbox: 6 decimali, vuoto senza riquadro; ritorna uguale da parseBbox", () => {
    expect(formatBbox([12.1234567, 41.1, 13, 42.000000049])).toBe("12.123457,41.1,13,42");
    expect(formatBbox(undefined)).toBe("");
    expect(parseBbox(formatBbox([-9.5, 36, 18.75, 47.1]))).toEqual([-9.5, 36, 18.75, 47.1]);
  });
  it("validBbox", () => {
    expect(validBbox([0, 0, 1, 1])).toBe(true);
    expect(validBbox([0, 0, 0, 1])).toBe(false);
    expect(validBbox([0, 0, NaN, 1])).toBe(false);
    expect(validBbox("0,0,1,1")).toBe(false);
  });
  it("isEmptyView", () => {
    expect(isEmptyView(V("a"))).toBe(true);
    expect(isEmptyView(V("a", { basemap: "  " }))).toBe(true);
    expect(isEmptyView(V("a", { basemap: "sat" }))).toBe(false);
    expect(isEmptyView(V("a", { layers: ["x"] }))).toBe(false);
    expect(isEmptyView(V("a", { bbox: [0, 0, 1, 1] }))).toBe(false);
  });
});

describe("startViewFor", () => {
  const views = [
    V("viewer", { bbox: [12, 41, 13, 42], basemap: "grigio", layers: ["a", "b"] }),
    V("ops", { bbox: [9, 45, 10, 46], layers: ["b", "c"] }),
    V("analyst", { basemap: "sat" }),
    V("vuota"),
  ];
  it("nessuna vista per i ruoli dell'utente (o solo vuote): null", () => {
    expect(startViewFor(["altro"], views)).toBeNull();
    expect(startViewFor(["vuota"], views)).toBeNull();
    expect(startViewFor([], views)).toBeNull();
  });
  it("un ruolo: la sua vista", () => {
    expect(startViewFor(["viewer", "x"], views)).toEqual({ bbox: [12, 41, 13, 42], basemap: "grigio", layers: ["a", "b"], roles: ["viewer"] });
  });
  it("più ruoli: area che le contiene tutte, layer uniti senza doppioni, sfondo del primo ruolo (alfabetico) che lo indica", () => {
    expect(startViewFor(["viewer", "ops"], views)).toEqual({ bbox: [9, 41, 13, 46], basemap: "grigio", layers: ["b", "c", "a"], roles: ["ops", "viewer"] });
    expect(startViewFor(["viewer", "analyst"], views)).toMatchObject({ basemap: "sat", bbox: [12, 41, 13, 42] });
  });
  it("campi non indicati restano assenti (vale l'impostazione globale)", () => {
    const sv = startViewFor(["analyst"], views)!;
    expect(sv).toEqual({ basemap: "sat", roles: ["analyst"] });
    expect("layers" in sv).toBe(false);
    expect("bbox" in sv).toBe(false);
  });
});
