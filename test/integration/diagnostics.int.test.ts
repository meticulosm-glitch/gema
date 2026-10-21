// @vitest-environment jsdom
// Diagnostica contro GeoServer reale con le tabelle pubblicate dal Job: capabilities, schema e lettura di ogni tabella
// (colonne attese = quelle create da mapp-config.sql), prova di scrittura che non cambia nessuna riga, tabella assente.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AccessConfig, AppConfig } from "../../src/config";
import { CONFIG_TABLES, loadRules, saveRule } from "../../src/configStore";
import { checkGeoServer, checkTable, checkWrite, type DiagContext } from "../../src/diagnostics";
import { gs, missing, pg, preparedWorkspace, required } from "./support";

const withGs = !!gs && gs.publish && !!pg;
if (!withGs && required) throw new Error(missing("GeoServer", "INT_GEOSERVER_URL e PostgreSQL (INT_PGHOST, ...)"));

describe.skipIf(!withGs)("diagnostica su GeoServer reale", () => {
  let w: Awaited<ReturnType<typeof preparedWorkspace>>;
  let acc: AccessConfig;
  const G = gs ?? { url: "" };
  const kc = { token: undefined, tokenParsed: { preferred_username: "it-admin" } } as never;
  const ctx = (): DiagContext => ({ cfg: { apiUrl: "", geoserverUrl: G.url, basemapTiles: "", mapCenter: [12, 42], mapZoom: 5, access: acc } as AppConfig, acc, gs: G.url, kc, origin: "http://localhost", timeoutMs: 20_000 });

  beforeAll(async () => {
    w = await preparedWorkspace("gema_dg");
    acc = { enabled: true, adminRole: "a", viewerRole: "v", rolesClient: "c", knownRoles: [], workspace: w.ws };
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(G.url)) return realFetch(input, init);
      const headers = new Headers(init.headers);
      if (!headers.has("Authorization")) headers.set("Authorization", w.basic);
      return realFetch(input, { ...init, headers });
    });
  });
  afterAll(async () => { vi.unstubAllGlobals(); await w?.cleanup(); });

  it("GeoServer: WMS e WFS rispondono", async () => {
    const [wms, wfs] = await checkGeoServer(ctx());
    expect(wms.status).not.toBe("fail");
    expect(wfs.status).toBe("ok");
  });

  it("tutte le tabelle pubblicate dal Job hanno le colonne attese e si leggono", async () => {
    const r = await Promise.all(CONFIG_TABLES.map((t) => checkTable(ctx(), t)));
    expect(r.filter((x) => x.status !== "ok").map((x) => `${x.label}: ${x.detail}`)).toEqual([]);
  });

  it("tabella non pubblicata: riconosciuta come tale", async () => {
    expect(await checkTable(ctx(), "non_esiste")).toMatchObject({ status: "fail", detail: "Non pubblicata in GeoServer." });
  });

  it("prova di scrittura accettata senza toccare le righe", async () => {
    await saveRule(G.url, kc, acc, { role: "ruolo-x", layers: ["*"], tools: [] });
    const before = await loadRules(G.url, kc, acc);
    expect(await checkWrite(ctx())).toMatchObject({ status: "ok" });
    expect(await loadRules(G.url, kc, acc)).toEqual(before);
  });
});
