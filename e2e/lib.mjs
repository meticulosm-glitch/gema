// Utilità comuni agli scenari end-to-end: percorsi, nginx configurato dagli script di entrypoint dell'immagine,
// browser, attese ed esito dei controlli.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export const E2E = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(E2E, "..");
/** Screenshot, log di nginx e configurazioni generate (ignorata da git). */
export const RUN = path.resolve(process.env.E2E_RUN_DIR || path.join(E2E, ".run"));
export const MOCK = `http://127.0.0.1:${process.env.MOCK_PORT || 8600}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ripete `fn` finché restituisce un valore vero (o scade il tempo): restituisce quel valore oppure false. */
export async function waitFor(fn, ms = 10000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try { const v = await fn(); if (v) return v; } catch { /* non ancora */ }
    await sleep(100);
  }
  return false;
}

/** GET JSON verso il server finto (stato, log, reset...). */
export const J = async (u) => (await fetch(MOCK + u)).json();

/** Percorso di un file in RUN/shots (screenshot, file scaricati). */
export const shot = (name) => {
  const d = path.join(RUN, "shots");
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, name);
};

/** Raccoglie l'esito dei controlli; `finish` esce con 1 se almeno uno è fallito. */
export function results() {
  const list = [];
  const check = (name, ok, extra = "") => {
    list.push([name, !!ok]);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !extra ? "" : "  " + extra}`);
    return !!ok;
  };
  const finish = () => {
    stopAll();
    const failed = list.filter(([, ok]) => !ok);
    console.log(`\n${list.length - failed.length}/${list.length} controlli superati`);
    for (const [n] of failed) console.log(`  FAIL ${n}`);
    process.exit(failed.length ? 1 : 0);
  };
  return { check, finish };
}

/** Errore imprevisto in uno scenario: ferma nginx ed esce con 2. */
export function crash(e) {
  console.error("ERRORE NEL TEST:", e);
  stopAll();
  process.exit(2);
}

// ---------------------------------------------------------------- nginx

const started = [];
/** Ferma le istanze nginx avviate da questo processo. */
export function stopAll() {
  for (const s of started.splice(0)) s.stop();
}

/** Ferma le istanze lasciate accese da esecuzioni precedenti (solo quelle in RUN: il servizio di sistema non si tocca). */
function stopStale() {
  if (!fs.existsSync(RUN)) return;
  for (const d of fs.readdirSync(RUN)) {
    const pid = path.join(RUN, d, "nginx.pid");
    if (!fs.existsSync(pid)) continue;
    try { process.kill(Number(fs.readFileSync(pid, "utf8").trim()), "SIGTERM"); } catch { /* già fermo */ }
    fs.rmSync(pid, { force: true });
  }
}

/** Controlla i prerequisiti e ripulisce le istanze precedenti. */
export function prepare() {
  if (!fs.existsSync(path.join(ROOT, "dist/index.html"))) throw new Error("build mancante: esegui prima `npm run build`");
  fs.mkdirSync(path.join(RUN, "shots"), { recursive: true });
  stopStale();
}

const sub = (d) => (s) => s
  .replaceAll("/etc/nginx/proxy.d", `${d}/proxy.d`)
  .replaceAll("/usr/share/nginx/html", `${d}/html`)
  .replaceAll("/tmp/nginx-geocode", `${d}/tmp/geocode`)
  .replaceAll("/tmp/nginx-tiles", `${d}/tmp/tiles`)
  .replaceAll("access_log /dev/stdout ", `access_log ${d}/access.log `);

/** Esegue 40-runtime-config.sh con le variabili date e restituisce il config.json generato (testo). */
export function runtimeConfig(env) {
  const d = fs.mkdtempSync(path.join(RUN, "cfg-"));
  try {
    fs.mkdirSync(path.join(d, "html"));
    const sc = path.join(d, "40-runtime-config.sh");
    fs.writeFileSync(sc, sub(d)(fs.readFileSync(path.join(ROOT, "docker-entrypoint.d/40-runtime-config.sh"), "utf8")));
    execSync(`sh ${sc}`, { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
    return fs.readFileSync(path.join(d, "html/config.json"), "utf8");
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

/**
 * Avvia nginx su 127.0.0.1:`port` con la build in dist/ e la configurazione generata dagli script di entrypoint
 * (35-proxy-config.sh, 40-runtime-config.sh, 45-security-config.sh) e da nginx/default.conf, come nell'immagine.
 */
export function startNginx(name, port, env) {
  const d = path.join(RUN, name);
  const old = path.join(d, "nginx.pid");
  if (fs.existsSync(old)) { try { process.kill(Number(fs.readFileSync(old, "utf8").trim())); } catch { /* già fermo */ } }
  fs.rmSync(d, { recursive: true, force: true });
  for (const x of ["proxy.d", "html", "tmp"]) fs.mkdirSync(path.join(d, x), { recursive: true });
  fs.cpSync(path.join(ROOT, "dist"), path.join(d, "html"), { recursive: true });
  fs.rmSync(path.join(d, "html/config.json"), { force: true });
  const s = sub(d);
  for (const sc of ["35-proxy-config.sh", "40-runtime-config.sh", "45-security-config.sh"]) {
    fs.writeFileSync(path.join(d, sc), s(fs.readFileSync(path.join(ROOT, "docker-entrypoint.d", sc), "utf8")));
    execSync(`sh ${path.join(d, sc)}`, { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  }
  const conf = s(fs.readFileSync(path.join(ROOT, "nginx/default.conf"), "utf8"))
    .replace("listen 8080", `listen 127.0.0.1:${port}`)
    .replace("error_log  /dev/stderr warn", `error_log ${d}/server-error.log warn`);
  fs.writeFileSync(path.join(d, "default.conf"), conf);
  const mime = ["/etc/nginx/mime.types", "/opt/homebrew/etc/nginx/mime.types", "/usr/local/etc/nginx/mime.types"].find((f) => fs.existsSync(f));
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  fs.writeFileSync(
    path.join(d, "nginx.conf"),
    `${asRoot ? "user root;\n" : ""}pid ${d}/nginx.pid;\nerror_log ${d}/error.log;\nevents {}\nhttp {\n${mime ? ` include ${mime};\n` : ""}` +
      ` client_body_temp_path ${d}/tmp/b; proxy_temp_path ${d}/tmp/p; fastcgi_temp_path ${d}/tmp/f; uwsgi_temp_path ${d}/tmp/u; scgi_temp_path ${d}/tmp/s;\n` +
      ` include ${d}/default.conf;\n}\n`,
  );
  execSync(`nginx -t -c ${d}/nginx.conf -p ${d} 2>&1`);
  execSync(`nginx -c ${d}/nginx.conf -p ${d}`);
  const inst = {
    d,
    url: `http://127.0.0.1:${port}`,
    stop: () => {
      try { process.kill(Number(fs.readFileSync(path.join(d, "nginx.pid"), "utf8").trim())); } catch { /* già fermo */ }
    },
  };
  started.push(inst);
  return inst;
}

/** Apre una pagina admin dal menu "Admin" della barra. */
export async function goAdmin(page, label) {
  await page.locator("button.nav-tag").click();
  await page.locator(`.nav-menu a:has-text("${label}")`).click();
}

// ---------------------------------------------------------------- browser

/** playwright-core: dalle dipendenze di e2e/ (npm --prefix e2e ci) o da un'installazione globale. */
async function playwright() {
  const require = createRequire(path.join(E2E, "package.json"));
  const candidates = [];
  try { candidates.push(require.resolve("playwright-core")); } catch { /* non installato in e2e/ */ }
  try { candidates.push(require.resolve("playwright")); } catch { /* idem */ }
  candidates.push("/opt/npm-tools/node_modules/playwright-core/index.mjs");
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    const m = await import(pathToFileURL(c).href);
    return m.chromium ? m : m.default;
  }
  throw new Error("playwright non trovato: esegui `npm --prefix e2e ci` (e la prima volta `npx --prefix e2e playwright install chromium`)");
}

/** Chromium headless; CHROMIUM_PATH (o PLAYWRIGHT_BROWSERS_PATH/chromium) per usarne uno già installato. */
export async function launchBrowser() {
  const { chromium } = await playwright();
  const pre = process.env.CHROMIUM_PATH || (process.env.PLAYWRIGHT_BROWSERS_PATH && path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium"));
  return chromium.launch({
    ...(pre && fs.existsSync(pre) && fs.statSync(pre).isFile() ? { executablePath: pre } : {}),
    args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
}
