// @vitest-environment jsdom
// Backup e ripristino contro GeoServer reale: la configurazione letta, esportata in un file, riletta e ripristinata
// in un'unica transazione (unione e sostituzione) sulle tabelle pubblicate dal Job; tipi (booleani, interi, JSON) intatti.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AccessConfig } from "../../src/config";
import { applyRestore, collect, exportBackup, parseBackup, planRestore, SECTION_IDS } from "../../src/backup";
import { deleteRule, loadCatalog, loadRules, saveCatalog, saveDashboard, saveRule } from "../../src/configStore";
import { gs, missing, pg, preparedWorkspace, required } from "./support";

const withGs = !!gs && gs.publish && !!pg;
if (!withGs && required) throw new Error(missing("GeoServer", "INT_GEOSERVER_URL e PostgreSQL (INT_PGHOST, ...)"));

describe.skipIf(!withGs)("backup e ripristino via GeoServer reale", () => {
  let w: Awaited<ReturnType<typeof preparedWorkspace>>;
  let acc: AccessConfig;
  const G = gs ?? { url: "" };
  const kc = { token: undefined, tokenParsed: { preferred_username: "it-admin" } } as never;

  beforeAll(async () => {
    w = await preparedWorkspace("gema_bk");
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

  it("esporta, cambia, ripristina: torna tutto com'era", async () => {
    await saveRule(G.url, kc, acc, { role: "ops", layers: ["*"], tools: ["info"] });
    await saveRule(G.url, kc, acc, { role: "tmp", layers: ["ws:a"], tools: [] });
    await saveDashboard(G.url, kc, acc, { title: "D", description: "", roles: ["ops"], widgets: [{ id: "a", type: "kpi", title: "K", layer: "ws:a", agg: "count", w: 1 }], filters: { area: true } });
    const cat0 = await loadCatalog(G.url, kc, acc);
    await saveCatalog(G.url, kc, acc, cat0, { folders: [{ key: "f", parent: "", title: "F", description: "", position: 1, expanded: true, hidden: false }], layers: [{ layer: "ws:a", folder: "f", position: 0, title: "", description: "", hidden: false, defaultOn: true }] });
    const before = await collect(G.url, kc, acc);
    const text = JSON.stringify(exportBackup(before.data, SECTION_IDS, "it", w.ws));

    // modifiche dopo il backup: una regola cambiata, una nuova, una eliminata
    const rules = await loadRules(G.url, kc, acc);
    await saveRule(G.url, kc, acc, { ...rules.find((r) => r.role === "ops")!, tools: [] });
    await saveRule(G.url, kc, acc, { role: "extra", layers: [], tools: [] });
    await deleteRule(G.url, kc, acc, rules.find((r) => r.role === "tmp")!.fid!);

    const { file } = parseBackup(text);
    const now = await collect(G.url, kc, acc);
    const merge = planRestore(now.data, file.sections, SECTION_IDS, "merge");
    expect(merge.find((p) => p.id === "rules")).toMatchObject({ insert: [expect.objectContaining({ role: "tmp" })], update: [expect.objectContaining({ row: expect.objectContaining({ role: "ops" }) })], remove: [] });
    const replace = planRestore(now.data, file.sections, SECTION_IDS, "replace");
    await applyRestore(G.url, kc, acc, replace);
    const after = await collect(G.url, kc, acc);
    const strip = (rows: unknown[] = []) => rows.map((r: any) => { const { fid: _f, updatedBy: _b, updatedAt: _a, ...x } = r; return x; }).sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    for (const id of SECTION_IDS) expect(strip(after.data[id]), id).toEqual(strip(before.data[id]));
    expect(planRestore(after.data, file.sections, SECTION_IDS, "replace").every((p) => !p.insert.length && !p.update.length && !p.remove.length)).toBe(true);
  });
});
