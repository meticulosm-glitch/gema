// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { CatalogConflictError, isConfigLayer, loadCatalog, saveCatalog } from "../src/configStore";
import type { Catalog, CatalogFolder, CatalogLayer } from "../src/catalog";
import { ACC, el, fakeKc, mockFetch, XSD } from "./support";

const T = { ...ACC, workspace: "cfg" };
const NS = "http://x/cfg";
const FOLDERS_XSD = XSD("catalog_folders", ["folder_key", "parent_key", "title", "description"].map((n) => el(n, "xsd:string")).join("") + el("position", "xsd:int") + el("expanded", "xsd:boolean") + el("hidden", "xsd:boolean"), NS);
const LAYERS_XSD = XSD("catalog_layers", ["layer", "folder_key", "title", "description"].map((n) => el(n, "xsd:string")).join("") + el("position", "xsd:int") + el("hidden", "xsd:boolean") + el("default_on", "xsd:boolean"), NS);
const fc = (rows: { id: string; p: Record<string, unknown> }[]) => JSON.stringify({ type: "FeatureCollection", features: rows.map((r) => ({ type: "Feature", id: r.id, geometry: null, properties: r.p })) });
const F = (key: string, position: number, extra: Partial<CatalogFolder> = {}): CatalogFolder => ({ key, parent: "", title: key, description: "", position, expanded: false, hidden: false, ...extra });
const L = (layer: string, folder: string, position: number, extra: Partial<CatalogLayer> = {}): CatalogLayer => ({ layer, folder, position, title: "", description: "", hidden: false, defaultOn: false, ...extra });

const SAVED: Catalog = {
  folders: [F("agri", 0, { fid: "catalog_folders.1", title: "Agricoltura", expanded: true }), F("old", 1, { fid: "catalog_folders.2" })],
  layers: [L("iride:ndvi", "agri", 0, { fid: "catalog_layers.1", defaultOn: true }), L("demo:roads", "old", 0, { fid: "catalog_layers.2" })],
};
/** Risposte WFS che corrispondono a SAVED (GeoServer restituisce booleani e interi tipizzati). */
const savedRows = (url: string) =>
  url.includes("catalog_folders")
    ? fc([{ id: "catalog_folders.1", p: { folder_key: "agri", parent_key: "", title: "Agricoltura", description: "", position: 0, expanded: true, hidden: false } }, { id: "catalog_folders.2", p: { folder_key: "old", parent_key: "", title: "old", description: "", position: 1, expanded: false, hidden: false } }])
    : fc([{ id: "catalog_layers.1", p: { layer: "iride:ndvi", folder_key: "agri", position: 0, title: "", description: "", hidden: false, default_on: true } }, { id: "catalog_layers.2", p: { layer: "demo:roads", folder_key: "old", position: 0, title: null, description: null, hidden: false, default_on: false } }]);

describe("isConfigLayer", () => {
  it("anche le tabelle del catalogo restano fuori dalla mappa", () => {
    expect(isConfigLayer(T, "cfg:catalog_folders")).toBe(true);
    expect(isConfigLayer(T, "cfg:catalog_layers")).toBe(true);
    expect(isConfigLayer(T, "iride:catalog_layers")).toBe(false);
  });
});

describe("loadCatalog", () => {
  it("legge le due tabelle del workspace di configurazione e normalizza tipi e valori mancanti", async () => {
    const f = mockFetch((url) => ({
      type: "application/json",
      body: url.includes("catalog_folders")
        ? fc([{ id: "catalog_folders.1", p: { folder_key: "a", parent_key: null, title: "A", description: null, position: "3", expanded: "true", hidden: "t" } }, { id: "catalog_folders.2", p: { folder_key: "", title: "senza chiave" } }])
        : fc([{ id: "catalog_layers.1", p: { layer: "iride:ndvi", folder_key: "a", position: 2.7, title: "N", description: "D", hidden: 0, default_on: 1 } }, { id: "catalog_layers.2", p: { layer: null } }]),
    }));
    const c = await loadCatalog("/geoserver", fakeKc(), T);
    const urls = f.mock.calls.map((x) => String(x[0]));
    expect(urls.some((u) => u.includes("typeName=cfg%3Acatalog_folders"))).toBe(true);
    expect(urls.some((u) => u.includes("typeName=cfg%3Acatalog_layers"))).toBe(true);
    expect(c).toEqual({
      folders: [{ fid: "catalog_folders.1", key: "a", parent: "", title: "A", description: "", position: 3, expanded: true, hidden: true }],
      layers: [{ fid: "catalog_layers.1", layer: "iride:ndvi", folder: "a", position: 2, title: "N", description: "D", hidden: false, defaultOn: true }],
    });
  });

  it("tabella non pubblicata: l'errore di GeoServer arriva al chiamante (che la tratta come catalogo vuoto)", async () => {
    mockFetch(() => ({ status: 400, body: `<ServiceExceptionReport><ServiceException>Feature type cfg:catalog_layers unknown</ServiceException></ServiceExceptionReport>` }));
    await expect(loadCatalog("/geoserver", null, T)).rejects.toThrow(/unknown/);
  });
});

describe("saveCatalog", () => {
  const routes = (calls: { url: string; body: string }[], current = savedRows, response = "<wfs:WFS_TransactionResponse><wfs:SUCCESS/></wfs:WFS_TransactionResponse>") =>
    mockFetch((url, init) => {
      if (init?.method === "POST") { calls.push({ url, body: String(init.body) }); return { body: response }; }
      if (url.includes("DescribeFeatureType")) return { body: url.includes("catalog_folders") ? FOLDERS_XSD : LAYERS_XSD };
      return { type: "application/json", body: current(url) };
    });

  it("nessuna modifica: nessuna richiesta", async () => {
    const f = mockFetch(() => ({ body: "" }));
    expect(await saveCatalog("/geoserver", null, T, SAVED, SAVED)).toBe(0);
    expect(f).not.toHaveBeenCalled();
  });

  it("una sola transazione: prima le eliminazioni, poi le modifiche (solo i campi cambiati), poi gli inserimenti", async () => {
    const calls: { url: string; body: string }[] = [];
    routes(calls);
    const next: Catalog = {
      folders: [{ ...SAVED.folders[0], title: "Agricoltura & foreste" }, F("nuova", 1, { title: "Nuova <cartella>", hidden: true })],
      layers: [{ ...SAVED.layers[0], defaultOn: false, hidden: true }, { ...SAVED.layers[1], folder: "nuova" }, L("iride:parcels", "agri", 1, { title: "Particelle \"catastali\"" })],
    };
    const n = await saveCatalog("/geoserver", fakeKc({ preferred_username: "ada" }), T, SAVED, next);
    expect(n).toBe(6); // 1 cartella eliminata, 1 cartella e 2 layer modificati, 1 cartella e 1 layer inseriti
    expect(calls).toHaveLength(1);
    const b = calls[0].body;
    expect(calls[0].url).toBe("/geoserver/wfs");
    expect(b).toContain(`xmlns:cfg="${NS}"`);
    // eliminazione firmata: prima il timbro di chi elimina (per il registro modifiche), poi la Delete
    expect(b).toMatch(/<wfs:Update typeName="cfg:catalog_folders"><wfs:Property><wfs:Name>updated_by<\/wfs:Name><wfs:Value>ada<\/wfs:Value><\/wfs:Property><wfs:Property><wfs:Name>updated_at<\/wfs:Name><wfs:Value>[^<]+<\/wfs:Value><\/wfs:Property><ogc:Filter><ogc:FeatureId fid="catalog_folders.2"\/><\/ogc:Filter><\/wfs:Update><wfs:Delete typeName="cfg:catalog_folders">/);
    const signed = b;
    {
      const b = signed.replace(/<wfs:Update(?:(?!<\/wfs:Update>)[\s\S])*<\/wfs:Update>(?=<wfs:Delete)/g, "");
    const order = ["<wfs:Delete", "<wfs:Update typeName=\"cfg:catalog_folders\"", "<wfs:Update typeName=\"cfg:catalog_layers\"", "<wfs:Insert><cfg:catalog_folders>", "<wfs:Insert><cfg:catalog_layers>"].map((x) => b.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(b).toContain(`<wfs:Delete typeName="cfg:catalog_folders"><ogc:Filter><ogc:FeatureId fid="catalog_folders.2"/></ogc:Filter></wfs:Delete>`);
    // update della cartella: solo il titolo (con escape) più chi e quando
    const upd = b.slice(b.indexOf(`<wfs:Update typeName="cfg:catalog_folders"`), b.indexOf("</wfs:Update>") + 13);
    expect(upd).toContain("<wfs:Name>title</wfs:Name><wfs:Value>Agricoltura &amp; foreste</wfs:Value>");
    expect(upd).not.toContain("<wfs:Name>position</wfs:Name>");
    expect(upd).toContain("<wfs:Name>updated_by</wfs:Name><wfs:Value>ada</wfs:Value>");
    expect(b).toContain("<wfs:Name>hidden</wfs:Name><wfs:Value>true</wfs:Value>");
    expect(b).toContain("<wfs:Name>default_on</wfs:Name><wfs:Value>false</wfs:Value>");
    expect(b).toContain("<cfg:folder_key>nuova</cfg:folder_key><cfg:parent_key></cfg:parent_key><cfg:title>Nuova &lt;cartella&gt;</cfg:title>");
    expect(b).toContain("<cfg:hidden>true</cfg:hidden>");
    expect(b).toContain("<cfg:layer>iride:parcels</cfg:layer><cfg:folder_key>agri</cfg:folder_key><cfg:position>1</cfg:position><cfg:title>Particelle &quot;catastali&quot;</cfg:title>");
    expect(b).toMatch(/<cfg:updated_at>\d{4}-\d\d-\d\dT[^<]+<\/cfg:updated_at><\/cfg:catalog_layers>/);
    }
  });

  it("catalogo cambiato nel frattempo da un altro admin: CatalogConflictError e nessuna scrittura", async () => {
    const calls: { url: string; body: string }[] = [];
    routes(calls, (url) => savedRows(url).replace('"title":"Agricoltura"', '"title":"Rinominata da altri"'));
    const next = { ...SAVED, layers: [{ ...SAVED.layers[0], title: "x" }, SAVED.layers[1]] };
    await expect(saveCatalog("/geoserver", null, T, SAVED, next)).rejects.toBeInstanceOf(CatalogConflictError);
    expect(calls).toHaveLength(0);
  });

  it("GeoServer rifiuta la transazione (vincolo violato): l'errore arriva con il messaggio del database", async () => {
    const calls: { url: string; body: string }[] = [];
    routes(calls, savedRows, `<wfs:WFS_TransactionResponse><wfs:TransactionResult><wfs:Status><wfs:FAILED/></wfs:Status><wfs:Message>duplicate key value violates unique constraint "catalog_layers_layer_key"</wfs:Message></wfs:TransactionResult></wfs:WFS_TransactionResponse>`);
    const next = { ...SAVED, layers: [...SAVED.layers, L("iride:ndvi", "", 5)] };
    await expect(saveCatalog("/geoserver", null, T, SAVED, next)).rejects.toThrow(/duplicate key/);
    expect(calls).toHaveLength(1);
  });

  it("scrittura negata dal proxy (403): messaggio comprensibile", async () => {
    mockFetch((url, init) => (init?.method === "POST" ? { status: 403, body: "forbidden" } : url.includes("DescribeFeatureType") ? { body: url.includes("catalog_folders") ? FOLDERS_XSD : LAYERS_XSD } : { type: "application/json", body: savedRows(url) }));
    await expect(saveCatalog("/geoserver", null, T, SAVED, { ...SAVED, folders: [SAVED.folders[0]] })).rejects.toThrow(/scrittura negata/);
  });
});
