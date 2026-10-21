// Avvisi e manutenzione dalla UI: pagina admin (testo, tipo, periodo, ruoli, chiudibile, anteprima, controlli),
// banner in tutte le pagine per chi deve vederli, chiusura ricordata, aggiornamento senza ricaricare, tabella mancante.
import { J, MOCK, crash, goAdmin, launchBrowser, prepare, results, shot, startNginx, waitFor } from "./lib.mjs";

const { check, finish } = results();

const rows = async () => (await J("/__state"))["mapp:announcements"].features.map((f) => ({ fid: f.id, ...f.properties }));
const asRole = (roles, user = "bob") => J(`/__kc?user=${user}&roles=${encodeURIComponent(roles)}`);
const seed = (list) => fetch(`${MOCK}/__seed?layer=${encodeURIComponent("mapp:announcements")}`, { method: "POST", body: JSON.stringify(list) }).then((r) => r.json());

(async () => {
  prepare();
  await J("/__reset");
  const N = startNginx("N", 8089, {
    AUTH_ENABLED: "true", KEYCLOAK_URL: `${MOCK}/kc`, KEYCLOAK_REALM: "test", KEYCLOAK_CLIENT_ID: "mapp",
    ACCESS_CONTROL: "true", KNOWN_ROLES: "fss-etl-viewer, fss-etl-ops", GEOSERVER_WRITE_PASSTHROUGH: "true",
    GEOSERVER_PROXY_URL: `${MOCK}/geoserver`, GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass",
    BASEMAP_TILES: `${MOCK}/tiles/{z}/{x}/{y}.png`, APP_TITLE: "Test avvisi", MAP_CENTER_LON: "12.5", MAP_CENTER_LAT: "41.9", MAP_ZOOM: "9", GEOCODER: "off",
  });
  const browser = await launchBrowser();
  const errors = [];
  const open = async (urlPath = "/", { wait = ".header", ctx, clock = false } = {}) => {
    ctx ??= await browser.newContext({ viewport: { width: 1400, height: 900 }, timezoneId: "Europe/Rome" });
    const page = await ctx.newPage();
    if (clock) await page.clock.install();
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
    page.on("dialog", (d) => d.accept());
    await page.goto(N.url + urlPath);
    await page.waitForSelector(wait, { timeout: 15000, state: "attached" });
    return page;
  };
  const banners = (page) => page.locator(".header ~ .ann-bar .ann").evaluateAll((els) => els.map((e) => `${e.dataset.level}:${e.querySelector(".ann-text").textContent}`));
  /** Data e ora locali (Europe/Rome) per <input type="datetime-local">, spostate di `h` ore da adesso. */
  const local = (page, h) => page.evaluate((hh) => { const d = new Date(Date.now() + hh * 3600_000); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }, h);
  const editor = (page) => page.locator(".ann-editor");
  const field = (page, label) => editor(page).locator(`label:has(> span:text-is("${label}"))`).locator("input, textarea, select").first();

  // ============================================================ admin: creazione
  console.log("\n== admin: avvisi ==");
  await asRole("fss-etl-admin", "alice");
  let page = await open("/");
  await page.waitForSelector("button.nav-tag");
  await goAdmin(page, "Avvisi");
  check("pagina Avvisi dal menu Admin, vuota", await waitFor(async () => /Nessun avviso/.test(await page.locator(".page").innerText())));
  await page.locator('button:has-text("Nuovo avviso")').click();
  check("testo vuoto: errore e salvataggio bloccato", /Scrivi il testo/.test(await editor(page).innerText()) && (await page.locator('button:has-text("Salva avviso")').isDisabled()));
  await field(page, "Testo").fill("Nuova versione disponibile: note su https://example.org/note.");
  check("anteprima con il link cliccabile (senza il punto finale)", (await editor(page).locator(".ann a").getAttribute("href")) === "https://example.org/note");
  await page.locator('button:has-text("Salva avviso")').click();
  check("avviso salvato", await waitFor(async () => /Avviso salvato/.test(await page.locator(".page .ok").innerText())));
  check("l'avviso compare subito nel banner dell'admin", await waitFor(async () => (await banners(page)).some((b) => b.startsWith("info:Nuova versione"))));

  // manutenzione solo per il visualizzatore, in corso
  await page.locator('button:has-text("Nuovo avviso")').click();
  await field(page, "Testo").fill("Manutenzione in corso: salvataggi sospesi.");
  await field(page, "Tipo").selectOption("maintenance");
  check("manutenzione: 'chiudibile' disattivato", await editor(page).locator('.check:has-text("L\'utente lo può chiudere") input').isDisabled());
  await field(page, "Dal (vuoto = subito)").fill(await local(page, -1));
  await field(page, "Al (vuoto = finché non lo spegni)").fill(await local(page, -2));
  check("fine prima dell'inizio: errore", /La fine deve venire dopo l'inizio/.test(await editor(page).innerText()));
  await field(page, "Al (vuoto = finché non lo spegni)").fill(await local(page, 1));
  await editor(page).locator('.check:has-text("Tutti") input').uncheck();
  check("solo alcuni ruoli: elenco dei ruoli", (await editor(page).locator(".check-row .check").count()) >= 3);
  await editor(page).locator('.check:has-text("fss-etl-viewer") input').uncheck();
  check("nessun ruolo scelto: errore", /Scegli almeno un ruolo/.test(await editor(page).innerText()));
  await editor(page).locator('.check:has-text("fss-etl-viewer") input').check();
  await page.locator('button:has-text("Salva avviso")').click();
  await waitFor(async () => /Avviso salvato/.test(await page.locator(".page .ok").innerText()));
  // avviso programmato per domani
  await page.locator('button:has-text("Nuovo avviso")').click();
  await field(page, "Testo").fill("Domani nuova funzione.");
  await field(page, "Tipo").selectOption("warning");
  await field(page, "Dal (vuoto = subito)").fill(await local(page, 24));
  await page.locator('button:has-text("Salva avviso")').click();
  check("elenco: stato di ogni avviso (in corso, programmato)", await waitFor(async () => {
    const t = await page.locator(".ann-row > .tag:first-child").evaluateAll((els) => els.map((e) => e.textContent));
    return JSON.stringify(t) === JSON.stringify(["programmato", "in corso", "in corso"]);
  }));
  const R = await rows();
  const m = R.find((r) => r.level === "maintenance");
  check("tabella: tre avvisi; la manutenzione non è chiudibile, ha periodo e ruoli", R.length === 3 && m.dismissible === false && JSON.parse(m.roles).join() === "fss-etl-viewer" && /Z$/.test(m.starts_at) && /Z$/.test(m.ends_at) && m.updated_by === "alice", JSON.stringify(m));
  check("admin: non vede la manutenzione riservata al visualizzatore", !(await banners(page)).some((b) => b.startsWith("maintenance")));
  await page.screenshot({ path: shot("announce-admin.png"), fullPage: true });
  await page.close();

  // ============================================================ chi legge
  console.log("\n== visualizzatore ==");
  await asRole("fss-etl-viewer", "bob");
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, timezoneId: "Europe/Rome" });
  page = await open("/", { ctx, wait: ".sidebar" });
  check("mappa: manutenzione per prima, poi informazione; il programmato no", await waitFor(async () => JSON.stringify(await banners(page)) === JSON.stringify(["maintenance:Manutenzione in corso: salvataggi sospesi.", "info:Nuova versione disponibile: note su https://example.org/note."])));
  check("manutenzione: senza pulsante di chiusura, ruolo alert", (await page.locator('.ann[data-level="maintenance"] .ann-close').count()) === 0 && (await page.locator('.ann[data-level="maintenance"]').getAttribute("role")) === "alert");
  await page.screenshot({ path: shot("announce-viewer.png") });
  await page.locator('.ann[data-level="info"] .ann-close').click();
  check("chiusura: l'informazione sparisce", await waitFor(async () => (await banners(page)).length === 1));
  await page.reload();
  await page.waitForSelector(".sidebar");
  check("chiusura ricordata dopo il ricaricamento (la manutenzione resta)", await waitFor(async () => JSON.stringify((await banners(page)).map((b) => b.split(":")[0])) === JSON.stringify(["maintenance"])));
  await page.goto(N.url + "/dashboards");
  check("il banner c'è anche nelle altre pagine", await waitFor(async () => (await page.locator(".ann-bar .ann").count()) === 1));
  await page.close();

  await asRole("fss-etl-ops", "olga");
  await J("/__tables?off=0");
  // un ruolo senza regola vede "Accesso non configurato": anche lì gli avvisi per tutti si vedono
  page = await open("/", { wait: ".page" });
  check("ruolo diverso: solo l'avviso per tutti, anche nella pagina 'Accesso non configurato'", await waitFor(async () => JSON.stringify((await banners(page)).map((b) => b.split(":")[0])) === JSON.stringify(["info"])));
  await page.close();

  // ============================================================ modifica, spegnimento, arrivo senza ricaricare
  console.log("\n== aggiornamenti ==");
  await asRole("fss-etl-admin", "alice");
  page = await open("/admin/announcements", { wait: ".ann-list" });
  await page.locator('.ann-row:has-text("Nuova versione") button:has-text("Modifica")').click();
  await field(page, "Testo").fill("Nuova versione 2.0 disponibile.");
  await page.locator('button:has-text("Salva avviso")').click();
  await waitFor(async () => /Avviso salvato/.test(await page.locator(".page .ok").innerText()));
  await page.locator('.ann-row:has-text("Manutenzione") button:has-text("Spegni")').click();
  check("spegni: l'avviso risulta spento", await waitFor(async () => /spento/i.test(await page.locator('.ann-row:has-text("Manutenzione")').innerText())));
  await page.close();
  await asRole("fss-etl-viewer", "bob");
  page = await open("/dashboards", { ctx, wait: ".page", clock: true });
  check("avviso modificato: ricompare anche a chi aveva chiuso la versione precedente; manutenzione spenta sparita",
    await waitFor(async () => JSON.stringify(await banners(page)) === JSON.stringify(["info:Nuova versione 2.0 disponibile."])));
  await seed([{ message: "Arrivato senza ricaricare", level: "warning", starts_at: "", ends_at: "", roles: "[]", dismissible: "true", active: "true", updated_at: new Date().toISOString() }]);
  await page.clock.fastForward("05:05");
  check("nuovo avviso: arriva entro 5 minuti senza ricaricare la pagina", await waitFor(async () => (await banners(page)).some((b) => b === "warning:Arrivato senza ricaricare")));
  await page.close();
  await ctx.close();

  // ============================================================ eliminazione, accesso, tabella mancante
  console.log("\n== eliminazione e tabella mancante ==");
  page = await open("/admin/announcements");
  check("visualizzatore: pagina admin negata", await waitFor(async () => /Accesso negato/.test(await page.locator(".page").innerText())));
  await page.close();
  await asRole("fss-etl-admin", "alice");
  page = await open("/admin/announcements", { wait: ".ann-list" });
  await page.locator('.ann-row:has-text("Domani") button:has-text("Elimina")').click();
  check("eliminato", await waitFor(async () => !(await rows()).some((r) => /Domani/.test(r.message))));
  await page.close();
  await J("/__tables?off=1&only=mapp:announcements");
  page = await open("/admin/announcements", { wait: ".page-inner" });
  check("tabella mancante: avviso nella pagina e 'Nuovo avviso' disattivato", await waitFor(async () => /Tabella degli avvisi non trovata/.test(await page.locator(".page").innerText())) && (await page.locator('button:has-text("Nuovo avviso")').isDisabled()));
  await page.close();
  await asRole("fss-etl-viewer", "bob");
  page = await open("/", { wait: ".sidebar" });
  check("tabella mancante: la mappa si apre, senza banner", await waitFor(async () => (await page.locator("label.item").count()) > 0) && (await page.locator(".ann-bar").count()) === 0);
  await page.close();
  await J("/__tables?off=0");

  check("nessun errore JS/console durante i test", errors.length === 0, errors.slice(0, 5).join(" | "));
  await browser.close();
  finish();
})().catch(crash);
