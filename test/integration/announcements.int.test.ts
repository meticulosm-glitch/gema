// @vitest-environment jsdom
// Avvisi contro servizi reali.
//  - PostgreSQL: tabella announcements creata da init-db.sh (livelli, date, manutenzione non chiudibile, diritti).
//  - GeoServer + PostgreSQL: saveAnnouncement / loadAnnouncements / deleteAnnouncement dell'app (booleani e date).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AccessConfig } from "../../src/config";
import { blankAnnouncement } from "../../src/announcements";
import { deleteAnnouncement, loadAnnouncements, saveAnnouncement } from "../../src/configStore";
import { chartScripts, gs, initDbEnv, missing, pg, preparedWorkspace, psqlAdmin, psqlAs, required, sh, uniq } from "./support";

if (!pg && required) throw new Error(missing("PostgreSQL", "INT_PGHOST, INT_PG_ADMIN_USER, INT_PG_ADMIN_PASSWORD"));

describe.skipIf(!pg)("announcements in PostgreSQL (init-db.sh del chart)", () => {
  const scripts = pg ? chartScripts() : null;
  const db = uniq("it_an");
  const user = uniq("gs_an");
  const password = "pw-avvisi";
  const env = () => initDbEnv({ DB_CREATE: "true", MAPP_DB: db, MAPP_SCHEMA: "gema_config", GS_DB_USER: user, GS_DB_PASSWORD: password });
  const sql = (q: string) => psqlAdmin(q, db);
  const fails = (q: string) => { try { sql(q); return ""; } catch (e) { return String((e as { stderr?: string }).stderr ?? e); } };

  beforeAll(() => { const r = sh(scripts!.initDb, env()); if (r.code !== 0) throw new Error(`init-db.sh:\n${r.out}`); });
  afterAll(() => {
    try { psqlAdmin(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`); } catch { /* già rimosso */ }
    try { psqlAdmin(`DROP ROLE IF EXISTS "${user}"`); } catch { /* già rimosso */ }
    scripts?.cleanup();
  });

  it("valori di default", () => {
    sql("INSERT INTO gema_config.announcements (message) VALUES ('ciao')");
    expect(sql("SELECT level || '|' || starts_at || '|' || ends_at || '|' || roles || '|' || dismissible || '|' || active FROM gema_config.announcements")).toBe("info|||[]|true|true");
  });

  it("vincoli: testo, livello, date, manutenzione non chiudibile", () => {
    expect(fails("INSERT INTO gema_config.announcements (message) VALUES ('  ')")).toMatch(/check constraint/);
    expect(fails(`INSERT INTO gema_config.announcements (message) VALUES ('${"x".repeat(1001)}')`)).toMatch(/check constraint/);
    expect(fails("INSERT INTO gema_config.announcements (message, level) VALUES ('x', 'panico')")).toMatch(/check constraint/);
    expect(fails("INSERT INTO gema_config.announcements (message, starts_at) VALUES ('x', 'domani')")).toMatch(/announcements_dates/);
    expect(fails("INSERT INTO gema_config.announcements (message, level, dismissible) VALUES ('x', 'maintenance', true)")).toMatch(/announcements_maintenance_stays/);
    sql("INSERT INTO gema_config.announcements (message, level, dismissible, starts_at, ends_at) VALUES ('x', 'maintenance', false, '2026-10-22T18:00:00Z', '')");
  });

  it("utente applicativo: lettura e scrittura; script rieseguibile; aggiornamento di installazioni precedenti", () => {
    expect(psqlAs(user, password, db, "UPDATE gema_config.announcements SET active = false").code).toBe(0);
    expect(sh(scripts!.initDb, env()).code).toBe(0);
    expect(sql("SELECT count(*) FROM gema_config.announcements WHERE NOT active")).toBe("2");
    sql("DROP TABLE gema_config.announcements");
    expect(sh(scripts!.initDb, env()).code).toBe(0);
    expect(psqlAs(user, password, db, "INSERT INTO gema_config.announcements (message) VALUES ('dopo') RETURNING message").out).toBe("dopo");
  });
});

const withGs = !!gs && gs.publish && !!pg;
if (!withGs && required) throw new Error(missing("GeoServer", "INT_GEOSERVER_URL e PostgreSQL (INT_PGHOST, ...)"));

describe.skipIf(!withGs)("announcements via GeoServer reale", () => {
  let w: Awaited<ReturnType<typeof preparedWorkspace>>;
  let acc: AccessConfig;
  const G = gs ?? { url: "" };
  const kc = { token: undefined, tokenParsed: { preferred_username: "it-admin" } } as never;

  beforeAll(async () => {
    w = await preparedWorkspace("gema_an");
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
    expect(w.publishOutput).toContain(`layer ${w.ws}:announcements pubblicato`);
  });

  it("salva, rilegge (booleani e date), modifica, elimina", async () => {
    await saveAnnouncement(G.url, kc, acc, { ...blankAnnouncement(), message: "Fermo <è> & co.", level: "maintenance", dismissible: true, startsAt: "2026-10-22T18:00:00Z", endsAt: "2026-10-22T20:00:00Z", roles: ["ops"] });
    let [a] = await loadAnnouncements(G.url, kc, acc);
    expect(a).toMatchObject({ message: "Fermo <è> & co.", level: "maintenance", dismissible: false, active: true, startsAt: "2026-10-22T18:00:00Z", endsAt: "2026-10-22T20:00:00Z", roles: ["ops"], updatedBy: "it-admin" });
    await saveAnnouncement(G.url, kc, acc, { ...a, level: "info", dismissible: true, active: false, startsAt: "", endsAt: "" });
    [a] = await loadAnnouncements(G.url, kc, acc);
    expect(a).toMatchObject({ level: "info", dismissible: true, active: false, startsAt: "", endsAt: "" });
    await deleteAnnouncement(G.url, kc, acc, a.fid!);
    expect(await loadAnnouncements(G.url, kc, acc)).toEqual([]);
  });
});
