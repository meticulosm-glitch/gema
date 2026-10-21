// @vitest-environment jsdom
// Moduli di modifica contro servizi reali.
//  - PostgreSQL: tabella edit_forms creata da init-db.sh (un modulo per layer, diritti, aggiornamento).
//  - GeoServer + PostgreSQL: saveEditForm / loadEditForm / loadEditForms dell'app; il JSON della definizione resta intatto.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AccessConfig } from "../../src/config";
import { loadEditForm, loadEditForms, saveEditForm } from "../../src/configStore";
import { chartScripts, gs, initDbEnv, missing, pg, preparedWorkspace, psqlAdmin, psqlAs, required, sh, uniq } from "./support";

if (!pg && required) throw new Error(missing("PostgreSQL", "INT_PGHOST, INT_PG_ADMIN_USER, INT_PG_ADMIN_PASSWORD"));

describe.skipIf(!pg)("edit_forms in PostgreSQL (init-db.sh del chart)", () => {
  const scripts = pg ? chartScripts() : null;
  const db = uniq("it_ef");
  const user = uniq("gs_ef");
  const password = "pw-moduli";
  const env = () => initDbEnv({ DB_CREATE: "true", MAPP_DB: db, MAPP_SCHEMA: "gema_config", GS_DB_USER: user, GS_DB_PASSWORD: password });
  const sql = (q: string) => psqlAdmin(q, db);
  const fails = (q: string) => { try { sql(q); return ""; } catch (e) { return String((e as { stderr?: string }).stderr ?? e); } };

  beforeAll(() => { const r = sh(scripts!.initDb, env()); if (r.code !== 0) throw new Error(`init-db.sh:\n${r.out}`); });
  afterAll(() => {
    try { psqlAdmin(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`); } catch { /* già rimosso */ }
    try { psqlAdmin(`DROP ROLE IF EXISTS "${user}"`); } catch { /* già rimosso */ }
    scripts?.cleanup();
  });

  it("colonne, default e vincoli: un modulo per layer", () => {
    expect(sql("SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'gema_config' AND table_name = 'edit_forms'"))
      .toBe("id:integer:NO,layer:text:NO,definition:text:NO,updated_by:text:YES,updated_at:timestamp with time zone:YES");
    sql("INSERT INTO gema_config.edit_forms (layer) VALUES ('ws:a')");
    expect(sql("SELECT definition FROM gema_config.edit_forms WHERE layer = 'ws:a'")).toBe("[]");
    expect(fails("INSERT INTO gema_config.edit_forms (layer) VALUES ('ws:a')")).toMatch(/edit_forms_layer_key/);
    expect(fails("INSERT INTO gema_config.edit_forms (layer) VALUES ('')")).toMatch(/check constraint/);
  });

  it("utente applicativo: lettura e scrittura; script rieseguibile; aggiornamento di installazioni precedenti", () => {
    expect(psqlAs(user, password, db, "UPDATE gema_config.edit_forms SET definition = '[{\"name\":\"x\"}]' WHERE layer = 'ws:a'").code).toBe(0);
    expect(sh(scripts!.initDb, env()).code).toBe(0);
    expect(sql("SELECT definition FROM gema_config.edit_forms WHERE layer = 'ws:a'")).toBe('[{"name":"x"}]');
    sql("DROP TABLE gema_config.edit_forms");
    expect(sh(scripts!.initDb, env()).code).toBe(0);
    expect(psqlAs(user, password, db, "INSERT INTO gema_config.edit_forms (layer) VALUES ('ws:dopo') RETURNING layer").out).toBe("ws:dopo");
  });
});

const withGs = !!gs && gs.publish && !!pg;
if (!withGs && required) throw new Error(missing("GeoServer", "INT_GEOSERVER_URL e PostgreSQL (INT_PGHOST, ...)"));

describe.skipIf(!withGs)("edit_forms via GeoServer reale", () => {
  let w: Awaited<ReturnType<typeof preparedWorkspace>>;
  let acc: AccessConfig;
  const G = gs ?? { url: "" };
  const kc = { token: undefined, tokenParsed: { preferred_username: "it-admin" } } as never;

  beforeAll(async () => {
    w = await preparedWorkspace("gema_ef");
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
    expect(w.publishOutput).toContain(`layer ${w.ws}:edit_forms pubblicato`);
  });

  it("salva, rilegge (anche con apici e accenti nel nome del layer), aggiorna e ripristina", async () => {
    const fields = [
      { name: "kind", alias: "Tipo d'uso <è>", required: true, options: [{ value: "A", label: "Agricola" }, { value: "B", label: "Boschiva" }], default: "A" },
      { name: "area", readonly: true, help: "Calcolata" },
    ];
    await saveEditForm(G.url, kc, acc, { layer: "ws:l'uso", fields });
    const one = await loadEditForm(G.url, kc, acc, "ws:l'uso");
    expect(one).toMatchObject({ layer: "ws:l'uso", fields, updatedBy: "it-admin" });
    expect(await loadEditForm(G.url, kc, acc, "ws:altro")).toBeNull();
    await saveEditForm(G.url, kc, acc, { ...one!, fields: [fields[1]] });
    expect((await loadEditForms(G.url, kc, acc)).map((f) => [f.layer, f.fields.length])).toEqual([["ws:l'uso", 1]]);
    await saveEditForm(G.url, kc, acc, { ...one!, fields: [] });
    expect(await loadEditForms(G.url, kc, acc)).toEqual([]);
  });
});
