import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";

afterEach(() => vi.unstubAllGlobals());

describe("loadConfig", () => {
  it("scarica /config.json senza cache", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ apiUrl: "/api", geoserverUrl: "/geoserver", basemapTiles: "x", mapCenter: [0, 0], mapZoom: 3 }) }));
    vi.stubGlobal("fetch", fetchMock);
    const cfg = await loadConfig();
    expect(cfg.mapZoom).toBe(3);
    expect(fetchMock).toHaveBeenCalledWith("/config.json", { cache: "no-store" });
  });

  it("fallisce con lo status HTTP se il file non c'è", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    await expect(loadConfig()).rejects.toThrow("config.json non disponibile (404)");
  });
});
