// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { AoiControl, aoiView, goToAoi } from "../src/aoiControl";

const base = { mapCenter: [12.5, 42] as [number, number], mapZoom: 5 };

describe("aoiView", () => {
  it("senza riquadro: centro e zoom iniziali", () => {
    expect(aoiView(base)).toEqual({ center: [12.5, 42], zoom: 5 });
  });
  it("con MAP_BBOX valido: il riquadro (ovest,sud,est,nord)", () => {
    expect(aoiView({ ...base, mapBounds: [6.6, 36.6, 18.5, 47.1] })).toEqual({ bounds: [[6.6, 36.6], [18.5, 47.1]] });
  });
  it("coordinate negative (emisfero ovest/sud) sono valide", () => {
    expect(aoiView({ ...base, mapBounds: [-10, -5, -2, 3] })).toEqual({ bounds: [[-10, -5], [-2, 3]] });
  });
  it.each([
    ["ovest ≥ est", [18, 36, 6, 47]],
    ["sud ≥ nord", [6, 47, 18, 36]],
    ["riquadro nullo", [6, 36, 6, 36]],
    ["valore non numerico", [6, NaN, 18, 47]],
    ["lunghezza errata", [6, 36, 18]],
  ])("riquadro non valido (%s): ricade su centro e zoom", (_n, b) => {
    expect(aoiView({ ...base, mapBounds: b as any })).toEqual({ center: [12.5, 42], zoom: 5 });
  });
});

describe("goToAoi", () => {
  it("con riquadro usa fitBounds con un po' di margine", () => {
    const map = { fitBounds: vi.fn(), easeTo: vi.fn() };
    goToAoi(map, { ...base, mapBounds: [6.6, 36.6, 18.5, 47.1] });
    expect(map.easeTo).not.toHaveBeenCalled();
    expect(map.fitBounds).toHaveBeenCalledWith([[6.6, 36.6], [18.5, 47.1]], expect.objectContaining({ padding: 30, duration: 800 }));
  });
  it("senza riquadro usa easeTo e non tocca inclinazione e rotazione", () => {
    const map = { fitBounds: vi.fn(), easeTo: vi.fn() };
    goToAoi(map, base);
    expect(map.fitBounds).not.toHaveBeenCalled();
    const opts = map.easeTo.mock.calls[0][0];
    expect(opts).toMatchObject({ center: [12.5, 42], zoom: 5 });
    expect(opts).not.toHaveProperty("pitch");
    expect(opts).not.toHaveProperty("bearing");
  });
});

describe("AoiControl", () => {
  it("è un pulsante accessibile dentro il gruppo di controlli della mappa", () => {
    const el = new AoiControl(() => {}).onAdd();
    expect(el.className).toBe("maplibregl-ctrl maplibregl-ctrl-group");
    const btn = el.querySelector("button")!;
    expect(btn.type).toBe("button");
    expect(btn.title).toBe("Zoom sull'area di interesse");
    expect(btn.getAttribute("aria-label")).toBe("Zoom sull'area di interesse");
    expect(btn.querySelector("svg")).not.toBeNull();
  });
  it("il clic richiama l'azione", () => {
    const onClick = vi.fn();
    const el = new AoiControl(onClick).onAdd();
    el.querySelector("button")!.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  it("etichetta personalizzabile; onRemove rimuove l'elemento dal DOM", () => {
    const c = new AoiControl(() => {}, "Home");
    const el = c.onAdd();
    document.body.appendChild(el);
    expect(el.querySelector("button")!.title).toBe("Home");
    c.onRemove();
    expect(document.body.contains(el)).toBe(false);
    expect(() => c.onRemove()).not.toThrow();
  });
});
