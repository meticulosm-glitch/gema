// «Visualizza come ruolo»: l'amministratore usa l'app con layer, strumenti, vista iniziale, dashboard e avvisi di un
// altro ruolo; barra sempre visibile, cambio ruolo, pagine admin bloccate con uscita, ricaricamento, ruolo senza regole.
import { J, MOCK, crash, launchBrowser, prepare, results, shot, startNginx, waitFor } from "./lib.mjs";

const { check, finish } = results();

const asRole = (roles, user = "bob") => J(`/__kc?user=${user}&roles=${encodeURIComponent(roles)}`);
const seed = (layer, list) => fetch(`${MOCK}/__seed?layer=${encodeURIComponent(layer)}`, { method: "POST", body: JSON.stringify(list) }).then((r) => r.json());
const near = (a, b, tol) => Math.abs(a - b) <= tol;

(async () => {
  prepare();
  await J("/__reset");
  const F = startNginx("VA", 8084, {
    AUTH_ENABLED: "true", KEYCLOAK_URL: `${MOCK}/kc`, KEYCLOAK_REALM: "test", KEYCLOAK_CLIENT_ID: "mapp",
    ACCESS_CONTROL: "true", KNOWN_ROLES: "fss-etl-viewer,fss-etl-ops,fss-etl-nuovo", GEOSERVER_WRITE_PASSTHROUGH: "true",
    GEOSERVER_PROXY_URL: `${MOCK}/geoserver`, GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass",
    BASEMAP_TILES: `${MOCK}/tiles/{z}/{x}/{y}.png`, BASEMAPS: `osm|Mappa|${MOCK}/tiles/{z}/{x}/{y}.png|© test`,
    APP_TITLE: "Test visualizza come", MAP_CENTER_LON: "10", MAP_CENTER_LAT: "44", MAP_ZOOM: "6", GEOCODER: "off",
  });
  await seed("mapp:role_rules", [
    { role: "fss-etl-viewer", layers: '["iride:parcels"]', tools: '["info"]' },
    { role: "fss-etl-ops", layers: '["*"]', tools: '["info","measure","table"]' },
  ]);
  await seed("mapp:role_views", [{ role: "fss-etl-viewer", bbox: "12.39,41.84,12.52,41.91", basemap: "", layers: '["iride:parcels"]' }]);
  await seed("mapp:dashboards", [
    { title: "Per il viewer", description: "", roles: '["fss-etl-viewer"]', definition: "[]" },
    { title: "Per ops", description: "", roles: '["fss-etl-ops"]', definition: "[]" },
  ]);
  await seed("mapp:announcements", [{ message: "Avviso per il viewer", level: "info", starts_at: "", ends_at: "", roles: '["fss-etl-viewer"]', dismissible: "true", active: "true", updated_at: "2026-10-01T00:00:00Z" }]);
  const browser = await launchBrowser();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  const items = async () => {
    await waitFor(async () => (await page.locator("label.item").count()) > 0);
    await page.evaluate(() => document.querySelectorAll("details.group").forEach((d) => (d.open = true)));
    return (await page.locator("label.item").allInnerTexts()).map((t) => t.trim()).sort();
  };
  const bar = page.locator('[role="region"][aria-label="Visualizza come ruolo"]');
  const view = async () => {
    await waitFor(async () => (await page.evaluate(() => location.hash)).startsWith("#s="));
    return JSON.parse(decodeURIComponent((await page.evaluate(() => location.hash)).slice(3))).v;
  };

  // ============================================================ amministratore
  console.log("\n== amministratore ==");
  await asRole("fss-etl-admin", "alice");
  await page.goto(F.url + "/");
  await page.waitForSelector("label.item", { timeout: 15000, state: "attached" });
  const adminItems = await items();
  check("admin: tutti i layer, nessuna barra, nessun avviso del viewer", adminItems.length >= 3 && (await bar.count()) === 0 && (await page.getByText("Avviso per il viewer").count()) === 0, adminItems.join());
  await page.locator("button.nav-tag").click();
  const group = page.locator('.nav-menu [role="group"][aria-label="Visualizza come ruolo"]');
  check("menu Admin: elenco dei ruoli da impersonare", JSON.stringify(await group.locator("button").allInnerTexts()) === JSON.stringify(["fss-etl-nuovo", "fss-etl-ops", "fss-etl-viewer"]));
  await group.locator('button:text-is("fss-etl-viewer")').click();

  // ============================================================ come viewer
  console.log("\n== come fss-etl-viewer ==");
  check("barra visibile con il ruolo", await waitFor(async () => /Stai vedendo l'applicazione come fss-etl-viewer/.test(await bar.innerText())));
  check("solo i layer del ruolo", await waitFor(async () => JSON.stringify(await items()) === JSON.stringify(["Particelle"])));
  check("strumenti del ruolo: niente misure", (await page.locator('button.tool[title="Misura distanza"]').count()) === 0 && (await page.locator('button.tool[title^="Interroga"]').count()) === 1);
  check("vista iniziale del ruolo (Roma) e layer accesi", await waitFor(async () => { const v = await view(); return near(v[0], 12.455, 0.03) && near(v[1], 41.875, 0.03); }) &&
    await waitFor(async () => JSON.stringify(await page.locator(".active-card .name").allInnerTexts()) === JSON.stringify(["Particelle"])));
  check("avvisi del ruolo", (await page.getByText("Avviso per il viewer").count()) === 1);
  check("menu Admin nascosto", (await page.locator("button.nav-tag").count()) === 0);
  await page.screenshot({ path: shot("viewas-viewer.png") });
  await page.locator('.nav a:has-text("Dashboard")').click();
  check("dashboard: solo quella del ruolo", await waitFor(async () => JSON.stringify(await page.locator(".card-link strong").allInnerTexts()) === JSON.stringify(["Per il viewer"])));
  await page.goto(F.url + "/admin/roles");
  check("ricaricando resta il ruolo; pagina admin spiegata", await waitFor(async () => /fss-etl-viewer/.test(await bar.innerText().catch(() => ""))) &&
    await waitFor(async () => /che non ha accesso a questa pagina/.test(await page.locator(".page").innerText())));

  // ============================================================ cambio ruolo
  console.log("\n== cambio ruolo ==");
  await page.goto(F.url + "/");
  await page.waitForSelector("label.item", { state: "attached" });
  await bar.locator('select[aria-label="Cambia ruolo"]').selectOption("fss-etl-ops");
  check("come ops: tutti i layer e le misure; niente avviso del viewer", await waitFor(async () => (await items()).length === adminItems.length) &&
    await waitFor(async () => (await page.locator('button.tool[title="Misura distanza"]').count()) === 1) && (await page.getByText("Avviso per il viewer").count()) === 0);
  await bar.locator('select[aria-label="Cambia ruolo"]').selectOption("fss-etl-nuovo");
  check("ruolo senza regole: spiegato, con la barra per uscire", await waitFor(async () => /Il ruolo fss-etl-nuovo non ha regole/.test(await page.locator(".page").innerText())) && (await bar.count()) === 1);

  // ============================================================ uscita
  console.log("\n== torna amministratore ==");
  await bar.locator('button:has-text("Torna amministratore")').click();
  check("di nuovo amministratore: tutti i layer, menu Admin, niente barra", await waitFor(async () => (await bar.count()) === 0 && (await page.locator("button.nav-tag").count()) === 1));
  await page.waitForSelector("label.item", { state: "attached", timeout: 15000 }); // la mappa ha finito di caricare: si può cambiare pagina
  await page.goto(F.url + "/admin/roles");
  await page.waitForSelector(".role-card[data-role]", { timeout: 15000 });
  await page.locator('.role-card[data-role="fss-etl-ops"] button:has-text("Visualizza come fss-etl-ops")').click();
  check("dalla pagina Ruoli: mappa come quel ruolo", await waitFor(async () => /come fss-etl-ops/.test(await bar.innerText().catch(() => ""))) && new URL(page.url()).pathname === "/");
  await bar.locator('button:has-text("Torna amministratore")').click();
  check("uscita ricordata dopo il ricaricamento", await (async () => { await page.reload(); await page.waitForSelector(".header"); return waitFor(async () => (await page.locator("button.nav-tag").count()) === 1 && (await bar.count()) === 0); })());

  // ============================================================ chi non è admin
  console.log("\n== utente normale ==");
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await asRole("fss-etl-viewer", "bob");
  await p2.goto(F.url + "/");
  await p2.waitForSelector("label.item", { state: "attached", timeout: 15000 });
  await p2.evaluate(() => sessionStorage.setItem("gema.viewAs", "fss-etl-ops"));
  await p2.reload();
  await p2.waitForSelector("label.item", { state: "attached", timeout: 15000 });
  check("un visualizzatore non può impersonare (valore nello storage ignorato)", (await p2.locator('[aria-label="Visualizza come ruolo"]').count()) === 0 && (await p2.locator("label.item").count()) === 1);
  await ctx2.close();

  check("nessun errore JS/console durante i test", errors.length === 0, errors.slice(0, 5).join(" | "));
  await browser.close();
  finish();
})().catch(crash);
