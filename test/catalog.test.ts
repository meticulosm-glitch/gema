import { describe, expect, it } from "vitest";
import type { Product } from "../src/capabilities";
import {
  EMPTY_CATALOG, OTHERS, OTHERS_TITLE, applyCatalog, buildTree, countLayers, defaultOnLayers, filterTree, flattenLayers, folderPath, isEmptyCatalog,
  type Catalog, type CatalogFolder, type CatalogLayer, type CatalogNode,
} from "../src/catalog";

const P = (name: string, title: string, abstract?: string): Product => ({ name, title, workspace: name.split(":")[0], ...(abstract ? { abstract } : {}) });
const PRODUCTS = [P("iride:ndvi", "NDVI", "Indice di vegetazione"), P("iride:parcels", "Particelle"), P("iride:sensors", "Sensori"), P("demo:roads", "Strade")];
const F = (key: string, position: number, extra: Partial<CatalogFolder> = {}): CatalogFolder => ({ key, parent: "", title: key.toUpperCase(), description: "", position, expanded: false, hidden: false, ...extra });
const L = (layer: string, folder: string, position: number, extra: Partial<CatalogLayer> = {}): CatalogLayer => ({ layer, folder, position, title: "", description: "", hidden: false, defaultOn: false, ...extra });

/** Albero in forma compatta: "F:titolo[...]" e "L:nome". */
const shape = (nodes: CatalogNode[]): string[] => nodes.map((n) => (n.kind === "layer" ? `L:${n.name}${n.hidden ? "(h)" : ""}` : `F:${n.title}${n.hidden ? "(h)" : ""}[${shape(n.children).join(",")}]`));

describe("applyCatalog", () => {
  it("titolo e descrizione del catalogo sostituiscono quelli di GeoServer; vuoti o solo spazi no", () => {
    const cat: Catalog = { folders: [], layers: [L("iride:ndvi", "", 0, { title: " Vegetazione ", description: "Dal catalogo" }), L("iride:parcels", "", 1, { title: "  " })] };
    const out = applyCatalog(PRODUCTS, cat);
    expect(out[0]).toMatchObject({ name: "iride:ndvi", title: "Vegetazione", abstract: "Dal catalogo" });
    expect(out[1]).toBe(PRODUCTS[1]); // nessuna modifica = stesso oggetto
    expect(out[3]).toBe(PRODUCTS[3]);
  });
  it("catalogo vuoto: prodotti invariati", () => {
    expect(applyCatalog(PRODUCTS, EMPTY_CATALOG)).toBe(PRODUCTS);
    expect(isEmptyCatalog(EMPTY_CATALOG)).toBe(true);
    expect(isEmptyCatalog({ folders: [F("a", 0)], layers: [] })).toBe(false);
  });
});

describe("buildTree", () => {
  const cat: Catalog = {
    folders: [F("agri", 1, { title: "Agricoltura", expanded: true }), F("sub", 1, { parent: "agri", title: "Approfondimenti" }), F("base", 0, { title: "Base" })],
    layers: [L("iride:parcels", "agri", 0), L("iride:ndvi", "agri", 2), L("demo:roads", "sub", 0), L("iride:sensors", "base", 0)],
  };

  it("cartelle annidate e layer nell'ordine di `position`, cartelle e layer mescolati", () => {
    expect(shape(buildTree(PRODUCTS, cat))).toEqual(["F:Base[L:iride:sensors]", "F:Agricoltura[L:iride:parcels,F:Approfondimenti[L:demo:roads],L:iride:ndvi]"]);
  });

  it("a parità di posizione: prima le cartelle, poi per titolo", () => {
    const c: Catalog = { folders: [F("z", 0, { title: "Zeta" })], layers: [L("iride:sensors", "", 0), L("iride:ndvi", "", 0), L("demo:roads", "z", 0), L("iride:parcels", "", 0)] };
    expect(shape(buildTree(PRODUCTS, c))).toEqual(["F:Zeta[L:demo:roads]", "L:iride:ndvi", "L:iride:parcels", "L:iride:sensors"]);
  });

  it("layer senza riga: in 'Altri prodotti' in fondo, per titolo; la cartella viene creata se manca", () => {
    const c: Catalog = { folders: [F("agri", 0)], layers: [L("iride:ndvi", "agri", 0)] };
    const tree = buildTree(PRODUCTS, c);
    expect(shape(tree)).toEqual(["F:AGRI[L:iride:ndvi]", `F:${OTHERS_TITLE}[L:iride:parcels,L:iride:sensors,L:demo:roads]`]);
    const others = tree[1] as Extract<CatalogNode, { kind: "folder" }>;
    expect(others.key).toBe(OTHERS);
    expect(others.own.fid).toBeUndefined();
  });

  it("'Altri prodotti' salvata: titolo e posizione dal catalogo, sempre al primo livello", () => {
    const c: Catalog = { folders: [F("agri", 1), F(OTHERS, 0, { title: "Nuovi", parent: "agri" })], layers: [L("iride:ndvi", "agri", 0)] };
    expect(shape(buildTree(PRODUCTS, c))).toEqual(["F:Nuovi[L:iride:parcels,L:iride:sensors,L:demo:roads]", "F:AGRI[L:iride:ndvi]"]);
  });

  it("cartelle vuote nascoste (salvo keepEmpty); righe di layer non pubblicati ignorate", () => {
    const c: Catalog = { folders: [F("vuota", 0), F("agri", 1)], layers: [L("iride:gone", "vuota", 0), ...PRODUCTS.map((p, i) => L(p.name, "agri", i))] };
    expect(shape(buildTree(PRODUCTS, c)).map((s) => s.split("[")[0])).toEqual(["F:AGRI"]);
    expect(shape(buildTree(PRODUCTS, c, { keepEmpty: true })).map((s) => s.split("[")[0])).toEqual(["F:VUOTA", "F:AGRI", `F:${OTHERS_TITLE}`]);
  });

  it("nascosti: spariscono (anche il contenuto di una cartella nascosta); con includeHidden restano marcati", () => {
    const c: Catalog = {
      folders: [F("a", 0, { hidden: true }), F("a2", 0, { parent: "a" }), F("b", 1)],
      layers: [L("iride:ndvi", "a2", 0, { defaultOn: true }), L("iride:parcels", "b", 0, { hidden: true }), L("iride:sensors", "b", 1), L("demo:roads", "b", 2, { defaultOn: true })],
    };
    expect(shape(buildTree(PRODUCTS, c))).toEqual(["F:B[L:iride:sensors,L:demo:roads]"]);
    const all = buildTree(PRODUCTS, c, { includeHidden: true });
    expect(shape(all)).toEqual(["F:A(h)[F:A2(h)[L:iride:ndvi(h)]]", "F:B[L:iride:parcels(h),L:iride:sensors,L:demo:roads]"]);
    // acceso di default ma dentro una cartella nascosta: non si accende
    expect(defaultOnLayers(all)).toEqual(["demo:roads"]);
  });

  it("cartella con genitore inesistente o in un ciclo: torna al primo livello (niente ricorsione infinita)", () => {
    const c: Catalog = {
      folders: [F("x", 0, { parent: "y" }), F("y", 1, { parent: "x" }), F("orfana", 2, { parent: "manca" })],
      layers: [L("iride:ndvi", "x", 0), L("iride:parcels", "y", 0), L("iride:sensors", "orfana", 0), L("demo:roads", "non-esiste", 3)],
    };
    const tree = buildTree(PRODUCTS, c);
    expect(shape(tree)).toEqual(["F:X[L:iride:ndvi]", "F:Y[L:iride:parcels]", "F:ORFANA[L:iride:sensors]", "L:demo:roads"]);
  });

  it("flattenLayers / countLayers / defaultOnLayers seguono l'ordine del catalogo", () => {
    const tree = buildTree(PRODUCTS, cat);
    expect(flattenLayers(tree).map((n) => n.name)).toEqual(["iride:sensors", "iride:parcels", "demo:roads", "iride:ndvi"]);
    expect(countLayers(tree)).toBe(4);
    const on = buildTree(PRODUCTS, { ...cat, layers: cat.layers.map((l) => ({ ...l, defaultOn: l.layer !== "iride:parcels" })) });
    expect(defaultOnLayers(on)).toEqual(["iride:sensors", "demo:roads", "iride:ndvi"]);
  });
});

describe("filterTree", () => {
  const cat: Catalog = { folders: [F("agri", 0, { title: "Agricoltura" }), F("sub", 0, { parent: "agri", title: "Strade e trasporti" })], layers: [L("iride:ndvi", "agri", 1), L("demo:roads", "sub", 0), L("iride:parcels", "", 1), L("iride:sensors", "", 2)] };
  const tree = buildTree(PRODUCTS, cat);
  it("tiene i layer che corrispondono per titolo, nome o descrizione, con le cartelle che li contengono", () => {
    expect(shape(filterTree(tree, "vegetazione"))).toEqual(["F:Agricoltura[L:iride:ndvi]"]);
    expect(shape(filterTree(tree, "PARCELS"))).toEqual(["L:iride:parcels"]);
  });
  it("una cartella che corrisponde porta con sé tutto il contenuto", () => {
    expect(shape(filterTree(tree, "trasporti"))).toEqual(["F:Agricoltura[F:Strade e trasporti[L:demo:roads]]"]);
  });
  it("vuoto = tutto; nessun risultato = albero vuoto", () => {
    expect(filterTree(tree, "  ")).toBe(tree);
    expect(filterTree(tree, "zzz")).toEqual([]);
  });
});

describe("folderPath", () => {
  it("percorso dei titoli dal primo livello; robusto ai cicli", () => {
    const c: Catalog = { folders: [F("a", 0, { title: "A" }), F("b", 0, { parent: "a", title: "B" }), F("x", 0, { parent: "y", title: "X" }), F("y", 0, { parent: "x", title: "Y" })], layers: [] };
    expect(folderPath(c, "b")).toBe("A / B");
    expect(folderPath(c, "")).toBe("");
    expect(folderPath(c, "x")).toBe("Y / X");
  });
});
