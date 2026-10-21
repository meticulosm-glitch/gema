// Sicurezza del server web e errori del browser: intestazioni (anche su index.html, config.json e asset), CSP applicata
// (uno script inline iniettato non parte e la violazione finisce nel log), errori JavaScript e promesse rifiutate nel log
// JSON per Loki (senza token, solo il percorso della pagina), limiti per client (429) su segnalazioni e GeoServer,
// CLIENT_ERRORS=false, CSP=report-only, FRAME_ANCESTORS.
// Tutti gli altri scenari girano con la CSP applicata: una violazione lì è un errore in console e fa fallire il test.
import fs from "node:fs";
import path from "node:path";
import { J, MOCK, crash, launchBrowser, prepare, results, startNginx, waitFor } from "./lib.mjs";

const { check, finish } = results();
const base = {
  AUTH_ENABLED: "false", GEOSERVER_PROXY_URL: `${MOCK}/geoserver`, GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass",
  BASEMAP_TILES: `${MOCK}/tiles/{z}/{x}/{y}.png`, BASEMAPS: `osm|Mappa|${MOCK}/tiles/{z}/{x}/{y}.png|© test`,
  APP_TITLE: "Test sicurezza", MAP_CENTER_LON: "12.05", MAP_CENTER_LAT: "41.0", MAP_ZOOM: "12", GEOCODER: "off", USAGE_STATS: "off",
};
/** Righe JSON del log di nginx con un certo type (client-error, csp-violation), con il corpo già decodificato. */
const reports = (inst, type) => {
  const f = path.join(inst.d, "access.log");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter((l) => l.startsWith("{") && l.includes(`"type":"${type}"`)).map((l) => {
    const o = JSON.parse(l);
    try { o.body = JSON.parse(o.report); } catch { o.body = null; }
    return o;
  });
};
const headers = async (url) => { const r = await fetch(url); await r.arrayBuffer(); return r.headers; };
const post = (url, body, type = "application/json") => fetch(url, { method: "POST", body, headers: { "Content-Type": type } }).then(async (r) => { await r.arrayBuffer(); return r.status; });

(async () => {
  prepare();
  await J("/__reset");
  const S = startNginx("SEC", 8073, { ...base, EDIT_ENABLED: "true", GEOSERVER_RATE: "5r/s", GEOSERVER_BURST: "10", GEOSERVER_WRITE_RATE: "1r/s", GEOSERVER_WRITE_BURST: "2" });
  const OFF = startNginx("SECOFF", 8072, { ...base, CLIENT_ERRORS: "false", CSP: "report-only", FRAME_ANCESTORS: "https://intranet.ente.it" });

  // ============================================================ intestazioni
  console.log("\n== intestazioni ==");
  const asset = fs.readdirSync(path.join(S.d, "html/assets")).find((f) => /^index-.*\.js$/.test(f));
  const worker = fs.readdirSync(path.join(S.d, "html/assets")).find((f) => /\.mjs$/.test(f));
  const urls = { "index.html": "/", "pagina SPA": "/dashboards", "config.json": "/config.json", asset: `/assets/${asset}`, worker: `/assets/${worker}`, GeoServer: "/geoserver/ows?service=WMS&request=GetCapabilities&version=1.3.0" };
  const missing = [];
  for (const [name, u] of Object.entries(urls)) {
    const h = await headers(S.url + u);
    for (const k of ["content-security-policy", "x-frame-options", "x-content-type-options", "referrer-policy", "permissions-policy"]) if (!h.get(k)) missing.push(`${name}: ${k}`);
  }
  check("tutte le risposte hanno CSP, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy (anche le location con intestazioni proprie)", missing.length === 0, missing.join(", "));
  const h = await headers(S.url + "/");
  const csp = h.get("content-security-policy") ?? "";
  check("CSP: script e stili solo da questo sito, sfondi dal loro server, segnalazioni a /csp-report", /script-src 'self';/.test(csp) && /style-src 'self';/.test(csp) && csp.includes(`connect-src 'self' ${MOCK}`) && /report-uri \/csp-report/.test(csp) && !/unsafe/.test(csp));
  check("le altre intestazioni restano (cache di config.json e asset)", (await headers(S.url + "/config.json")).get("cache-control") === "no-store" && /immutable/.test((await headers(S.url + `/assets/${asset}`)).get("cache-control") ?? ""));

  // ============================================================ nel browser
  console.log("\n== nel browser ==");
  const browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  await page.goto(S.url + "/#s=" + encodeURIComponent(JSON.stringify({ v: [12.05, 41.0, 12], l: [["iride:parcels", 1, "", ""]] })));
  await page.waitForSelector(".active-card", { timeout: 15000 });
  check("l'applicazione funziona con la CSP applicata (mappa, layer, nessuna violazione)", (await page.locator(".map-el canvas").count()) > 0 && !consoleErrors.some((t) => /Content Security Policy/.test(t)), consoleErrors.slice(0, 3).join(" | "));

  const injected = await page.evaluate(() => { const s = document.createElement("script"); s.textContent = "window.__pwned = 1"; document.head.appendChild(s); return window.__pwned ?? null; });
  check("uno script inline iniettato non parte", injected === null);
  check("e la violazione arriva nel log come csp-violation", await waitFor(() => reports(S, "csp-violation").some((r) => /script-src/.test(r.report))));

  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhZGEifQ.c2lnbmF0dXJh";
  await page.evaluate((t) => { setTimeout(() => { throw new TypeError(`prova e2e con token ${t}`); }, 0); Promise.reject(new Error("promessa e2e")); }, jwt);
  const errs = await waitFor(async () => { const r = reports(S, "client-error"); return r.length >= 2 ? r : false; });
  const thrown = (errs || []).find((r) => r.body?.message?.includes("prova e2e"));
  const rejected = (errs || []).find((r) => r.body?.message === "promessa e2e");
  check("errore JavaScript nel log JSON (type client-error): messaggio, pila, versione della build", !!thrown && thrown.status === 204 && thrown.body.kind === "error" && thrown.body.release === asset && typeof thrown.body.stack === "string", JSON.stringify(errs).slice(0, 300));
  check("senza token né vista: token oscurato, pagina solo come percorso", !!thrown && thrown.body.message.includes("[token]") && !JSON.stringify(thrown).includes(jwt) && thrown.body.page === "/" && !/#s=/.test(JSON.stringify(thrown)));
  check("promessa rifiutata senza catch: kind rejection", !!rejected && rejected.body.kind === "rejection");
  const before = reports(S, "client-error").length;
  await page.evaluate(() => { for (let i = 0; i < 5; i++) setTimeout(() => { throw new Error("ripetuto"); }, 0); });
  await page.waitForTimeout(800);
  check("lo stesso errore ripetuto: una sola segnalazione", reports(S, "client-error").length === before + 1);
  await ctx.close();

  // ============================================================ limiti e abusi
  console.log("\n== limiti ==");
  const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => post(S.url + "/client-errors", JSON.stringify({ kind: "error", message: `raffica ${i}` }))));
  check("raffica di segnalazioni: le prime accettate (204), poi 429", burst.filter((s) => s === 204).length >= 15 && burst.filter((s) => s === 429).length >= 10, burst.join(","));
  await new Promise((r) => setTimeout(r, 2500));
  check("corpo oltre 16 kB: 413", (await post(S.url + "/client-errors", JSON.stringify({ message: "x".repeat(20000) }))) === 413);
  check("solo POST: GET 403", (await fetch(S.url + "/client-errors")).status === 403);
  const reads = await Promise.all(Array.from({ length: 40 }, () => fetch(S.url + "/geoserver/ows?service=WMS&request=GetCapabilities&version=1.3.0").then((r) => r.status)));
  check("GeoServer, letture oltre il limite per client: 429", reads.filter((s) => s === 200).length >= 10 && reads.filter((s) => s === 429).length >= 20, reads.join(","));
  await new Promise((r) => setTimeout(r, 2500));
  const tx = '<wfs:Transaction service="WFS" version="1.0.0" xmlns:wfs="http://www.opengis.net/wfs"/>';
  const writes = [];
  for (let i = 0; i < 6; i++) writes.push(await post(S.url + "/geoserver/wfs", tx, "text/xml"));
  check("GeoServer, scritture (POST WFS-T) oltre il limite: 429", writes.slice(0, 3).every((s) => s !== 429) && writes.slice(3).every((s) => s === 429), writes.join(","));
  await new Promise((r) => setTimeout(r, 1200));
  const wfsGets = await Promise.all(Array.from({ length: 4 }, () => fetch(S.url + "/geoserver/wfs?service=WFS&request=GetCapabilities&version=1.0.0").then((r) => r.status)));
  check("le letture sulla stessa route WFS non contano come scritture", wfsGets.every((s) => s === 200), wfsGets.join(","));

  // ============================================================ CLIENT_ERRORS=false, report-only, FRAME_ANCESTORS
  console.log("\n== configurazioni alternative ==");
  const oh = await headers(OFF.url + "/");
  check("CSP=report-only: solo Content-Security-Policy-Report-Only", !oh.get("content-security-policy") && /script-src 'self'/.test(oh.get("content-security-policy-report-only") ?? ""));
  check("FRAME_ANCESTORS: frame-ancestors con il sito indicato, senza X-Frame-Options", /frame-ancestors 'self' https:\/\/intranet\.ente\.it/.test(oh.get("content-security-policy-report-only") ?? "") && !oh.get("x-frame-options"));
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await p2.goto(OFF.url + "/");
  await p2.waitForSelector(".active-card, .map-el", { timeout: 15000 });
  await p2.evaluate(() => { setTimeout(() => { throw new Error("non segnalato"); }, 0); });
  await p2.waitForTimeout(800);
  check("CLIENT_ERRORS=false: il browser non manda nulla e /client-errors non esiste", reports(OFF, "client-error").length === 0 &&
    !fs.readFileSync(path.join(OFF.d, "access.log"), "utf8").includes("/client-errors") && (await post(OFF.url + "/client-errors", "{}")) !== 204);
  await ctx2.close();

  await browser.close();
  finish();
})().catch(crash);
