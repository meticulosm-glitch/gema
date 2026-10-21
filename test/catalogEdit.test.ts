import { describe, expect, it } from "vitest";
import type { Product } from "../src/capabilities";
import { OTHERS, OTHERS_TITLE, type Catalog, type CatalogFolder, type CatalogLayer } from "../src/catalog";
import {
  addFolder, canMoveInto, childrenOf, descendants, diffCatalog, diffSize, editableCatalog, moveBy, moveTargets, moveTo, parentOf, patchFolder,
  patchLayer, refId, removeFolder, rowsToSave, sameCatalog, validate, type Ref,
} from "../src/catalogEdit";

const P = (name: string, title: string): Product => ({ name, title, workspace: name.split(":")[0] });
const PRODUCTS = [P("iride:ndvi", "NDVI"), P("iride:parcels", "Particelle"), P("demo:roads", "Strade"), P("iride:sensors", "Sensori")];
const F = (key: string, position: number, extra: Partial<CatalogFolder> = {}): CatalogFolder => ({ key, parent: "", title: key, description: "", position, expanded: false, hidden: false, ...extra });
const L = (layer: string, folder: string, position: number, extra: Partial<CatalogLayer> = {}): CatalogLayer => ({ layer, folder, position, title: "", description: "", hidden: false, defaultOn: false, ...extra });
const fr = (key: string): Ref => ({ kind: "folder", key });
const lr = (name: string): Ref => ({ kind: "layer", name });
const ids = (c: Catalog, parent: string) => childrenOf(c, parent).map(refId);

describe("editableCatalog", () => {
  it("catalogo mai salvato: una cartella per workspace (com'è l'elenco oggi) più 'Altri prodotti'", () => {
    const { cat, stale } = editableCatalog(PRODUCTS, { folders: [], layers: [] });
    expect(ids(cat, "")).toEqual(["f:ws-demo", "f:ws-iride", `f:${OTHERS}`]);
    expect(ids(cat, "ws-iride")).toEqual(["l:iride:ndvi", "l:iride:parcels", "l:iride:sensors"]);
    expect(cat.folders.find((f) => f.key === OTHERS)?.title).toBe(OTHERS_TITLE);
    expect(stale).toEqual([]);
    expect(cat.layers.every((l) => !l.fid)).toBe(true);
  });

  it("un solo workspace: la cartella è aperta all'avvio", () => {
    const { cat } = editableCatalog([P("iride:ndvi", "NDVI")], { folders: [], layers: [] });
    expect(cat.folders.find((f) => f.key === "ws-iride")?.expanded).toBe(true);
  });

  it("catalogo salvato: posizioni invariate (aprire l'editor non crea modifiche); i nuovi in fondo ad 'Altri prodotti'", () => {
    const saved: Catalog = {
      folders: [F("agri", 4, { fid: "cf.1" }), F(OTHERS, 9, { fid: "cf.2", title: "Nuovi" })],
      layers: [L("iride:ndvi", "agri", 3, { fid: "cl.1" }), L("iride:parcels", "agri", 7, { fid: "cl.2" }), L("iride:sensors", OTHERS, 5, { fid: "cl.3" })],
    };
    const s = editableCatalog(PRODUCTS, saved);
    expect(s.cat.folders).toEqual(saved.folders);
    expect(s.cat.layers.filter((l) => l.fid)).toEqual(saved.layers);
    expect(s.cat.layers.find((l) => l.layer === "demo:roads")).toEqual(L("demo:roads", OTHERS, 6));
    expect(ids(s.cat, OTHERS)).toEqual(["l:iride:sensors", "l:demo:roads"]);
    const d = diffCatalog(saved, rowsToSave(s));
    expect(diffSize(d)).toBe(1);
    expect(d.layers.insert.map((l) => l.layer)).toEqual(["demo:roads"]);
  });

  it("righe di layer non più pubblicati: a parte, e salvate di nuovo finché l'admin non le rimuove", () => {
    const saved: Catalog = { folders: [F("agri", 0, { fid: "cf.1" })], layers: [...PRODUCTS.map((p, i) => L(p.name, "agri", i, { fid: `cl.${i}` })), L("iride:gone", "agri", 9, { fid: "cl.9" })] };
    const s = editableCatalog(PRODUCTS, saved);
    expect(s.stale.map((l) => l.layer)).toEqual(["iride:gone"]);
    expect(s.cat.layers.some((l) => l.layer === "iride:gone")).toBe(false);
    expect(diffSize(diffCatalog(saved, rowsToSave(s)))).toBe(1); // solo l'inserimento di "Altri prodotti"
    const removed = diffCatalog(saved, rowsToSave({ ...s, stale: [] }));
    expect(removed.layers.remove).toEqual(["cl.9"]);
  });

  it("cartelle in un ciclo o con genitore mancante: riparate al primo livello (è una modifica da salvare)", () => {
    const saved: Catalog = { folders: [F("x", 0, { fid: "a", parent: "y" }), F("y", 1, { fid: "b", parent: "x" })], layers: [L("iride:ndvi", "x", 0, { fid: "c" })] };
    const s = editableCatalog(PRODUCTS, saved);
    expect(s.cat.folders.find((f) => f.key === "x")?.parent).toBe("");
    expect(diffCatalog(saved, rowsToSave(s)).folders.update.map((u) => u.changed)).toContainEqual(["parent"]);
  });
});

describe("spostamenti", () => {
  const base: Catalog = {
    folders: [F("a", 0), F("b", 1), F("a1", 1, { parent: "a" }), F(OTHERS, 2)],
    layers: [L("iride:ndvi", "a", 0), L("iride:parcels", "a1", 0), L("demo:roads", "b", 0), L("iride:sensors", OTHERS, 0)],
  };

  it("childrenOf / parentOf / descendants", () => {
    expect(ids(base, "")).toEqual(["f:a", "f:b", `f:${OTHERS}`]);
    expect(ids(base, "a")).toEqual(["l:iride:ndvi", "f:a1"]);
    expect(parentOf(base, lr("iride:parcels"))).toBe("a1");
    expect(parentOf(base, fr("a1"))).toBe("a");
    expect([...descendants(base, "a")].sort()).toEqual(["a", "a1"]);
  });

  it("moveBy: su e giù nella stessa cartella; ai bordi non cambia nulla", () => {
    const up = moveBy(base, fr("b"), -1);
    expect(ids(up, "")).toEqual(["f:b", "f:a", `f:${OTHERS}`]);
    expect(up.folders.map((f) => [f.key, f.position])).toContainEqual(["b", 0]);
    expect(moveBy(base, fr("a"), -1)).toBe(base);
    expect(moveBy(base, fr(OTHERS), 1)).toBe(base);
    expect(ids(moveBy(base, lr("iride:ndvi"), 1), "a")).toEqual(["f:a1", "l:iride:ndvi"]);
  });

  it("moveTo: in un'altra cartella in fondo o prima di un elemento; la cartella di partenza viene rinumerata", () => {
    const m = moveTo(base, lr("iride:ndvi"), "b");
    expect(ids(m, "b")).toEqual(["l:demo:roads", "l:iride:ndvi"]);
    expect(ids(m, "a")).toEqual(["f:a1"]);
    expect(m.folders.find((f) => f.key === "a1")?.position).toBe(0);
    const before = moveTo(base, lr("iride:sensors"), "b", lr("demo:roads"));
    expect(ids(before, "b")).toEqual(["l:iride:sensors", "l:demo:roads"]);
    const same = moveTo(base, fr("b"), "", fr("a"));
    expect(ids(same, "")).toEqual(["f:b", "f:a", `f:${OTHERS}`]);
  });

  it("vietati: cartella dentro sé o una sua sottocartella, 'Altri prodotti' annidata, cartelle dentro 'Altri prodotti'", () => {
    expect(canMoveInto(base, fr("a"), "a1")).toBe(false);
    expect(canMoveInto(base, fr("a"), "a")).toBe(false);
    expect(canMoveInto(base, fr(OTHERS), "a")).toBe(false);
    expect(canMoveInto(base, fr("b"), OTHERS)).toBe(false);
    expect(canMoveInto(base, lr("iride:ndvi"), OTHERS)).toBe(true);
    expect(canMoveInto(base, lr("iride:ndvi"), "inesistente")).toBe(false);
    expect(moveTo(base, fr("a"), "a1")).toBe(base);
    expect(moveTo(base, lr("iride:ndvi"), "a", lr("iride:ndvi"))).toBe(base);
  });

  it("moveTargets: destinazioni valide con il percorso, primo livello in testa", () => {
    expect(moveTargets(base, fr("a")).map((t) => t.label)).toEqual(["(primo livello)", "b"]);
    const t = moveTargets(base, lr("iride:ndvi"));
    expect(t[0]).toEqual({ key: "", label: "(primo livello)" });
    expect(t.map((x) => x.key).sort()).toEqual(["", OTHERS, "a", "a1", "b"].sort());
    expect(moveTargets(base, lr("iride:ndvi")).find((t) => t.key === "a1")?.label).toBe("a / a1");
  });
});

describe("cartelle", () => {
  const base: Catalog = { folders: [F("a", 0), F("b", 1)], layers: [L("iride:ndvi", "a", 0), L("demo:roads", "", 2)] };

  it("addFolder: in fondo alla cartella, chiave dal titolo (senza accenti), univoca", () => {
    const r1 = addFolder(base, "Qualità dell'aria");
    expect(r1.key).toBe("f-qualita-dell-aria");
    expect(ids(r1.cat, "").at(-1)).toBe("f:f-qualita-dell-aria");
    const r2 = addFolder(r1.cat, "Qualità dell'aria", "a");
    expect(r2.key).toBe("f-qualita-dell-aria-2");
    expect(parentOf(r2.cat, fr(r2.key))).toBe("a");
    expect(addFolder(base, "   ").cat.folders.at(-1)?.title).toBe("Nuova cartella");
    expect(addFolder(base, "x", OTHERS).cat.folders.at(-1)?.parent).toBe("");
  });

  it("addFolder: va davvero in fondo anche se le posizioni hanno buchi (righe di layer non più pubblicati)", () => {
    const c: Catalog = { folders: [F("f", 0)], layers: [L("iride:ndvi", "f", 0), L("demo:roads", "f", 2)] }; // la posizione 1 era di un layer dismesso
    const r = addFolder(c, "Sotto", "f");
    expect(ids(r.cat, "f")).toEqual(["l:iride:ndvi", "l:demo:roads", "f:f-sotto"]);
  });

  it("removeFolder: il contenuto sale nella cartella che la conteneva, nello stesso punto", () => {
    const c: Catalog = { folders: [F("a", 0), F("b", 1), F("c", 2)], layers: [L("iride:ndvi", "b", 0), L("demo:roads", "b", 1)] };
    const r = removeFolder(c, "b");
    expect(ids(r, "")).toEqual(["f:a", "l:iride:ndvi", "l:demo:roads", "f:c"]);
    expect(r.folders.some((f) => f.key === "b")).toBe(false);
    expect(removeFolder(c, "manca")).toBe(c);
    const o: Catalog = { folders: [F(OTHERS, 0)], layers: [] };
    expect(removeFolder(o, OTHERS)).toBe(o);
  });

  it("patchFolder / patchLayer: nascosto e acceso di default si escludono", () => {
    expect(patchFolder(base, "a", { title: "Nuovo", hidden: true }).folders[0]).toMatchObject({ title: "Nuovo", hidden: true });
    const on = patchLayer(base, "iride:ndvi", { defaultOn: true });
    expect(on.layers[0]).toMatchObject({ defaultOn: true, hidden: false });
    const hid = patchLayer(on, "iride:ndvi", { hidden: true });
    expect(hid.layers[0]).toMatchObject({ defaultOn: false, hidden: true });
    expect(patchLayer(hid, "iride:ndvi", { defaultOn: true }).layers[0]).toMatchObject({ defaultOn: true, hidden: false });
    expect(patchLayer(hid, "iride:ndvi", { title: "T" }).layers[0]).toMatchObject({ hidden: true, title: "T" });
  });

  it("validate: titolo obbligatorio e chiavi univoche", () => {
    expect(validate(base)).toEqual([]);
    expect(validate(patchFolder(base, "a", { title: "  " }))).toEqual(["Una cartella non ha il titolo."]);
    expect(validate({ ...base, folders: [F("a", 0), F("a", 1)] })).toEqual(["Due cartelle hanno la stessa chiave."]);
  });
});

describe("diffCatalog / sameCatalog", () => {
  const saved: Catalog = {
    folders: [F("a", 0, { fid: "cf.1" }), F("b", 1, { fid: "cf.2" })],
    layers: [L("iride:ndvi", "a", 0, { fid: "cl.1" }), L("demo:roads", "b", 0, { fid: "cl.2" })],
  };

  it("inserimenti (senza fid), modifiche con i soli campi cambiati, eliminazioni", () => {
    let next = patchLayer(saved, "iride:ndvi", { title: "Vegetazione", defaultOn: true });
    next = removeFolder(next, "b");
    next = { ...next, layers: [...next.layers, L("iride:parcels", "a", 1)] };
    const d = diffCatalog(saved, next);
    expect(d.folders.remove).toEqual(["cf.2"]);
    expect(d.folders.insert).toEqual([]);
    expect(d.layers.insert.map((l) => l.layer)).toEqual(["iride:parcels"]);
    expect(d.layers.update).toEqual([
      { fid: "cl.1", row: expect.objectContaining({ title: "Vegetazione" }), changed: ["title", "defaultOn"] },
      { fid: "cl.2", row: expect.objectContaining({ folder: "", position: 1 }), changed: ["folder", "position"] },
    ]);
    expect(diffSize(d)).toBe(4);
    expect(diffSize(diffCatalog(saved, saved))).toBe(0);
  });

  it("sameCatalog: stesso contenuto in qualsiasi ordine; diverso se cambia un campo o un fid", () => {
    expect(sameCatalog(saved, { folders: [...saved.folders].reverse(), layers: [...saved.layers].reverse() })).toBe(true);
    expect(sameCatalog(saved, patchFolder(saved, "a", { expanded: true }))).toBe(false);
    expect(sameCatalog(saved, { ...saved, layers: [saved.layers[0], { ...saved.layers[1], fid: "cl.99" }] })).toBe(false);
    expect(sameCatalog(saved, { ...saved, layers: [saved.layers[0]] })).toBe(false);
  });
});
