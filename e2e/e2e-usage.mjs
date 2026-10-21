// Statistiche d'uso: il browser raccoglie pagine, layer, strumenti e dashboard e li aggiunge a usage_events a gruppi
// (anche alla chiusura della pagina); modalità anonima, con nome e spenta; pagina admin con totali, classifiche e ruoli;
// in alternativa, log nginx in JSON per Loki.
import fs from "node:fs";
import path from "node:path";
import { J, MOCK, crash, launchBrowser, prepare, results, shot, startNginx, waitFor } from "./lib.mjs";

const { check, finish } = results();
const asRole = (roles, user = "bob") => J(`/__kc?user=${user}&roles=${encodeURIComponent(roles)}`);
const seed = (layer, list) => fetch(`${MOCK}/__seed?layer=${encodeURIComponent(layer)}`, { method: "POST", body: JSON.stringify(list) }).then((r) => r.json());
const events = async () => (await J("/__state"))["mapp:usage_events"].features.map((f) => f.properties);
const env = (extra) => ({
  AUTH_ENABLED: "true", KEYCLOAK_URL: `${MOCK}/kc`, KEYCLOAK_REALM: "test", KEYCLOAK_CLIENT_ID: "mapp",
  ACCESS_CONTROL: "true", KNOWN_ROLES: "fss-etl-viewer", GEOSERVER_WRITE_PASSTHROUGH: "true",
  GEOSERVER_PROXY_URL: `${MOCK}/geoserver`, GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass",
  BASEMAP_TILES: `${MOCK}/tiles/{z}/{x}/{y}.png`, BASEMAPS: `osm|Mappa|${MOCK}/tiles/{z}/{x}/{y}.png|© test`,
  APP_TITLE: "Test uso", MAP_CENTER_LON: "12.5", MAP_CENTER_LAT: "41.9", MAP_ZOOM: "9", GEOCODER: "off", ...extra,
});

(async () => {
  prepare();
  await J("/__reset");
  const A = startNginx("US", 8081, env({}));                                            // anonima (default)
  const N = startNginx("UN", 8079, env({ USAGE_STATS: "named", ACCESS_LOG_FORMAT: "json" })); // con nome, log JSON
  const O = startNginx("UO", 8078, env({ USAGE_STATS: "off" }));                         // spenta
  await seed("mapp:dashboards", [{ title: "Monitoraggio", description: "", roles: '["fss-etl-viewer"]', definition: "[]" }, { title: "Mai vista", description: "", roles: '["fss-etl-viewer"]', definition: "[]" }]);
  const browser = await launchBrowser();
  const errors = [];
  const session = async (base, user, roles, start = "/", wait = "label.item") => {
    await asRole(roles, user);
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
    await page.goto(base.url + start);
    await page.waitForSelector(wait, { state: "attached", timeout: 15000 });
    return { ctx, page };
  };
  /** Le stesse azioni in ogni modalità: layer, strumento, dashboard. */
  const actions = async (page) => {
    await page.evaluate(() => document.querySelectorAll("details.group").forEach((d) => (d.open = true)));
    await page.locator('label.item:has-text("Particelle") input').check();
    await page.waitForSelector(".active-card");
    await page.locator('button.tool[title="Misura distanza"]').click();
    await page.locator('.nav a:has-text("Dashboard")').click();
    await page.locator('.card-link:has-text("Monitoraggio")').click();
    await page.waitForSelector(".page-inner h1");
  };

  // ============================================================ anonima
  console.log("\n== raccolta anonima ==");
  let { ctx, page } = await session(A, "bob", "fss-etl-viewer");
  await actions(page);
  check("nessun invio a ogni clic: gli eventi si accumulano", (await events()).length === 0);
  await page.close({ runBeforeUnload: true }); // pagehide: invio con keepalive
  check("alla chiusura della pagina gli eventi arrivano, in una sola transazione", await waitFor(async () => (await events()).length >= 6) &&
    (await J("/__log")).filter((l) => l.method === "POST" && l.body.includes("usage_events")).length === 1);
  let ev = await events();
  const kinds = ev.map((e) => `${e.kind}:${e.target}`);
  check("pagine, layer, strumento, dashboard (nomi, mai contenuti)", ["page:mappa", "layer:iride:parcels", "tool:length", "page:elenco dashboard", "page:dashboard", "dashboard:Monitoraggio"].every((k) => kinds.includes(k)), kinds.join(", "));
  check("anonima: nessun nome utente; ruoli e stessa sessione", ev.every((e) => e.username === "" && e.roles === '["fss-etl-viewer"]' && e.session === ev[0].session && e.session.length >= 8));
  await ctx.close();

  // ============================================================ pagina admin
  console.log("\n== pagina admin ==");
  // l'amministratore apre direttamente la pagina: i suoi eventi non sono ancora stati inviati
  ({ ctx, page } = await session(A, "alice", "fss-etl-admin", "/admin/usage", '[aria-label="Totali del periodo"]'));
  const kpi = await page.locator('[aria-label="Totali del periodo"]').innerText();
  check("totali: 1 sessione, utenti non raccolti, azioni", /1\s*sessioni/i.test(kpi) && /—\s*utenti/i.test(kpi) && /non raccolti/.test(kpi), kpi);
  check("layer accesi con il titolo del catalogo", /Particelle\s*1/.test(await page.locator('[aria-label="Layer accesi"]').innerText()));
  check("strumenti con il nome leggibile", /Misura distanza\s*1/.test(await page.locator('[aria-label="Strumenti"]').innerText()));
  check("dashboard aperte e mai aperte", /Monitoraggio\s*1/.test(await page.locator('[aria-label="Dashboard aperte"]').innerText()) && /Dashboard mai aperte nel periodo: Mai vista/.test(await page.locator(".page").innerText()));
  check("per ruolo", /fss-etl-viewer\s*1\s*\d+/.test(await page.locator('[aria-label="Per ruolo"]').innerText()));
  check("niente classifica utenti in modalità anonima", (await page.locator('[aria-label="Utenti più attivi"]').count()) === 0);
  await page.screenshot({ path: shot("usage-admin.png"), fullPage: true });
  await ctx.close();

  // ============================================================ con nome
  console.log("\n== raccolta con nome e log JSON ==");
  await J("/__reset");
  await seed("mapp:dashboards", [{ title: "Monitoraggio", description: "", roles: '["fss-etl-viewer"]', definition: "[]" }]);
  ({ ctx, page } = await session(N, "bob", "fss-etl-viewer"));
  await actions(page);
  await page.close({ runBeforeUnload: true });
  check("con nome: l'utente negli eventi", await waitFor(async () => (await events()).length >= 6) && (await events()).every((e) => e.username === "bob"));
  await ctx.close();
  ({ ctx, page } = await session(N, "alice", "fss-etl-admin", "/admin/usage", '[aria-label="Utenti più attivi"]'));
  check("utenti più attivi", /bob\s*1\s*1/.test(await page.locator('[aria-label="Utenti più attivi"]').innerText()) && /1\s*utenti/i.test(await page.locator('[aria-label="Totali del periodo"]').innerText()));
  await ctx.close();
  const lines = fs.readFileSync(path.join(N.d, "access.log"), "utf8").trim().split("\n");
  const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  check("log nginx in JSON: una riga valida per richiesta", parsed.length > 10 && parsed.every(Boolean));
  // i parametri restano codificati come nell'URL (in LogQL: | json | line_format "{{ urldecode .layers }}")
  check("log JSON: layer richiesti nelle GetMap, nessun token", parsed.some((l) => l.request === "GetMap" && decodeURIComponent(l.layers) === "iride:parcels" && l.status === 200) && !lines.some((l) => /Bearer|eyJ/.test(l)));
  check("istanza di default: log di testo", /^127\.0\.0\.1 \[/.test(fs.readFileSync(path.join(A.d, "access.log"), "utf8")));

  // ============================================================ spenta
  console.log("\n== raccolta spenta ==");
  await J("/__reset");
  await seed("mapp:dashboards", [{ title: "Monitoraggio", description: "", roles: '["fss-etl-viewer"]', definition: "[]" }]);
  ({ ctx, page } = await session(O, "bob", "fss-etl-viewer"));
  await actions(page);
  await page.close({ runBeforeUnload: true });
  await new Promise((r) => setTimeout(r, 800));
  check("spenta: nessun evento e nessuna richiesta", (await events()).length === 0 && !(await J("/__log")).some((l) => l.body.includes("usage_events")));
  await ctx.close();

  // ============================================================ tabella mancante
  console.log("\n== tabella mancante ==");
  await J("/__tables?off=1&only=mapp:usage_events");
  ({ ctx, page } = await session(A, "bob", "fss-etl-viewer"));
  await actions(page);
  await page.close({ runBeforeUnload: true });
  await new Promise((r) => setTimeout(r, 800));
  check("tabella non pubblicata: l'app funziona e non insiste (nessuna transazione)", !(await J("/__log")).some((l) => l.method === "POST" && l.body.includes("usage_events")));
  await ctx.close();
  await J("/__tables?off=0");

  check("nessun errore JS/console durante i test", errors.length === 0, errors.slice(0, 5).join(" | "));
  await browser.close();
  finish();
})().catch(crash);
