// @vitest-environment jsdom
// Bozze delle dashboard contro servizi reali.
//  - PostgreSQL: tabella dashboard_drafts creata da init-db.sh (titolo obbligatorio, una bozza per dashboard pubblicata,
//    più bozze mai pubblicate), diritti dell'utente applicativo, script rieseguibile.
//  - GeoServer + PostgreSQL: salva bozza, pubblica (id restituito da InsertResult, bozza eliminata nella stessa
//    transazione), bozza di una dashboard pubblicata, scarta, elimina tutto.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AccessConfig } from "../../src/config";
import {
  dashId, deleteDashboardAndDraft, deleteDashboardDraft, loadDashboardDrafts, loadDashboards, publishDashboard, saveDashboardDraft, type DashboardDef,
} from "../../src/configStore";
import { chartScripts, gs, initDbEnv, missing, pg, preparedWorkspace, psqlAdmin, psqlAs, required, sh, uniq } from "./support";

if (!pg && required) throw new Error(missing("PostgreSQL", "INT_PGHOST, INT_PG_ADMIN_USER, INT_PG_ADMIN_PASSWORD"));

describe.skipIf(!pg)("dashboard_drafts in PostgreSQL (init-db.sh del chart)", () => {
  const scripts = pg ? chartScripts() : null;
  const db = uniq("it_dr");
  const user = uniq("gs_dr");
  const password = "pw-bozze";
  const env = () => initDbEnv({ DB_CREATE: "true", MAPP_DB: db, MAPP_SCHEMA: "gema_config", GS_DB_USER: user, GS_DB_PASSWORD: password });
  const sql = (q: string) => psqlAdmin(q, db);
  const fails = (q: string) => { try { sql(q); return ""; } catch (e) { return String((e as { stderr?: string }).stderr ?? e); } };

  beforeAll(() => { const r = sh(scripts!.initDb, env()); if (r.code !== 0) throw new Error(`init-db.sh:\n${r.out}`); });
  afterAll(() => {
    try { psqlAdmin(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`); } catch { /* già rimosso */ }
    try { psqlAdmin(`DROP ROLE IF EXISTS "${user}"`); } catch { /* già rimosso */ }
    scripts?.cleanup();
  });

  it("valori di default e titolo obbligatorio", () => {
    sql("INSERT INTO gema_config.dashboard_drafts (title) VALUES ('Nuova')");
    expect(sql("SELECT dashboard_id || '|' || description || '|' || roles || '|' || definition FROM gema_config.dashboard_drafts")).toBe("||[]|[]");
    expect(fails("INSERT INTO gema_config.dashboard_drafts (title) VALUES ('  ')")).toMatch(/check constraint/);
    expect(fails("INSERT INTO gema_config.dashboard_drafts (title) VALUES (NULL)")).toMatch(/null value/);
  });

  it("una bozza per dashboard pubblicata; più bozze nuove (vuote o NULL)", () => {
    sql("INSERT INTO gema_config.dashboard_drafts (title, dashboard_id) VALUES ('A', '7')");
    expect(fails("INSERT INTO gema_config.dashboard_drafts (title, dashboard_id) VALUES ('B', '7')")).toMatch(/dashboard_drafts_dashboard_uq/);
    sql("INSERT INTO gema_config.dashboard_drafts (title, dashboard_id) VALUES ('C', ''), ('D', ''), ('E', NULL), ('F', NULL)");
    expect(sql("SELECT count(*) FROM gema_config.dashboard_drafts")).toBe("6");
  });

  it("utente applicativo: lettura e scrittura; script rieseguibile; installazioni precedenti senza la tabella", () => {
    expect(psqlAs(user, password, db, "UPDATE gema_config.dashboard_drafts SET description = 'x'").code).toBe(0);
    expect(sh(scripts!.initDb, env()).code).toBe(0);
    expect(sql("SELECT count(*) FROM gema_config.dashboard_drafts WHERE description = 'x'")).toBe("6");
    sql("DROP TABLE gema_config.dashboard_drafts");
    expect(sh(scripts!.initDb, env()).code).toBe(0);
    expect(psqlAs(user, password, db, "INSERT INTO gema_config.dashboard_drafts (title) VALUES ('dopo') RETURNING title").out).toBe("dopo");
  });
});

const withGs = !!gs && gs.publish && !!pg;
if (!withGs && required) throw new Error(missing("GeoServer", "INT_GEOSERVER_URL e PostgreSQL (INT_PGHOST, ...)"));

describe.skipIf(!withGs)("bozze e pubblicazione via GeoServer reale", () => {
  let w: Awaited<ReturnType<typeof preparedWorkspace>>;
  let acc: AccessConfig;
  const G = gs ?? { url: "" };
  const kc = { token: undefined, tokenParsed: { preferred_username: "it-admin" } } as never;
  const D = (title: string, extra: Partial<DashboardDef> = {}): DashboardDef => ({
    title, description: "d", roles: ["viewer"], widgets: [{ id: "a", type: "kpi", title: "K", layer: "x:y", agg: "count", w: 1 }], ...extra,
  });

  beforeAll(async () => {
    w = await preparedWorkspace("gema_dr");
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

  it("pubblicata e verificata dal Job", () => {
    expect(w.publishOutput).toContain(`layer ${w.ws}:dashboard_drafts pubblicato`);
  });

  it("bozza nuova → pubblicazione: id restituito, bozza eliminata insieme", async () => {
    const draftFid = await saveDashboardDraft(G.url, kc, acc, { dashboardId: "", def: D("Nuova", { widgets: [], filters: { area: true } }) });
    expect(draftFid).toMatch(/^dashboard_drafts\.\d+$/);
    const [dr] = await loadDashboardDrafts(G.url, kc, acc);
    expect(dr).toMatchObject({ fid: draftFid, dashboardId: "", def: { title: "Nuova", widgets: [], filters: { area: true } }, updatedBy: "it-admin" });
    const fid = await publishDashboard(G.url, kc, acc, D("Nuova"), draftFid);
    expect(fid).toMatch(/^dashboards\.\d+$/);
    expect(await loadDashboardDrafts(G.url, kc, acc)).toEqual([]);
    expect((await loadDashboards(G.url, kc, acc)).map((d) => [d.fid, d.title])).toEqual([[fid, "Nuova"]]);
  });

  it("bozza di una pubblicata: la pubblicata non cambia finché non si pubblica; scarta; elimina tutto", async () => {
    const [pub] = await loadDashboards(G.url, kc, acc);
    const draftFid = await saveDashboardDraft(G.url, kc, acc, { dashboardId: dashId(pub.fid), def: D("Nuova v2", { roles: [] }) });
    expect((await loadDashboards(G.url, kc, acc))[0]).toMatchObject({ title: "Nuova", roles: ["viewer"] });
    // una seconda bozza della stessa dashboard è rifiutata dal vincolo
    await expect(saveDashboardDraft(G.url, kc, acc, { dashboardId: dashId(pub.fid), def: D("doppia") })).rejects.toThrow();
    await deleteDashboardDraft(G.url, kc, acc, draftFid);
    expect((await loadDashboards(G.url, kc, acc))[0].title).toBe("Nuova");
    const again = await saveDashboardDraft(G.url, kc, acc, { dashboardId: dashId(pub.fid), def: D("Nuova v3") });
    expect(await publishDashboard(G.url, kc, acc, { ...D("Nuova v3"), fid: pub.fid }, again)).toBe(pub.fid);
    expect((await loadDashboards(G.url, kc, acc)).map((d) => d.title)).toEqual(["Nuova v3"]);
    const d2 = await saveDashboardDraft(G.url, kc, acc, { dashboardId: dashId(pub.fid), def: D("v4") });
    await deleteDashboardAndDraft(G.url, kc, acc, pub.fid, d2);
    expect(await loadDashboards(G.url, kc, acc)).toEqual([]);
    expect(await loadDashboardDrafts(G.url, kc, acc)).toEqual([]);
  });
});
