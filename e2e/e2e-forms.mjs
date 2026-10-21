// Moduli di modifica configurabili per layer: la pagina admin (etichette, ordine, obbligatori, sola lettura, nascosti,
// menu a tendina con i valori del layer, predefiniti, controlli) e l'editor della mappa che li applica.
import { J, MOCK, crash, launchBrowser, prepare, results, shot, startNginx, waitFor } from "./lib.mjs";

const { check, finish } = results();

const st = () => J("/__state");
const asRole = (roles, user = "bob") => J(`/__kc?user=${user}&roles=${encodeURIComponent(roles)}`);
const posts = async () => (await J("/__log")).filter((l) => l.method === "POST");
const hashFor = (v, l) => "#s=" + encodeURIComponent(JSON.stringify({ v, l }));
const merc = (lon, lat, z) => { const s = 512 * 2 ** z; return [((lon + 180) / 360) * s, (0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI)) * s]; };
const VIEW = [12.42, 41.8675, 12, 0, 0];

(async () => {
  prepare();
  await J("/__reset");
  const F = startNginx("F", 8090, {
    AUTH_ENABLED: "true", KEYCLOAK_URL: `${MOCK}/kc`, KEYCLOAK_REALM: "test", KEYCLOAK_CLIENT_ID: "mapp",
    ACCESS_CONTROL: "true", EDIT_ENABLED: "true", GEOSERVER_WRITE_PASSTHROUGH: "true",
    GEOSERVER_PROXY_URL: `${MOCK}/geoserver`, GEOSERVER_USER: "reader", GEOSERVER_PASSWORD: "rpass",
    BASEMAP_TILES: `${MOCK}/tiles/{z}/{x}/{y}.png`, APP_TITLE: "Test moduli", MAP_CENTER_LON: "12.5", MAP_CENTER_LAT: "41.9", MAP_ZOOM: "9", GEOCODER: "off",
  });
  const browser = await launchBrowser();
  const errors = [];
  const open = async (urlPath = "/", wait = ".header") => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
    page.on("dialog", (d) => d.accept());
    await page.goto(F.url + urlPath);
    await page.waitForSelector(wait, { timeout: 15000, state: "attached" });
    return page;
  };
  const cardOf = (page, field) => page.locator(`.form-field-card[data-field="${field}"]`);
  const inCard = (page, field, label) => cardOf(page, field).locator(`label:has(> span:text-is("${label}")) input`);
  const saveBtn = (page) => page.locator('button:has-text("Salva modulo")');
  const ed = (page) => page.locator(".float-panel.editor:not(.static)");
  const edField = (page, field) => ed(page).locator(`.ed-field[data-field="${field}"]`);

  // ============================================================ admin: configurazione del modulo
  console.log("\n== admin: modulo delle particelle ==");
  await asRole("fss-etl-admin", "alice");
  let page = await open("/admin/forms", ".dash-list");
  check("menu Admin: voce 'Moduli di modifica'", (await page.locator("button.nav-tag.on").innerText()).includes("Moduli di modifica"));
  check("elenco: solo layer vettoriali (niente NDVI raster né tabelle di configurazione)", await waitFor(async () => {
    const t = await page.locator(".dash-list .dash-item strong").allInnerTexts();
    return JSON.stringify(t.sort()) === JSON.stringify(["Particelle", "Sensori", "Strade"]);
  }));
  await page.locator('.dash-item[data-layer="iride:parcels"]').click();
  await page.waitForSelector(".form-field-card");
  check("un riquadro per colonna, nell'ordine dello schema", JSON.stringify(await page.locator(".form-field-card").evaluateAll((els) => els.map((e) => e.dataset.field))) === JSON.stringify(["name", "kind", "area", "surveyed"]));
  check("modulo non configurato: niente da salvare", await saveBtn(page).isDisabled());

  await inCard(page, "name", "Etichetta").fill("Nome particella");
  await cardOf(page, "name").locator('.check:has-text("Obbligatorio") input').check();
  await inCard(page, "name", "Aiuto").fill("Come da visura catastale");
  await inCard(page, "kind", "Etichetta").fill("Tipo");
  await cardOf(page, "kind").locator('button:has-text("Menu a tendina")').click();
  await cardOf(page, "kind").locator('button:has-text("Aggiungi i valori presenti nel layer")').click();
  const menu = cardOf(page, "kind").locator("textarea");
  check("valori presenti nel layer: A, B, C (distinti e ordinati)", await waitFor(async () => (await menu.inputValue()) === "A\nB\nC"));
  check("lettura dei valori: WFS GetFeature con la sola colonna", (await J("/__log")).some((l) => /GetFeature/i.test(l.query) && /propertyName=kind/i.test(decodeURIComponent(l.query))));
  await menu.fill("A|Agricola\nB|Boschiva\nC|Costruita");
  await inCard(page, "kind", "Valore predefinito (nuovi oggetti)").fill("Z");
  check("predefinito fuori dal menu: errore e salvataggio bloccato", await waitFor(async () => /Valore predefinito di «kind»/.test(await page.locator(".problems").innerText())) && (await saveBtn(page).isDisabled()));
  await inCard(page, "kind", "Valore predefinito (nuovi oggetti)").fill("B");
  await cardOf(page, "kind").getByRole("button", { name: "Sposta su kind" }).click();
  await cardOf(page, "area").locator('.check:has-text("Sola lettura") input').check();
  await cardOf(page, "area").locator('.check:has-text("Obbligatorio") input').check();
  check("obbligatorio + sola lettura senza predefinito: errore", /nessun nuovo oggetto si potrebbe salvare/.test(await page.locator(".problems").innerText()));
  await cardOf(page, "area").locator('.check:has-text("Obbligatorio") input').uncheck();
  await cardOf(page, "surveyed").locator('.check:has-text("Nascosto") input').check();
  await inCard(page, "surveyed", "Valore predefinito (nuovi oggetti)").fill("2026-05-01");
  const preview = page.locator(".forms-preview");
  check("anteprima: ordine ed etichette del modulo, campo nascosto assente", JSON.stringify(await preview.locator(".ed-field > span").allInnerTexts()) === JSON.stringify(["Tipo", "Nome particella", "area"]));
  check("anteprima: menu con le etichette e il predefinito scelto", JSON.stringify(await preview.locator('.ed-field[data-field="kind"] option').allInnerTexts()) === JSON.stringify(["", "Agricola", "Boschiva", "Costruita"]) &&
    (await preview.locator('.ed-field[data-field="kind"] select').inputValue()) === "B");
  check("anteprima: area in sola lettura, obbligatorio marcato", (await preview.locator('.ed-field[data-field="area"] input').isDisabled()) && (await preview.locator('.ed-field.req[data-field="name"]').count()) === 1);
  await page.screenshot({ path: shot("forms-admin.png"), fullPage: true });
  await saveBtn(page).click();
  check("salvataggio del modulo", await waitFor(async () => /Modulo salvato/.test(await page.locator(".page .ok").innerText())));
  const row = (await st())["mapp:edit_forms"].features[0]?.properties;
  const def = JSON.parse(row?.definition ?? "[]");
  check("tabella edit_forms: una riga per il layer, con ordine e regole", row?.layer === "iride:parcels" && row.updated_by === "alice" &&
    JSON.stringify(def.map((r) => r.name)) === JSON.stringify(["kind", "name", "area", "surveyed"]) &&
    def[0].alias === "Tipo" && def[0].default === "B" && def[0].options.length === 3 && def[0].options[1].label === "Boschiva" &&
    def[1].required === true && def[1].help === "Come da visura catastale" && def[2].readonly === true && def[3].hidden === true && def[3].default === "2026-05-01", row?.definition);
  check("nell'elenco il layer risulta configurato", /modulo configurato/.test(await page.locator('.dash-item[data-layer="iride:parcels"]').innerText()));
  await page.close();

  // ============================================================ editor nella mappa
  console.log("\n== editor ==");
  page = await open("/" + hashFor(VIEW, [["iride:parcels", 1, "", "", ""]]), ".active-card");
  await page.locator('.active-card [title="Tabella attributi"]').click();
  await page.locator('.table-dock [title="Modifica questo oggetto"]').first().click();
  await ed(page).locator(".ed-form").waitFor();
  check("editor: etichette e ordine del modulo, campo nascosto assente", await waitFor(async () => JSON.stringify(await ed(page).locator(".ed-field > span").allInnerTexts()) === JSON.stringify(["Tipo", "Nome particella", "area"])));
  check("editor: menu con il valore dell'oggetto, area non modificabile, aiuto visibile", (await edField(page, "kind").locator("select").inputValue()) === "A" &&
    (await edField(page, "area").locator("input").isDisabled()) && /Come da visura catastale/.test(await edField(page, "name").innerText()));
  const before = (await posts()).length;
  await edField(page, "name").locator("input").fill("");
  await ed(page).locator('button:text-is("Salva")').click();
  check("obbligatorio vuoto: errore sul campo e niente scrittura", await waitFor(async () => /Campo obbligatorio/.test(await edField(page, "name").innerText())) && (await posts()).length === before);
  check("obbligatorio vuoto: messaggio generale", /Controlla i campi evidenziati \(1\)/.test(await ed(page).locator(".error").innerText()));
  await edField(page, "name").locator("input").fill("Particella rinominata");
  check("correggere il campo toglie l'errore", (await edField(page, "name").locator(".ed-err").count()) === 0);
  await edField(page, "kind").locator("select").selectOption("C");
  await ed(page).locator('button:text-is("Salva")').click();
  check("modifica salvata", await waitFor(async () => /Modifiche salvate/.test(await ed(page).locator(".ok").innerText())));
  const upd = (await posts()).at(-1).body;
  check("WFS-T Update: solo i campi cambiati (né area né surveyed)", upd.includes("<wfs:Name>kind</wfs:Name><wfs:Value>C</wfs:Value>") && upd.includes("Particella rinominata") && !upd.includes("<wfs:Name>area</wfs:Name>") && !upd.includes("<wfs:Name>surveyed</wfs:Name>"));
  const p1 = (await st())["iride:parcels"].features[0].properties;
  check("oggetto aggiornato, valori nascosti e in sola lettura intatti", p1.kind === "C" && p1.name === "Particella rinominata" && p1.area === 100 && p1.surveyed === "2026-01-10", JSON.stringify(p1));

  // nuovo oggetto: predefiniti (anche del campo nascosto) e obbligatori
  await page.locator('.active-card [title="Modifica oggetti"]').click();
  await ed(page).locator('button:has-text("Poligono")').click();
  const box = await page.locator(".map-el").boundingBox();
  const [cx, cy] = merc(VIEW[0], VIEW[1], VIEW[2]);
  for (const [lon, lat] of [[12.405, 41.862], [12.43, 41.862], [12.43, 41.872], [12.405, 41.872]]) { // vicino al centro: sotto c'è la tabella aperta
    const [x, y] = merc(lon, lat, VIEW[2]);
    await page.mouse.click(box.x + box.width / 2 + (x - cx), box.y + box.height / 2 + (y - cy));
  }
  await ed(page).locator('button:has-text("Termina disegno")').click();
  check("nuovo oggetto: predefinito del menu già scelto", (await edField(page, "kind").locator("select").inputValue()) === "B");
  await ed(page).locator('button:text-is("Salva")').click();
  check("nuovo oggetto senza nome: bloccato", await waitFor(async () => /Campo obbligatorio/.test(await edField(page, "name").innerText())));
  await edField(page, "name").locator("input").fill("Nuova particella");
  await page.screenshot({ path: shot("forms-editor.png") });
  await ed(page).locator('button:text-is("Salva")').click();
  check("nuovo oggetto creato", await waitFor(async () => /Nuovo oggetto creato/.test(await ed(page).locator(".ok").innerText())));
  const nf = (await st())["iride:parcels"].features.at(-1).properties;
  check("WFS-T Insert: valori predefiniti, anche del campo nascosto", nf.name === "Nuova particella" && nf.kind === "B" && nf.surveyed === "2026-05-01" && nf.area === null, JSON.stringify(nf));
  await page.close();

  // un layer senza modulo resta com'era
  page = await open("/" + hashFor(VIEW, [["iride:sensors", 1, "", "", ""]]), ".active-card");
  await page.locator('.active-card [title="Tabella attributi"]').click();
  await page.locator('.table-dock [title="Modifica questo oggetto"]').first().click();
  check("layer senza modulo: campi predefiniti (nomi delle colonne, testo libero)", await waitFor(async () => JSON.stringify(await ed(page).locator(".ed-field > span").allInnerTexts()) === JSON.stringify(["code", "temp", "obs"])));
  await page.close();

  // ============================================================ ripristino e tabella mancante
  console.log("\n== ripristino e tabella mancante ==");
  page = await open("/admin/forms", ".dash-list");
  await page.locator('.dash-item[data-layer="iride:parcels"]').click();
  await page.waitForSelector('.form-field-card[data-field="kind"]');
  check("il modulo salvato si riapre com'era", (await inCard(page, "kind", "Etichetta").inputValue()) === "Tipo" && (await cardOf(page, "kind").locator("textarea").inputValue()) === "A|Agricola\nB|Boschiva\nC|Costruita");
  await page.locator('button:has-text("Ripristina predefinito")').click();
  check("ripristino: riga eliminata", await waitFor(async () => (await st())["mapp:edit_forms"].features.length === 0));
  await page.close();
  await J("/__tables?off=1&only=mapp:edit_forms");
  page = await open("/admin/forms", ".dash-list");
  check("tabella mancante: avviso", await waitFor(async () => /Tabella dei moduli non trovata/.test(await page.locator(".page").innerText())));
  await page.close();
  page = await open("/" + hashFor(VIEW, [["iride:parcels", 1, "", "", ""]]), ".active-card");
  await page.locator('.active-card [title="Tabella attributi"]').click();
  await page.locator('.table-dock [title="Modifica questo oggetto"]').first().click();
  check("tabella mancante: l'editor funziona con i campi predefiniti", await waitFor(async () => (await ed(page).locator(".ed-field").count()) === 4));
  await page.close();
  await J("/__tables?off=0");

  check("nessun errore JS/console durante i test", errors.filter((e) => !/modulo di modifica non disponibile/.test(e)).length === 0, errors.slice(0, 5).join(" | "));
  await browser.close();
  finish();
})().catch(crash);
