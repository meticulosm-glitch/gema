// @vitest-environment jsdom
// Registro modifiche contro servizi reali.
//  - PostgreSQL: trigger creati da init-db.sh sulle tabelle di configurazione; INSERT/UPDATE/DELETE registrati con la riga
//    prima e dopo e l'autore (updated_by); modifiche ai soli updated_by/updated_at ignorate; utente applicativo in sola
//    lettura sul registro; viste salvate e bozze escluse; script rieseguibile (un trigger per tabella); conservazione.
//  - GeoServer + PostgreSQL: le scritture dell'app finiscono nel registro, l'eliminazione registra chi elimina, il
//    ripristino di una versione riporta la riga com'era; il registro non si scrive via WFS-T.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AccessConfig } from "../../src/config";
import { deleteRule, loadRules, saveRule } from "../../src/configStore";
import { loadChangeLog, restoreVersion } from "../../src/changeLog";
import { wfsTransaction } from "../../src/api";
import { chartScripts, gs, initDbEnv, missing, pg, preparedWorkspace, psqlAdmin, psqlAs, required, sh, uniq } from "./support";

if (!pg && required) throw new Error(missing("PostgreSQL", "INT_PGHOST, INT_PG_ADMIN_USER, INT_PG_ADMIN_PASSWORD"));

describe.skipIf(!pg)("change_log in PostgreSQL (init-db.sh del chart)", () => {
  const scripts = pg ? chartScripts() : null;
  const db = uniq("it_cl");
  const user = uniq("gs_cl");
  const password = "pw-registro";
  const env = (extra: Record<string, string> = {}) => initDbEnv({ DB_CREATE: "true", MAPP_DB: db, MAPP_SCHEMA: "gema_config", GS_DB_USER: user, GS_DB_PASSWORD: password, ...extra });
  const sql = (q: string) => psqlAdmin(q, db);
  const as = (q: string) => psqlAs(user, password, db, q);
  const log = () => sql("SELECT table_name || '|' || op || '|' || coalesce(changed_by, '') FROM gema_config.change_log ORDER BY id").split("\n").filter(Boolean);

  beforeAll(() => { const r = sh(scripts!.initDb, env()); if (r.code !== 0) throw new Error(`init-db.sh:\n${r.out}`); });
  afterAll(() => {
    try { psqlAdmin(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`); } catch { /* già rimosso */ }
    try { psqlAdmin(`DROP ROLE IF EXISTS "${user}"`); } catch { /* già rimosso */ }
    scripts?.cleanup();
  });

  it("inserimento, modifica, eliminazione registrati dall'utente applicativo, con autore e righe in JSON", () => {
    expect(as("INSERT INTO gema_config.role_rules (role, layers, tools, updated_by) VALUES ('ops', '[\"*\"]', '[]', 'ada')").code).toBe(0);
    expect(as("UPDATE gema_config.role_rules SET tools = '[\"info\"]', updated_by = 'bea' WHERE role = 'ops'").code).toBe(0);
    expect(as("UPDATE gema_config.role_rules SET updated_by = 'cleo', updated_at = now() WHERE role = 'ops'").code).toBe(0); // solo timbro: niente registro
    expect(as("DELETE FROM gema_config.role_rules WHERE role = 'ops'").code).toBe(0);
    expect(log()).toEqual(["role_rules|INSERT|ada", "role_rules|UPDATE|bea", "role_rules|DELETE|cleo"]);
    const [oldT, newT] = sql("SELECT (old_data::jsonb ->> 'tools') || '|' || (new_data::jsonb ->> 'tools') FROM gema_config.change_log WHERE op = 'UPDATE'").split("|");
    expect([oldT, newT]).toEqual(["[]", '["info"]']);
    expect(sql("SELECT count(DISTINCT row_id) FROM gema_config.change_log")).toBe("1");
    expect(sql("SELECT db_user FROM gema_config.change_log LIMIT 1")).toBe(user);
    expect(sql("SELECT new_data IS NULL AND old_data IS NOT NULL FROM gema_config.change_log WHERE op = 'DELETE'")).toBe("t");
  });

  it("il registro per l'utente applicativo è in sola lettura", () => {
    expect(as("SELECT count(*) FROM gema_config.change_log").out).toBe("3");
    for (const q of ["INSERT INTO gema_config.change_log (table_name, op) VALUES ('x', 'INSERT')", "UPDATE gema_config.change_log SET changed_by = 'falso'", "DELETE FROM gema_config.change_log", "TRUNCATE gema_config.change_log"])
      expect(as(q).out, q).toMatch(/permission denied/);
  });

  it("tutte le tabelle di configurazione registrate; viste salvate e bozze no", () => {
    sql("TRUNCATE gema_config.change_log");
    as("INSERT INTO gema_config.dashboards (title) VALUES ('D')");
    as("INSERT INTO gema_config.catalog_folders (folder_key, title) VALUES ('f', 'F')");
    as("INSERT INTO gema_config.catalog_layers (layer) VALUES ('ws:l')");
    as("INSERT INTO gema_config.role_views (role) VALUES ('r')");
    as("INSERT INTO gema_config.edit_forms (layer) VALUES ('ws:l')");
    as("INSERT INTO gema_config.announcements (message) VALUES ('m')");
    as("INSERT INTO gema_config.saved_views (owner, name) VALUES ('u', 'v')");
    as("INSERT INTO gema_config.dashboard_drafts (title) VALUES ('B')");
    expect(log().map((l) => l.split("|")[0]).sort()).toEqual(["announcements", "catalog_folders", "catalog_layers", "dashboards", "edit_forms", "role_views"]);
  });

  it("rieseguibile: un solo trigger per tabella, registro conservato; conservazione per giorni", () => {
    const before = sql("SELECT count(*) FROM gema_config.change_log");
    expect(sh(scripts!.initDb, env()).code).toBe(0);
    expect(sql("SELECT count(*) FROM gema_config.change_log")).toBe(before);
    expect(sql("SELECT count(*) FROM pg_trigger WHERE tgname = 'gema_log' AND NOT tgisinternal")).toBe("7");
    as("UPDATE gema_config.dashboards SET title = 'D2'");
    expect(sql("SELECT count(*) FROM gema_config.change_log WHERE table_name = 'dashboards'")).toBe("2"); // non raddoppiato
    sql("UPDATE gema_config.change_log SET changed_at = now() - interval '100 days' WHERE table_name = 'announcements'");
    expect(sh(scripts!.initDb, env({ CHANGE_LOG_DAYS: "30" })).code).toBe(0);
    expect(sql("SELECT count(*) FROM gema_config.change_log WHERE table_name = 'announcements'")).toBe("0");
    expect(Number(sql("SELECT count(*) FROM gema_config.change_log"))).toBe(Number(before) + 1 - 1);
    expect(sh(scripts!.initDb, env({ CHANGE_LOG_DAYS: "abc" })).code).toBe(0); // valore non numerico: ignorato
  });
});

const withGs = !!gs && gs.publish && !!pg;
if (!withGs && required) throw new Error(missing("GeoServer", "INT_GEOSERVER_URL e PostgreSQL (INT_PGHOST, ...)"));

describe.skipIf(!withGs)("registro modifiche via GeoServer reale", () => {
  let w: Awaited<ReturnType<typeof preparedWorkspace>>;
  let acc: AccessConfig;
  const G = gs ?? { url: "" };
  const kcAs = (u: string) => ({ token: undefined, tokenParsed: { preferred_username: u } }) as never;

  beforeAll(async () => {
    w = await preparedWorkspace("gema_cl");
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

  it("pubblicata dal Job", () => expect(w.publishOutput).toContain(`layer ${w.ws}:change_log pubblicato`));

  it("scritture dell'app nel registro, autore dell'eliminazione, ripristino di una versione", async () => {
    await saveRule(G.url, kcAs("ada"), acc, { role: "ops", layers: ["*"], tools: [] });
    let [r] = await loadRules(G.url, kcAs("ada"), acc);
    await saveRule(G.url, kcAs("bea"), acc, { ...r, tools: ["info"] });
    [r] = await loadRules(G.url, kcAs("bea"), acc);
    await deleteRule(G.url, kcAs("cleo"), acc, r.fid!);
    const { entries } = await loadChangeLog(G.url, kcAs("x"), acc, {});
    expect(entries.map((e) => [e.table, e.op, e.changedBy])).toEqual([["role_rules", "DELETE", "cleo"], ["role_rules", "UPDATE", "bea"], ["role_rules", "INSERT", "ada"]]);
    // ripristina la versione creata da ada (prima della modifica di bea): la riga torna, con tools = []
    expect(await restoreVersion(G.url, kcAs("dora"), acc, entries[2])).toBe("inserted");
    const after = await loadRules(G.url, kcAs("x"), acc);
    expect(after.map((x) => [x.role, x.tools, x.updatedBy])).toEqual([["ops", [], "dora"]]);
    expect((await loadChangeLog(G.url, kcAs("x"), acc, {})).entries[0]).toMatchObject({ op: "INSERT", changedBy: "dora" });
  });

  it("il registro non si scrive via WFS-T", async () => {
    const tx = `<wfs:Transaction service="WFS" version="1.0.0" xmlns:wfs="http://www.opengis.net/wfs" xmlns:ogc="http://www.opengis.net/ogc"><wfs:Delete typeName="${w.ws}:change_log"><ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>op</ogc:PropertyName><ogc:Literal>INSERT</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter></wfs:Delete></wfs:Transaction>`;
    await expect(wfsTransaction(G.url, null, tx)).rejects.toThrow();
  });
});
