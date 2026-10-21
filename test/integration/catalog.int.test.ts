// @vitest-environment jsdom
// Catalogo prodotti contro servizi reali.
//  - PostgreSQL: tabelle catalog_folders / catalog_layers create da init-db.sh (lo script del Job), vincoli, idempotenza,
//    aggiornamento di un'installazione esistente, diritti dell'utente applicativo.
//  - GeoServer + PostgreSQL: pubblicazione con publish-geoserver.sh e lettura/scrittura con il codice dell'app
//    (loadCatalog / saveCatalog): tipi, transazione unica tutto-o-niente, conflitti.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Product } from "../../src/capabilities";
import type { Catalog } from "../../src/catalog";
import { addFolder, editableCatalog, moveTo, patchFolder, patchLayer, removeFolder, rowsToSave } from "../../src/catalogEdit";
import { CatalogConflictError, loadCatalog, saveCatalog } from "../../src/configStore";
import type { AccessConfig } from "../../src/config";
import { chartScripts, gs, initDbEnv, missing, pg, preparedWorkspace, psqlAdmin, psqlAs, required, sh, uniq } from "./support";

if (!pg && required) throw new Error(missing("PostgreSQL", "INT_PGHOST, INT_PG_ADMIN_USER, INT_PG_ADMIN_PASSWORD"));

const COLS = (db: string, t: string) => psqlAdmin(`SELECT column_name || ':' || data_type || ':' || is_nullable FROM information_schema.columns WHERE table_schema = 'gema_config' AND table_name = '${t}' ORDER BY ordinal_position`, db).split("\n");

describe.skipIf(!pg)("catalogo: tabelle in PostgreSQL (init-db.sh del chart)", () => {
  const scripts = pg ? chartScripts() : null;
  const db = uniq("it_cat");
  const user = uniq("gs_cat");
  const password = "pw-catalogo";
  const env = () => initDbEnv({ DB_CREATE: "true", MAPP_DB: db, MAPP_SCHEMA: "gema_config", GS_DB_USER: user, GS_DB_PASSWORD: password });
  const sql = (q: string) => psqlAdmin(q, db);
  const fails = (q: string) => { try { sql(q); return ""; } catch (e) { return String((e as { stderr?: string }).stderr ?? e); } };

  beforeAll(() => {
    const r = sh(scripts!.initDb, env());
    if (r.code !== 0) throw new Error(`init-db.sh:\n${r.out}`);
  });
  afterAll(() => {
    try { psqlAdmin(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`); } catch { /* già rimosso */ }
    try { psqlAdmin(`DROP ROLE IF EXISTS "${user}"`); } catch { /* già rimosso */ }
    scripts?.cleanup();
  });

  it("crea le due tabelle con le colonne attese", () => {
    expect(COLS(db, "catalog_folders")).toEqual([
      "id:integer:NO", "folder_key:text:NO", "parent_key:text:YES", "title:text:NO", "description:text:YES", "position:integer:NO",
      "expanded:boolean:NO", "hidden:boolean:NO", "updated_by:text:YES", "updated_at:timestamp with time zone:YES",
    ]);
    expect(COLS(db, "catalog_layers")).toEqual([
      "id:integer:NO", "layer:text:NO", "folder_key:text:YES", "position:integer:NO", "title:text:YES", "description:text:YES",
      "hidden:boolean:NO", "default_on:boolean:NO", "updated_by:text:YES", "updated_at:timestamp with time zone:YES",
    ]);
  });

  it("valori di default: primo livello, posizione 0, visibile, spento, titolo e descrizione vuoti", () => {
    sql("INSERT INTO gema_config.catalog_layers (layer) VALUES ('ws:default')");
    expect(sql("SELECT folder_key || '|' || position || '|' || title || '|' || description || '|' || hidden || '|' || default_on || '|' || (updated_at IS NOT NULL) FROM gema_config.catalog_layers WHERE layer = 'ws:default'")).toBe("|0|||false|false|true");
    sql("INSERT INTO gema_config.catalog_folders (folder_key, title) VALUES ('def', 'Default')");
    expect(sql("SELECT parent_key || '|' || position || '|' || expanded || '|' || hidden FROM gema_config.catalog_folders WHERE folder_key = 'def'")).toBe("|0|false|false");
  });

  it("testi facoltativi NULL (elemento vuoto in WFS-T): ammessi", () => {
    sql("INSERT INTO gema_config.catalog_layers (layer, folder_key, title, description) VALUES ('ws:null', NULL, NULL, NULL)");
    sql("INSERT INTO gema_config.catalog_folders (folder_key, parent_key, title, description) VALUES ('nulla', NULL, 'Con NULL', NULL)");
    expect(sql("SELECT count(*) FROM gema_config.catalog_layers WHERE layer = 'ws:null' AND title IS NULL")).toBe("1");
  });

  it("vincoli: layer e chiavi univoci, nascosto escluso da acceso, titolo della cartella obbligatorio, niente cartella dentro sé stessa", () => {
    expect(fails("INSERT INTO gema_config.catalog_layers (layer) VALUES ('ws:default')")).toMatch(/catalog_layers_layer_key/);
    expect(fails("INSERT INTO gema_config.catalog_layers (layer, hidden, default_on) VALUES ('ws:x', true, true)")).toMatch(/catalog_layers_hidden_not_on/);
    expect(fails("INSERT INTO gema_config.catalog_layers (layer) VALUES ('')")).toMatch(/check constraint/);
    expect(fails("INSERT INTO gema_config.catalog_folders (folder_key, title) VALUES ('def', 'Doppia')")).toMatch(/catalog_folders_folder_key_key/);
    expect(fails("INSERT INTO gema_config.catalog_folders (folder_key, title) VALUES ('vuota', '   ')")).toMatch(/check constraint/);
    expect(fails("INSERT INTO gema_config.catalog_folders (folder_key, title) VALUES ('', 'Senza chiave')")).toMatch(/check constraint/);
    expect(fails("INSERT INTO gema_config.catalog_folders (folder_key, parent_key, title) VALUES ('io', 'io', 'Io')")).toMatch(/catalog_folders_not_self/);
  });

  it("l'utente applicativo (quello di GeoServer) legge e scrive il catalogo, ma non può cambiarne la struttura", () => {
    const ins = psqlAs(user, password, db, "INSERT INTO gema_config.catalog_folders (folder_key, title) VALUES ('app', 'Da app') RETURNING folder_key");
    expect(ins).toMatchObject({ code: 0, out: "app" });
    expect(psqlAs(user, password, db, "UPDATE gema_config.catalog_layers SET hidden = true WHERE layer = 'ws:default'").code).toBe(0);
    expect(psqlAs(user, password, db, "DELETE FROM gema_config.catalog_folders WHERE folder_key = 'app'").code).toBe(0);
    const drop = psqlAs(user, password, db, "DROP TABLE gema_config.catalog_layers");
    expect(drop.code).not.toBe(0);
    expect(drop.out).toMatch(/must be owner|permission denied/);
  });

  it("idempotente: rieseguire lo script non tocca i dati", () => {
    const before = sql("SELECT count(*) FROM gema_config.catalog_layers");
    const r = sh(scripts!.initDb, env());
    expect(r.code, r.out).toBe(0);
    expect(sql("SELECT count(*) FROM gema_config.catalog_layers")).toBe(before);
  });

  it("aggiornamento di un'installazione precedente (senza catalogo): le tabelle si aggiungono, il resto resta", () => {
    sql("DROP TABLE gema_config.catalog_folders, gema_config.catalog_layers");
    sql("INSERT INTO gema_config.role_rules (role, layers, tools) VALUES ('ops-upgrade', '[\"*\"]', '[\"info\"]')");
    const r = sh(scripts!.initDb, env());
    expect(r.code, r.out).toBe(0);
    expect(sql("SELECT count(*) FROM gema_config.catalog_folders") + "|" + sql("SELECT count(*) FROM gema_config.catalog_layers")).toBe("0|0");
    expect(sql("SELECT role FROM gema_config.role_rules WHERE role = 'ops-upgrade'")).toBe("ops-upgrade");
    // i diritti dell'utente applicativo valgono anche per le tabelle nuove
    expect(psqlAs(user, password, db, "INSERT INTO gema_config.catalog_layers (layer) VALUES ('ws:dopo') RETURNING layer").out).toBe("ws:dopo");
  });
});

// ------------------------------------------------------------------------------------------------ GeoServer
const withGs = !!gs && gs.publish && !!pg;
if (!withGs && required) throw new Error(missing("GeoServer", "INT_GEOSERVER_URL e PostgreSQL (INT_PGHOST, ...)"));

describe.skipIf(!withGs)("catalogo: lettura e scrittura via GeoServer reale", () => {
  let w: Awaited<ReturnType<typeof preparedWorkspace>>;
  let acc: AccessConfig;
  const G = gs ?? { url: "" };
  const kc = { token: undefined, tokenParsed: { preferred_username: "it-admin" } } as never;
  const P = (name: string, title: string): Product => ({ name, title, workspace: name.split(":")[0] });
  const PRODUCTS = [P("iride:ndvi", "NDVI"), P("iride:parcels", "Particelle"), P("demo:roads", "Strade")];
  const strip = (c: Catalog) => ({
    folders: c.folders.map(({ fid: _f, ...r }) => r).sort((a, b) => a.key.localeCompare(b.key)),
    layers: c.layers.map(({ fid: _f, ...r }) => r).sort((a, b) => a.layer.localeCompare(b.layer)),
  });

  beforeAll(async () => {
    w = await preparedWorkspace("gema_cat");
    acc = { enabled: true, adminRole: "a", viewerRole: "v", rolesClient: "c", knownRoles: [], workspace: w.ws };
    // le richieste dell'app ricevono la Basic dell'amministratore, come se passassero dal proxy nginx in scrittura
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(G.url)) return realFetch(input, init);
      const headers = new Headers(init.headers);
      if (!headers.has("Authorization")) headers.set("Authorization", w.basic);
      return realFetch(input, { ...init, headers });
    });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await w?.cleanup();
  });

  it("publish-geoserver.sh pubblica e verifica anche le tabelle del catalogo", () => {
    for (const t of ["catalog_folders", "catalog_layers"]) {
      expect(w.publishOutput).toContain(`layer ${w.ws}:${t} pubblicato`);
      expect(w.publishOutput).toContain(`verifica WFS ${w.ws}:${t} ok`);
    }
  });

  it("catalogo nuovo: vuoto; il primo salvataggio scrive una riga per cartella e per layer, con i tipi giusti", async () => {
    const empty = await loadCatalog(G.url, kc, acc);
    expect(empty).toEqual({ folders: [], layers: [] });
    let { cat } = editableCatalog(PRODUCTS, empty);
    const r = addFolder(cat, "Agricoltura è qui", "");
    cat = moveTo(r.cat, { kind: "layer", name: "iride:ndvi" }, r.key);
    cat = patchFolder(cat, r.key, { expanded: true, description: "Con <tag> & \"virgolette\"" });
    cat = patchLayer(cat, "iride:ndvi", { title: "Vegetazione", defaultOn: true });
    cat = patchLayer(cat, "demo:roads", { hidden: true });
    const n = await saveCatalog(G.url, kc, acc, empty, cat);
    expect(n).toBe(cat.folders.length + cat.layers.length);
    const back = await loadCatalog(G.url, kc, acc);
    expect(strip(back)).toEqual(strip(cat));
    expect(back.layers.every((l) => /^catalog_layers\./.test(l.fid ?? ""))).toBe(true);
    expect(psqlAdmin("SELECT string_agg(DISTINCT updated_by, ',') FROM gema_config.catalog_layers", w.db)).toBe("it-admin");
    expect(psqlAdmin("SELECT default_on FROM gema_config.catalog_layers WHERE layer = 'iride:ndvi'", w.db)).toBe("t");
  });

  it("modifiche, spostamenti ed eliminazioni nella stessa transazione", async () => {
    const saved = await loadCatalog(G.url, kc, acc);
    const s = editableCatalog(PRODUCTS, saved);
    let cat = removeFolder(s.cat, "ws-demo");
    cat = moveTo(cat, { kind: "layer", name: "iride:parcels" }, "", { kind: "folder", key: "f-agricoltura-e-qui" });
    cat = patchLayer(cat, "demo:roads", { defaultOn: true });
    await saveCatalog(G.url, kc, acc, saved, rowsToSave({ ...s, cat }));
    const back = await loadCatalog(G.url, kc, acc);
    expect(strip(back)).toEqual(strip(cat));
    expect(back.folders.some((f) => f.key === "ws-demo")).toBe(false);
    expect(back.layers.find((l) => l.layer === "demo:roads")).toMatchObject({ hidden: false, defaultOn: true });
  });

  it("tutto o niente: un vincolo violato annulla anche le altre operazioni della transazione", async () => {
    const saved = await loadCatalog(G.url, kc, acc);
    const s = editableCatalog(PRODUCTS, saved);
    const cat = patchFolder(s.cat, "f-agricoltura-e-qui", { title: "Rinominata" });
    // riga che il database rifiuta (nascosto e acceso insieme), scritta senza passare da patchLayer
    const bad = { ...cat, layers: cat.layers.map((l) => (l.layer === "iride:parcels" ? { ...l, hidden: true, defaultOn: true } : l)) };
    await expect(saveCatalog(G.url, kc, acc, saved, bad)).rejects.toThrow();
    expect(strip(await loadCatalog(G.url, kc, acc))).toEqual(strip(saved));
  });

  it("conflitto: se il catalogo cambia dopo la lettura, saveCatalog non scrive", async () => {
    const saved = await loadCatalog(G.url, kc, acc);
    psqlAdmin("UPDATE gema_config.catalog_folders SET title = 'Cambiata da altri' WHERE folder_key = 'f-agricoltura-e-qui'", w.db);
    const s = editableCatalog(PRODUCTS, saved);
    await expect(saveCatalog(G.url, kc, acc, saved, rowsToSave({ ...s, cat: patchLayer(s.cat, "iride:ndvi", { title: "Mio" }) }))).rejects.toBeInstanceOf(CatalogConflictError);
    expect(psqlAdmin("SELECT title FROM gema_config.catalog_layers WHERE layer = 'iride:ndvi'", w.db)).toBe("Vegetazione");
  });
});
