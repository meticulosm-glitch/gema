// @vitest-environment jsdom
// Statistiche d'uso contro servizi reali.
//  - PostgreSQL: usage_events creata da init-db.sh (vincoli su tipo, sessione e ruoli), utente applicativo che può solo
//    aggiungere e leggere, viste aggregate per giorno, tipo/oggetto, ruolo e utente, conservazione USAGE_DAYS.
//  - GeoServer + PostgreSQL: il tracker dell'app inserisce gli eventi via WFS-T; la pagina li legge dalle viste.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AccessConfig } from "../../src/config";
import { UsageTracker } from "../../src/usage";
import { loadUsage } from "../../src/usageStats";
import { chartScripts, gs, initDbEnv, missing, pg, preparedWorkspace, psqlAdmin, psqlAs, required, sh, uniq } from "./support";

if (!pg && required) throw new Error(missing("PostgreSQL", "INT_PGHOST, INT_PG_ADMIN_USER, INT_PG_ADMIN_PASSWORD"));

describe.skipIf(!pg)("usage_events in PostgreSQL (init-db.sh del chart)", () => {
  const scripts = pg ? chartScripts() : null;
  const db = uniq("it_us");
  const user = uniq("gs_us");
  const password = "pw-uso";
  const env = (extra: Record<string, string> = {}) => initDbEnv({ DB_CREATE: "true", MAPP_DB: db, MAPP_SCHEMA: "gema_config", GS_DB_USER: user, GS_DB_PASSWORD: password, ...extra });
  const sql = (q: string) => psqlAdmin(q, db);
  const as = (q: string) => psqlAs(user, password, db, q);
  const ev = (session: string, kind: string, target: string, roles = '["v"]', username = "", at = "now()") =>
    `INSERT INTO gema_config.usage_events (at, session, username, roles, kind, target) VALUES (${at}, '${session}', '${username}', '${roles}', '${kind}', '${target}')`;

  beforeAll(() => { const r = sh(scripts!.initDb, env()); if (r.code !== 0) throw new Error(`init-db.sh:\n${r.out}`); });
  afterAll(() => {
    try { psqlAdmin(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`); } catch { /* già rimosso */ }
    try { psqlAdmin(`DROP ROLE IF EXISTS "${user}"`); } catch { /* già rimosso */ }
    scripts?.cleanup();
  });

  it("l'utente applicativo aggiunge e legge; non modifica né cancella", () => {
    expect(as(ev("sessione01", "page", "mappa")).code).toBe(0);
    expect(as("SELECT count(*) FROM gema_config.usage_events").out).toBe("1");
    for (const q of ["UPDATE gema_config.usage_events SET target = 'x'", "DELETE FROM gema_config.usage_events", "TRUNCATE gema_config.usage_events"]) expect(as(q).out, q).toMatch(/permission denied/);
  });

  it("vincoli: tipo, sessione, ruoli JSON, lunghezze", () => {
    expect(as(ev("sessione01", "hack", "x")).out).toMatch(/check constraint/);
    expect(as(ev("corta", "page", "x")).out).toMatch(/check constraint/);
    expect(as(ev("sessione01", "page", "x", "non json")).out).toMatch(/invalid input syntax|check constraint/);
    expect(as(ev("sessione01", "page", "x", '{"a":1}')).out).toMatch(/check constraint/);
    expect(as(ev("sessione01", "page", "x".repeat(201))).out).toMatch(/check constraint/);
  });

  it("viste aggregate per giorno", () => {
    sql("TRUNCATE gema_config.usage_events");
    as(ev("sessione01", "layer", "ws:a", '["v","ops"]', "ada"));
    as(ev("sessione01", "layer", "ws:a", '["v","ops"]', "ada"));
    as(ev("sessione02", "layer", "ws:a", '["v"]', "bea"));
    as(ev("sessione02", "tool", "length", '["v"]', "bea"));
    as(ev("sessione03", "page", "mappa", '[]', "", "now() - interval '3 days'"));
    expect(as("SELECT kind || '|' || target || '|' || events || '|' || sessions || '|' || users FROM gema_config.usage_daily WHERE day = (now() AT TIME ZONE 'UTC')::date ORDER BY kind").out.split("\n")).toEqual(["layer|ws:a|3|2|2", "tool|length|1|1|1"]);
    expect(as("SELECT events || '|' || sessions || '|' || users FROM gema_config.usage_sessions ORDER BY day DESC LIMIT 1").out).toBe("4|2|2");
    expect(as("SELECT role || '|' || events || '|' || sessions FROM gema_config.usage_roles WHERE day = (now() AT TIME ZONE 'UTC')::date ORDER BY role").out.split("\n")).toEqual(["ops|2|1", "v|4|2"]);
    expect(as("SELECT username || '|' || events FROM gema_config.usage_users ORDER BY username").out.split("\n")).toEqual(["ada|2", "bea|2"]);
    expect(as("SELECT count(*) FROM gema_config.usage_sessions").out).toBe("2");
  });

  it("rieseguibile; conservazione USAGE_DAYS (default 180)", () => {
    expect(sh(scripts!.initDb, env()).code).toBe(0);
    expect(sql("SELECT count(*) FROM gema_config.usage_events")).toBe("5");
    sql("UPDATE gema_config.usage_events SET at = now() - interval '200 days' WHERE session = 'sessione03'");
    expect(sh(scripts!.initDb, env()).code).toBe(0);
    expect(sql("SELECT count(*) FROM gema_config.usage_events")).toBe("4");
    sql("UPDATE gema_config.usage_events SET at = now() - interval '10 days' WHERE session = 'sessione02'");
    expect(sh(scripts!.initDb, env({ USAGE_DAYS: "0" })).code).toBe(0);
    expect(sql("SELECT count(*) FROM gema_config.usage_events")).toBe("4");
    expect(sh(scripts!.initDb, env({ USAGE_DAYS: "7" })).code).toBe(0);
    expect(sql("SELECT count(*) FROM gema_config.usage_events")).toBe("2");
  });
});

const withGs = !!gs && gs.publish && !!pg;
if (!withGs && required) throw new Error(missing("GeoServer", "INT_GEOSERVER_URL e PostgreSQL (INT_PGHOST, ...)"));

describe.skipIf(!withGs)("statistiche d'uso via GeoServer reale", () => {
  let w: Awaited<ReturnType<typeof preparedWorkspace>>;
  let acc: AccessConfig;
  const G = gs ?? { url: "" };

  beforeAll(async () => {
    w = await preparedWorkspace("gema_us");
    acc = { enabled: true, adminRole: "a", viewerRole: "v", rolesClient: "c", knownRoles: [], workspace: w.ws };
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(G.url)) return realFetch(input, init);
      const headers = new Headers(init.headers);
      headers.set("Authorization", w.basic);
      return realFetch(input, { ...init, headers });
    });
  });
  afterAll(async () => { vi.unstubAllGlobals(); await w?.cleanup(); });

  it("pubblicate dal Job", () => {
    for (const t of ["usage_events", "usage_daily", "usage_sessions", "usage_roles", "usage_users"]) expect(w.publishOutput).toContain(`layer ${w.ws}:${t} pubblicato`);
  });

  it("il tracker inserisce gli eventi in una transazione; la pagina li legge dalle viste", async () => {
    const t = new UsageTracker({ gs: G.url, kc: { token: undefined, tokenParsed: { preferred_username: "ada" } } as never, acc, mode: "named", roles: ["v"], intervalMs: 3_600_000 });
    t.add("page", "mappa"); t.add("layer", "ws:a"); t.add("tool", "length");
    await t.flush();
    t.stop();
    expect(t.sent).toBe(3);
    const r = await loadUsage(G.url, null, acc, 7);
    expect(r.totals).toMatchObject({ events: 3, sessions: 1, users: 1 });
    expect(r.byKind.layer?.[0]).toMatchObject({ target: "ws:a", events: 1 });
    expect(r.roles).toEqual([{ role: "v", events: 3, sessions: 1 }]);
    expect(r.users[0]).toMatchObject({ username: "ada", events: 3 });
  });
});
