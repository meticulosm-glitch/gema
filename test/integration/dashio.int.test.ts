// @vitest-environment jsdom
// Dashboard: esportazione e importazione con GeoServer reale (nessuna tabella nuova: usa dashboards).
// Il JSON esportato torna identico, e l'importazione di più dashboard è una sola transazione tutto-o-niente.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AccessConfig } from "../../src/config";
import { importDashboards, loadDashboards, saveDashboard } from "../../src/configStore";
import { exportDashboards, parseImport, planImport } from "../../src/dashboardIO";
import { gs, missing, pg, preparedWorkspace, psqlAdmin, required } from "./support";

const withGs = !!gs && gs.publish && !!pg;
if (!withGs && required) throw new Error(missing("GeoServer", "INT_GEOSERVER_URL e PostgreSQL (INT_PGHOST, ...)"));

describe.skipIf(!withGs)("dashboard: esporta e importa via GeoServer reale", () => {
  let w: Awaited<ReturnType<typeof preparedWorkspace>>;
  let acc: AccessConfig;
  const G = gs ?? { url: "" };
  const kc = { token: undefined, tokenParsed: { preferred_username: "it-admin" } } as never;
  let n = 0;
  const uid = () => `w${++n}`;

  beforeAll(async () => {
    w = await preparedWorkspace("gema_dio");
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

  it("esporta, reimporta sostituendo e aggiungendo; il JSON resta identico", async () => {
    const widgets = [{ id: "k1", type: "bar" as const, title: "Per tipo «è» & <b>", layer: "ws:x", field: "kind", agg: "count" as const, cql: "kind = 'A'", w: 2 as const }];
    await saveDashboard(G.url, kc, acc, { title: "Monitoraggio", description: "d", roles: ["v"], widgets });
    const before = await loadDashboards(G.url, kc, acc);
    const file = JSON.stringify(exportDashboards(before, "it"));
    const parsed = parseImport(file, uid);
    parsed.items.push({ ...parsed.items[0], title: "Copia importata" });
    await importDashboards(G.url, kc, acc, planImport(parsed.items, before, new Set(["Monitoraggio"])));
    const after = await loadDashboards(G.url, kc, acc);
    expect(after.map((d) => d.title)).toEqual(["Copia importata", "Monitoraggio"]);
    expect(after.find((d) => d.title === "Monitoraggio")?.fid).toBe(before[0].fid);
    expect(after.every((d) => JSON.stringify(d.widgets) === JSON.stringify(widgets))).toBe(true);
  });

  it("tutto o niente: se una riga viene rifiutata dal database non entra nessuna", async () => {
    psqlAdmin("ALTER TABLE gema_config.dashboards ADD CONSTRAINT it_no_rotta CHECK (title <> 'Rotta')", w.db);
    const before = await loadDashboards(G.url, kc, acc);
    const items = parseImport(JSON.stringify({ dashboards: [{ title: "Buona", widgets: [{ type: "kpi", layer: "ws:x" }] }, { title: "Rotta", widgets: [{ type: "kpi", layer: "ws:x" }] }] }), uid).items;
    await expect(importDashboards(G.url, kc, acc, planImport(items, before, new Set()))).rejects.toThrow();
    expect((await loadDashboards(G.url, kc, acc)).map((d) => d.title)).toEqual(before.map((d) => d.title));
  });
});
