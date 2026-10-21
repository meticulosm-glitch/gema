import { describe, expect, it } from "vitest";
import { runEntrypoint } from "./shell";

const cfgOf = async (env: Record<string, string>) => {
  const r = await runEntrypoint("40-runtime-config.sh", { AUTH_ENABLED: "false", ...env });
  expect(r.code, r.stderr).toBe(0);
  return { cfg: JSON.parse(r.configJson ?? ""), out: r.stdout };
};

describe("config.json: DOWNLOAD_MAX_FEATURES", () => {
  it("di default 50000", async () => {
    expect((await cfgOf({})).cfg.downloadMaxFeatures).toBe(50000);
  });
  it("valore personalizzato", async () => {
    expect((await cfgOf({ DOWNLOAD_MAX_FEATURES: "250000" })).cfg.downloadMaxFeatures).toBe(250000);
  });
  it.each(["abc", "-5", "0", "012", "1e6", "10 000"])("%s non è valido: default e avviso, JSON sempre valido", async (v) => {
    const { cfg, out } = await cfgOf({ DOWNLOAD_MAX_FEATURES: v });
    expect(cfg.downloadMaxFeatures).toBe(50000);
    expect(out).toContain("DOWNLOAD_MAX_FEATURES ignorato");
  });
});
