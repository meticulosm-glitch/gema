import { describe, expect, it } from "vitest";
import { runEntrypoint } from "./shell";

const cfgOf = async (env: Record<string, string>) => {
  const r = await runEntrypoint("40-runtime-config.sh", { AUTH_ENABLED: "false", ...env });
  expect(r.code, r.stderr).toBe(0);
  return { cfg: JSON.parse(r.configJson ?? ""), out: r.stdout };
};

describe("MAP_BBOX (area di interesse)", () => {
  it("senza MAP_BBOX non compare mapBounds", async () => {
    expect((await cfgOf({})).cfg.mapBounds).toBeUndefined();
  });
  it("riquadro valido, anche con spazi e negativi", async () => {
    const { cfg } = await cfgOf({ MAP_BBOX: " 6.6, 36.6 ,18.5, 47.1 " });
    expect(cfg.mapBounds).toEqual([6.6, 36.6, 18.5, 47.1]);
    expect((await cfgOf({ MAP_BBOX: "-10,-5,-2,3" })).cfg.mapBounds).toEqual([-10, -5, -2, 3]);
  });
  it.each(["6.6,36.6,18.5", "a,b,c,d", "6.6,36.6,18.5,47.1,9", "6.6;36.6;18.5;47.1", '1,2,3,4"}, "x": {"'])("valore non valido (%s): ignorato con avviso, il JSON resta valido", async (bad) => {
    const { cfg, out } = await cfgOf({ MAP_BBOX: bad });
    expect(cfg.mapBounds).toBeUndefined();
    expect(out).toContain("MAP_BBOX ignorato");
    expect(cfg.mapZoom).toBe(5); // centro e zoom restano quelli di default
  });
  it("centro e zoom restano nella config anche con il riquadro (servono alla vista iniziale)", async () => {
    const { cfg } = await cfgOf({ MAP_BBOX: "6,36,18,47", MAP_CENTER_LON: "9", MAP_CENTER_LAT: "45", MAP_ZOOM: "7" });
    expect(cfg.mapCenter).toEqual([9, 45]);
    expect(cfg.mapZoom).toBe(7);
    expect(cfg.mapBounds).toEqual([6, 36, 18, 47]);
  });
});
