// @vitest-environment jsdom
// Vista iniziale per ruolo contro servizi reali.
//  - PostgreSQL: tabella role_views creata da init-db.sh (formato dell'area, ruolo unico, aggiornamento, diritti).
//  - GeoServer + PostgreSQL: pubblicazione e saveRoleSettings / loadRoleViews / deleteRoleSettings dell'app,
//    regola e vista nella stessa transazione.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AccessConfig } from "../../src/config";
import { deleteRoleSettings, loadRoleViews, loadRules, saveRoleSettings } from "../../src/configStore";
import { chartScripts, gs, initDbEnv, missing, pg, preparedWorkspace, psqlAdmin, psqlAs, required, sh, uniq } from "./support";

if (!pg && required) throw new Error(missing("PostgreSQL", "INT_PGHOST, INT_PG_ADMIN_USER, INT_PG_ADMIN_PASSWORD"));

describe.skipIf(!pg)("role_views in PostgreSQL (init-db.sh del chart)", () => {
  const scripts = pg ? chartScripts() : null;
  const db = uniq("it_rv");
  const user = uniq("gs_rv");
  const password = "pw-viste";
  const env = () => initDbEnv({ DB_CREATE: "true", MAPP_DB: db, MAPP_SCHEMA: "gema_config", GS_DB_USER: user, GS_DB_PASSWORD: password });
  const sql = (q: string) => psqlAdmin(q, db);
  const fails = (q: string) => { try { sql(q); return ""; } catch (e) { return String((e as { stderr?: string }).stderr ?? e); } };

  beforeAll(() => { const r = sh(scripts!.initDb, env()); if (r.code !== 0) throw new Error(`init-db.sh:\n${r.out}`); });
  afterAll(() => {
    try { psqlAdmin(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`); } catch { /* già rimosso */ }
    try { psqlAdmin(`DROP ROLE IF EXISTS "${user}"`); } catch { /* già rimosso */ }
    scripts?.cleanup();
  });

  it("colonne e valori di default", () => {
    expect(sql("SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'gema_config' AND table_name = 'role_views'"))
      .toBe("id:integer,role:text,bbox:text,basemap:text,layers:text,updated_by:text,updated_at:timestamp with time zone");
    sql("INSERT INTO gema_config.role_views (role) VALUES ('base')");
    expect(sql("SELECT bbox || '|' || basemap || '|' || layers FROM gema_config.role_views WHERE role = 'base'")).toBe("||[]");
  });

  it("area: '', NULL o quattro numeri; ruolo unico e non vuoto", () => {
    sql("INSERT INTO gema_config.role_views (role, bbox) VALUES ('ok', '12.45,41.85,-12.55,41.95'), ('nullo', NULL)");
    for (const bad of ["12,41,13", "a,b,c,d", "12,41,13,42,1", "12;41;13;42", "1e2,1,2,3"])
      expect(fails(`INSERT INTO gema_config.role_views (role, bbox) VALUES ('x-${bad.length}', '${bad}')`), bad).toMatch(/role_views_bbox_format/);
    expect(fails("INSERT INTO gema_config.role_views (role) VALUES ('ok')")).toMatch(/role_views_role_key/);
    expect(fails("INSERT INTO gema_config.role_views (role) VALUES ('')")).toMatch(/check constraint/);
  });

  it("l'utente applicativo legge e scrive; rieseguire lo script non tocca i dati; installazioni precedenti si aggiornano", () => {
    expect(psqlAs(user, password, db, "UPDATE gema_config.role_views SET basemap = 'sat' WHERE role = 'ok'").code).toBe(0);
    const n = sql("SELECT count(*) FROM gema_config.role_views");
    expect(sh(scripts!.initDb, env()).code).toBe(0);
    expect(sql("SELECT count(*) FROM gema_config.role_views")).toBe(n);
    sql("DROP TABLE gema_config.role_views");
    expect(sh(scripts!.initDb, env()).code).toBe(0);
    expect(psqlAs(user, password, db, "INSERT INTO gema_config.role_views (role) VALUES ('dopo') RETURNING role").out).toBe("dopo");
  });
});

const withGs = !!gs && gs.publish && !!pg;
if (!withGs && required) throw new Error(missing("GeoServer", "INT_GEOSERVER_URL e PostgreSQL (INT_PGHOST, ...)"));

describe.skipIf(!withGs)("role_views via GeoServer reale", () => {
  let w: Awaited<ReturnType<typeof preparedWorkspace>>;
  let acc: AccessConfig;
  const G = gs ?? { url: "" };
  const kc = { token: undefined, tokenParsed: { preferred_username: "it-admin" } } as never;

  beforeAll(async () => {
    w = await preparedWorkspace("gema_rv");
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
    expect(w.publishOutput).toContain(`layer ${w.ws}:role_views pubblicato`);
    expect(w.publishOutput).toContain(`verifica WFS ${w.ws}:role_views ok`);
  });

  it("regola e vista nuove, poi modificate, poi vista svuotata (riga eliminata), poi entrambe eliminate", async () => {
    await saveRoleSettings(G.url, kc, acc, { role: "ops", layers: ["*"], tools: ["info"] }, { role: "ops", bbox: [12.45, 41.85, 12.55, 41.95], basemap: "sat", layers: ["iride:ndvi"] });
    let [rule] = await loadRules(G.url, kc, acc);
    let [view] = await loadRoleViews(G.url, kc, acc);
    expect(rule).toMatchObject({ role: "ops", layers: ["*"] });
    expect(view).toMatchObject({ role: "ops", bbox: [12.45, 41.85, 12.55, 41.95], basemap: "sat", layers: ["iride:ndvi"], updatedBy: "it-admin" });

    await saveRoleSettings(G.url, kc, acc, { ...rule, tools: ["info", "table"] }, { ...view, bbox: undefined, basemap: "" });
    [rule] = await loadRules(G.url, kc, acc);
    [view] = await loadRoleViews(G.url, kc, acc);
    expect(rule.tools).toEqual(["info", "table"]);
    expect(view.bbox).toBeUndefined();
    expect(view.basemap).toBe("");
    expect(view.layers).toEqual(["iride:ndvi"]);

    await saveRoleSettings(G.url, kc, acc, rule, { ...view, layers: [] });
    expect(await loadRoleViews(G.url, kc, acc)).toEqual([]);

    await saveRoleSettings(G.url, kc, acc, rule, { role: "ops", basemap: "osm", layers: [] });
    [view] = await loadRoleViews(G.url, kc, acc);
    await deleteRoleSettings(G.url, kc, acc, rule.fid, view.fid);
    expect(await loadRules(G.url, kc, acc)).toEqual([]);
    expect(await loadRoleViews(G.url, kc, acc)).toEqual([]);
  });

  it("tutto o niente: una vista rifiutata dal database (ruolo duplicato) annulla anche la regola", async () => {
    await saveRoleSettings(G.url, kc, acc, { role: "dup", layers: ["*"], tools: [] }, { role: "dup", basemap: "osm", layers: [] });
    const [rule] = await loadRules(G.url, kc, acc);
    // seconda vista per lo stesso ruolo (inserimento senza fid) insieme a una modifica della regola
    await expect(saveRoleSettings(G.url, kc, acc, { ...rule, tools: ["info"] }, { role: "dup", basemap: "sat", layers: [] })).rejects.toThrow();
    expect((await loadRules(G.url, kc, acc))[0].tools).toEqual([]);
  });
});
