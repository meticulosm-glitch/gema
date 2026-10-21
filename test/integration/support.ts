// Supporto ai test di integrazione: script del chart Helm, configurazione dei servizi reali e utilità.
//
// I test usano gli script della ConfigMap del chart (mapp-config.sql, init-db.sh, publish-geoserver.sh) così come
// sono: ciò che si verifica qui è esattamente ciò che gira nel Job di Kubernetes.
import { execFileSync, spawnSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIGMAP = path.join(ROOT, "charts/templates/geoserver-configuration/configmap.yaml");

/**
 * Estrae i blocchi `chiave: |` di `data:` dalla ConfigMap. Il file non contiene direttive Helm in quei blocchi,
 * quindi basta togliere l'indentazione: niente parser YAML né rendering del chart.
 */
export function configMapData(file = CONFIGMAP): Record<string, string> {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const out: Record<string, string> = {};
  const start = lines.findIndex((l) => /^data:\s*$/.test(l));
  if (start < 0) throw new Error(`${file}: sezione data mancante`);
  let key = "";
  let body: string[] = [];
  const flush = () => { if (key) out[key] = body.join("\n").replace(/\n*$/, "\n"); };
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break; // fine della sezione data
    const m = l.match(/^ {2}([\w.-]+): \|\s*$/);
    if (m) { flush(); key = m[1]; body = []; continue; }
    if (key) body.push(l.startsWith("    ") ? l.slice(4) : l.trim() === "" ? "" : l);
  }
  flush();
  return out;
}

/** Scrive gli script della ConfigMap in una cartella, con il percorso dello SQL adattato (nel Job è /scripts). */
export function chartScripts(): { dir: string; initDb: string; publish: string; sql: string; cleanup: () => void } {
  const data = configMapData();
  for (const k of ["mapp-config.sql", "init-db.sh", "publish-geoserver.sh"]) if (!data[k]) throw new Error(`ConfigMap: manca ${k}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapp-int-"));
  const sql = path.join(dir, "mapp-config.sql");
  fs.writeFileSync(sql, data["mapp-config.sql"]);
  const initDb = path.join(dir, "init-db.sh");
  fs.writeFileSync(initDb, data["init-db.sh"].replaceAll("/scripts/mapp-config.sql", sql));
  const publish = path.join(dir, "publish-geoserver.sh");
  fs.writeFileSync(publish, data["publish-geoserver.sh"]);
  return { dir, initDb, publish, sql, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export interface ShResult { code: number; out: string }
/** Esegue uno script sh con un ambiente pulito (solo PATH e le variabili date). */
export function sh(script: string, env: Record<string, string>): ShResult {
  const r = spawnSync("sh", [script], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 600_000 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// ---------------------------------------------------------------- servizi reali (variabili d'ambiente)

const env = process.env;
/** Con INT_REQUIRE=1 (in CI) un servizio non configurato è un errore, non un test saltato. */
export const required = env.INT_REQUIRE === "1";

export const pg = env.INT_PGHOST
  ? {
      host: env.INT_PGHOST,
      port: env.INT_PGPORT ?? "5432",
      adminUser: env.INT_PG_ADMIN_USER ?? "postgres",
      adminPassword: env.INT_PG_ADMIN_PASSWORD ?? "",
    }
  : null;

export const gs = env.INT_GEOSERVER_URL
  ? {
      url: env.INT_GEOSERVER_URL.replace(/\/$/, ""),
      user: env.INT_GEOSERVER_USER ?? "admin",
      password: env.INT_GEOSERVER_PASSWORD ?? "geoserver",
      /** host di PostgreSQL visto da GeoServer (in docker compose è il nome del servizio) */
      dbHostFromGeoserver: env.INT_DS_DB_HOST ?? env.INT_PGHOST ?? "",
      dbPortFromGeoserver: env.INT_DS_DB_PORT ?? "5432",
      /** INT_PUBLISH=false: workspace già pubblicato (es. un GeoServer di sviluppo), si salta la preparazione */
      publish: env.INT_PUBLISH !== "false",
      workspace: env.INT_WORKSPACE ?? "gema_it",
    }
  : null;

export function missing(what: string, vars: string): string {
  return `${what} non configurato: imposta ${vars} (vedi test/integration/README.md)`;
}

/** psql come amministratore: restituisce le righe (separatore |) o lancia con il messaggio di PostgreSQL. */
export function psqlAdmin(sql: string, db = "postgres"): string {
  if (!pg) throw new Error("PostgreSQL non configurato");
  return execFileSync("psql", ["-h", pg.host, "-p", pg.port, "-U", pg.adminUser, "-d", db, "-v", "ON_ERROR_STOP=1", "-Atqc", sql], {
    env: { ...process.env, PGPASSWORD: pg.adminPassword, PGCONNECT_TIMEOUT: "5" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** psql con un utente qualsiasi; non lancia: restituisce codice e messaggi. */
export function psqlAs(user: string, password: string, db: string, sql: string): ShResult {
  if (!pg) throw new Error("PostgreSQL non configurato");
  const r = spawnSync("psql", ["-h", pg.host, "-p", pg.port, "-U", user, "-d", db, "-v", "ON_ERROR_STOP=1", "-Atqc", sql], {
    env: { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: "5" },
    encoding: "utf8",
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** Nome univoco per database, utenti e workspace creati da un test (solo minuscole, cifre e _). */
export const uniq = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

/**
 * Database, utente applicativo e workspace GeoServer nuovi, preparati con gli script del chart (come il Job).
 * `cleanup` rimuove tutto. Servono PostgreSQL e GeoServer configurati.
 */
export async function preparedWorkspace(prefix = "gema_it") {
  if (!pg || !gs) throw new Error("servono PostgreSQL e GeoServer");
  const G = gs;
  const scripts = chartScripts();
  const ws = uniq(prefix);
  const db = uniq("it_gs");
  const user = uniq("gs_app");
  const password = "pw-geoserver-app";
  const basic = "Basic " + Buffer.from(`${G.user}:${G.password}`).toString("base64");
  const init = sh(scripts.initDb, initDbEnv({ DB_CREATE: "true", MAPP_DB: db, MAPP_SCHEMA: "gema_config", GS_DB_USER: user, GS_DB_PASSWORD: password }));
  if (init.code !== 0) { scripts.cleanup(); throw new Error(`init-db.sh fallito:\n${init.out}`); }
  const pub = sh(scripts.publish, {
    GEOSERVER_URL: G.url, GEOSERVER_USER: G.user, GEOSERVER_PASSWORD: G.password, CONFIG_WORKSPACE: ws, DATASTORE: "gema_config",
    MAPP_DB: db, MAPP_SCHEMA: "gema_config", PGHOST: pg.host, DS_DB_HOST: G.dbHostFromGeoserver, DS_DB_PORT: G.dbPortFromGeoserver,
    GS_DB_USER: user, GS_DB_PASSWORD: password, WAIT_TRIES: "60", TMPDIR: scripts.dir,
  });
  if (pub.code !== 0) { scripts.cleanup(); throw new Error(`publish-geoserver.sh fallito:\n${pub.out}`); }
  /** Chiamata REST a GeoServer come amministratore. */
  const rest = (method: string, p: string, body?: unknown) =>
    fetch(`${G.url}/rest${p}`, {
      method,
      headers: { Authorization: basic, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return {
    ws, db, basic, rest, publishOutput: pub.out,
    cleanup: async () => {
      await rest("DELETE", `/workspaces/${ws}?recurse=true`).catch(() => undefined);
      try { psqlAdmin(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`); } catch { /* già rimosso */ }
      try { psqlAdmin(`DROP ROLE IF EXISTS "${user}"`); } catch { /* già rimosso */ }
      scripts.cleanup();
    },
  };
}

/**
 * Legge uno zip dalla directory centrale (come fanno gli unzip veri): funziona anche con gli zip "in streaming" di Java,
 * che nell'intestazione locale hanno dimensioni a zero. Metodi supportati: 0 (stored) e 8 (deflate).
 */
export function readZip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("zip non valido: manca la fine della directory centrale");
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let k = 0; k < entries; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip non valido: voce della directory centrale");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, inflateRawSync(raw));
    else throw new Error(`zip: metodo di compressione ${method} non supportato (${name})`);
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

/** nginx è installato su questa macchina (serve ai test che lo avviano davvero). */
export const hasNginx = spawnSync("nginx", ["-v"]).status === 0;

/** Ambiente di base per init-db.sh verso il PostgreSQL dei test. */
export function initDbEnv(extra: Record<string, string>): Record<string, string> {
  if (!pg) throw new Error("PostgreSQL non configurato");
  return { PGHOST: pg.host, PGPORT: pg.port, PG_ADMIN_USER: pg.adminUser, PG_ADMIN_PASSWORD: pg.adminPassword, WAIT_TRIES: "6", ...extra };
}
