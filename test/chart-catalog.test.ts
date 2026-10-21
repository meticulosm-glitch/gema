import { describe, expect, it } from "vitest";
import { configMapData } from "./integration/support";

// Controlli statici sulla ConfigMap del Job: le tabelle del catalogo devono essere create, pubblicate e protette
// come le altre tabelle di configurazione (i test di integrazione eseguono davvero gli script).
const data = configMapData();

describe("ConfigMap del Job: catalogo prodotti e viste iniziali per ruolo", () => {
  it("mapp-config.sql crea announcements: livelli ammessi e manutenzione non chiudibile", () => {
    expect(data["mapp-config.sql"]).toContain(`CREATE TABLE IF NOT EXISTS :"schema".announcements (`);
    expect(data["mapp-config.sql"]).toContain("CHECK (level IN ('info', 'warning', 'maintenance'))");
    expect(data["mapp-config.sql"]).toContain("CONSTRAINT announcements_maintenance_stays");
  });
  it("mapp-config.sql crea dashboard_drafts: titolo obbligatorio, una bozza per dashboard pubblicata", () => {
    expect(data["mapp-config.sql"]).toContain(`CREATE TABLE IF NOT EXISTS :"schema".dashboard_drafts (`);
    expect(data["mapp-config.sql"]).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS dashboard_drafts_dashboard_uq[\s\S]*WHERE dashboard_id IS NOT NULL AND dashboard_id <> ''/);
  });
  it("registro modifiche: tabella, funzione del trigger SECURITY DEFINER, trigger sulle tabelle, sola lettura, conservazione", () => {
    const sql = data["mapp-config.sql"];
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS :"schema".change_log (`);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION :"schema"\.gema_log_change\(\) RETURNS trigger\s+LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp/);
    expect(sql).toContain("ARRAY['role_rules', 'dashboards', 'catalog_folders', 'catalog_layers', 'role_views', 'edit_forms', 'announcements']");
    expect(sql).toContain(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON :"schema".change_log FROM :"gs_user";`);
    expect(sql.indexOf("REVOKE INSERT, UPDATE, DELETE, TRUNCATE")).toBeGreaterThan(sql.indexOf("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES")); // dopo il GRANT generale
    expect(data["init-db.sh"]).toContain(`-v log_days="\${CHANGE_LOG_DAYS:-0}"`);
    const s = data["publish-geoserver.sh"];
    expect(s).toContain(`acl change_log r "$WRITE"`);
    expect(s).toContain(`acl change_log w "ADMIN"`);
  });
  it("statistiche d'uso: eventi solo da aggiungere, viste aggregate per gli amministratori, conservazione", () => {
    const sql = data["mapp-config.sql"];
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS :"schema".usage_events (`);
    expect(sql).toContain("CHECK (kind IN ('page', 'layer', 'tool', 'dashboard', 'download', 'search', 'view'))");
    for (const v of ["usage_daily", "usage_sessions", "usage_roles", "usage_users"]) expect(sql).toContain(`CREATE OR REPLACE VIEW :"schema".${v} AS`);
    expect(sql).toContain(`REVOKE UPDATE, DELETE, TRUNCATE ON :"schema".usage_events FROM :"gs_user";`);
    expect(sql).toMatch(/\\if :prune_usage\s+DELETE FROM :"schema"\.usage_events WHERE at < now\(\) - make_interval\(days => :usage_days\);/);
    expect(data["init-db.sh"]).toContain(`-v usage_days="\${USAGE_DAYS:-180}"`);
    const s = data["publish-geoserver.sh"];
    expect(s).toContain(`acl usage_events r "$READ"`);
    expect(s).toContain(`acl usage_events w "$READ"`);
    expect(s).toContain(`for t in usage_daily usage_sessions usage_roles usage_users; do acl "$t" r "$WRITE"; acl "$t" w "ADMIN"; done`);
  });
  it("le bozze le leggono e scrivono solo gli amministratori", () => {
    const s = data["publish-geoserver.sh"];
    expect(s).toContain(`acl dashboard_drafts r "$WRITE"`);
    expect(s).toContain(`acl dashboard_drafts w "$WRITE"`);
    expect(s).not.toMatch(/for t in [^;]*dashboard_drafts/); // non nel ciclo che dà la lettura ai ruoli applicativi
  });
  it("mapp-config.sql crea edit_forms con un modulo per layer", () => {
    expect(data["mapp-config.sql"]).toContain(`CREATE TABLE IF NOT EXISTS :"schema".edit_forms (`);
    expect(data["mapp-config.sql"]).toMatch(/layer\s+text NOT NULL UNIQUE CHECK \(layer <> ''\)/);
  });
  it("mapp-config.sql crea role_views con il controllo del formato dell'area", () => {
    expect(data["mapp-config.sql"]).toContain(`CREATE TABLE IF NOT EXISTS :"schema".role_views (`);
    expect(data["mapp-config.sql"]).toContain("CONSTRAINT role_views_bbox_format");
  });
  it("mapp-config.sql crea catalog_folders e catalog_layers in modo idempotente", () => {
    for (const t of ["catalog_folders", "catalog_layers"]) expect(data["mapp-config.sql"]).toContain(`CREATE TABLE IF NOT EXISTS :"schema".${t} (`);
    expect(data["mapp-config.sql"]).toContain("CONSTRAINT catalog_layers_hidden_not_on CHECK (NOT (hidden AND default_on))");
  });
  it("publish-geoserver.sh pubblica le tabelle e ne limita la scrittura all'admin (SET_ACL)", () => {
    const s = data["publish-geoserver.sh"];
    expect(s).toMatch(/TABLES="role_rules dashboards saved_views catalog_folders catalog_layers role_views edit_forms announcements dashboard_drafts change_log usage_events usage_daily usage_sessions usage_roles usage_users"/);
    expect(s).toContain(`for t in role_rules dashboards catalog_folders catalog_layers role_views edit_forms announcements; do acl "$t" r "$READ"; acl "$t" w "$WRITE"; done`);
  });
});
