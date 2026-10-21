// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { Product } from "../src/capabilities";
import { EMPTY_CATALOG, OTHERS, type Catalog } from "../src/catalog";
import { ACC, fakeKc } from "./support";

vi.mock("../src/configStore", async (orig) => ({ ...(await orig<typeof import("../src/configStore")>()), saveCatalog: vi.fn() }));
import * as store from "../src/configStore";
import AdminCatalog from "../src/AdminCatalog";

const P = (name: string, title: string, abstract?: string): Product => ({ name, title, workspace: name.split(":")[0], ...(abstract ? { abstract } : {}) });
const PRODUCTS = [P("iride:ndvi", "NDVI", "Indice di vegetazione"), P("iride:parcels", "Particelle"), P("demo:roads", "Strade")];
const SAVED: Catalog = {
  folders: [
    { fid: "cf.1", key: "agri", parent: "", title: "Agricoltura", description: "", position: 0, expanded: true, hidden: false },
    { fid: "cf.2", key: OTHERS, parent: "", title: "Altri prodotti", description: "", position: 1, expanded: false, hidden: false },
  ],
  layers: [
    { fid: "cl.1", layer: "iride:ndvi", folder: "agri", position: 0, title: "", description: "", hidden: false, defaultOn: true },
    { fid: "cl.2", layer: "iride:parcels", folder: "agri", position: 1, title: "Particelle catastali", description: "", hidden: false, defaultOn: false },
    { fid: "cl.3", layer: "iride:gone", folder: "agri", position: 2, title: "", description: "", hidden: false, defaultOn: false },
  ],
};

const setup = (catalog: Catalog = SAVED, catalogError: string | null = null) => {
  const onChanged = vi.fn(async () => {});
  const kc = fakeKc({ preferred_username: "ada" });
  const utils = render(<AdminCatalog gs="http://gs" kc={kc} acc={ACC} products={PRODUCTS} catalog={catalog} catalogError={catalogError} onChanged={onChanged} />);
  return { ...utils, onChanged, kc };
};
const rowOf = (container: HTMLElement, ref: string) => container.querySelector(`.cat-row[data-ref="${ref}"]`) as HTMLElement;
const titles = (container: HTMLElement) => Array.from(container.querySelectorAll(".cat-row .cat-title")).map((e) => e.firstChild?.textContent ?? "");
const saveBtn = () => screen.getByRole("button", { name: "Salva catalogo" });
const field = (label: string) => within(document.querySelector(".cat-form") as HTMLElement).getByText(label, { selector: "span" }).parentElement!.querySelector("input, textarea, select") as HTMLInputElement;

beforeEach(() => { vi.mocked(store.saveCatalog).mockReset(); });

describe("AdminCatalog", () => {
  it("albero dal catalogo salvato: titoli del catalogo, etichette, layer nuovi e non più pubblicati", () => {
    const { container } = setup();
    expect(titles(container)).toEqual(["Agricoltura", "NDVI", "Particelle catastali", "Altri prodotti", "Strade"]);
    expect(within(rowOf(container, "l:iride:ndvi")).getByText("acceso")).toBeInTheDocument();
    expect(within(rowOf(container, "l:iride:parcels")).getByText("titolo")).toBeInTheDocument();
    expect(within(rowOf(container, "l:demo:roads")).getByText("nuovo")).toBeInTheDocument();
    expect(screen.getByText(/1 layer pubblicato dopo l'ultimo salvataggio/)).toBeInTheDocument();
    expect(screen.getByText("iride:gone")).toBeInTheDocument();
    // l'unico cambiamento è la riga del layer nuovo
    expect(screen.getByText("1 modifica non salvata")).toBeInTheDocument();
  });

  it("modifica e salvataggio: passa a saveCatalog il catalogo letto e quello nuovo, poi ricarica", async () => {
    vi.mocked(store.saveCatalog).mockResolvedValue(3);
    const { container, onChanged, kc } = setup();
    fireEvent.click(rowOf(container, "l:iride:ndvi"));
    fireEvent.change(field("Titolo"), { target: { value: "Vegetazione" } });
    expect(field("Titolo").placeholder).toBe("NDVI");
    expect((field("Descrizione") as unknown as HTMLTextAreaElement).placeholder).toBe("Indice di vegetazione");
    fireEvent.click(screen.getByLabelText(/^Nascosto/));
    expect((screen.getByLabelText(/^Acceso di default/) as HTMLInputElement).checked).toBe(false);
    expect(titles(container)[1]).toBe("Vegetazione");
    expect(within(rowOf(container, "l:iride:ndvi")).getByText("nascosto")).toBeInTheDocument();
    await act(async () => { fireEvent.click(saveBtn()); });
    const [gs, k, acc, base, next] = vi.mocked(store.saveCatalog).mock.calls[0];
    expect([gs, k, acc, base]).toEqual(["http://gs", kc, ACC, SAVED]);
    expect(next.layers.find((l) => l.layer === "iride:ndvi")).toMatchObject({ title: "Vegetazione", hidden: true, defaultOn: false, fid: "cl.1" });
    expect(next.layers.find((l) => l.layer === "iride:gone")).toBeTruthy(); // le righe dei layer dismessi restano finché non si rimuovono
    expect(onChanged).toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Catalogo salvato (3 modifiche)");
  });

  it("frecce e menu Cartella spostano gli elementi; nuova cartella selezionata e rinominabile", () => {
    const { container } = setup();
    fireEvent.click(within(rowOf(container, "l:iride:parcels")).getByLabelText("Sposta su"));
    expect(titles(container).slice(1, 3)).toEqual(["Particelle catastali", "NDVI"]);
    fireEvent.click(screen.getByRole("button", { name: "Nuova cartella" }));
    expect(field("Titolo").value).toBe("Nuova cartella");
    fireEvent.change(field("Titolo"), { target: { value: "" } });
    expect(screen.getByText("Una cartella non ha il titolo.")).toBeInTheDocument();
    expect(saveBtn()).toBeDisabled();
    fireEvent.change(field("Titolo"), { target: { value: "Clima" } });
    expect(saveBtn()).toBeEnabled();
    fireEvent.click(rowOf(container, "l:demo:roads"));
    fireEvent.change(field("Cartella"), { target: { value: "f-nuova-cartella" } });
    expect(titles(container).slice(-2)).toEqual(["Clima", "Strade"]);
  });

  it("eliminare una cartella porta su il contenuto; 'Altri prodotti' non si elimina", () => {
    const { container } = setup();
    fireEvent.click(rowOf(container, "f:agri"));
    fireEvent.click(screen.getByRole("button", { name: "Elimina cartella" }));
    expect(titles(container)).toEqual(["NDVI", "Particelle catastali", "Altri prodotti", "Strade"]);
    fireEvent.click(rowOf(container, `f:${OTHERS}`));
    expect(screen.queryByRole("button", { name: "Elimina cartella" })).toBeNull();
  });

  it("trascinamento: su una cartella = dentro; sulla zona in fondo = primo livello", () => {
    const { container } = setup();
    const dt = { setData: vi.fn(), effectAllowed: "" };
    fireEvent.dragStart(rowOf(container, "l:demo:roads"), { dataTransfer: dt });
    fireEvent.dragOver(rowOf(container, "f:agri"), { dataTransfer: dt });
    expect(rowOf(container, "f:agri")).toHaveClass("drop");
    fireEvent.drop(rowOf(container, "f:agri"), { dataTransfer: dt });
    expect(titles(container)).toEqual(["Agricoltura", "NDVI", "Particelle catastali", "Strade", "Altri prodotti"]);
    fireEvent.dragStart(rowOf(container, "l:iride:ndvi"), { dataTransfer: dt });
    fireEvent.drop(container.querySelector(".cat-root-drop")!, { dataTransfer: dt });
    expect(titles(container).at(-1)).toBe("NDVI");
  });

  it("filtro: mostra i risultati con le cartelle che li contengono; chiudere una cartella ne nasconde il contenuto", () => {
    const { container } = setup();
    fireEvent.change(screen.getByLabelText("Filtra il catalogo"), { target: { value: "strad" } });
    expect(titles(container)).toEqual(["Altri prodotti", "Strade"]);
    fireEvent.change(screen.getByLabelText("Filtra il catalogo"), { target: { value: "" } });
    fireEvent.click(screen.getByLabelText("Chiudi Agricoltura"));
    expect(titles(container)).toEqual(["Agricoltura", "Altri prodotti", "Strade"]);
  });

  it("conflitto: messaggio e pulsante per ricaricare; Annulla modifiche torna al salvato", async () => {
    vi.mocked(store.saveCatalog).mockRejectedValue(new store.CatalogConflictError());
    const { container, onChanged } = setup();
    fireEvent.click(rowOf(container, "f:agri"));
    fireEvent.change(field("Titolo"), { target: { value: "Altro" } });
    await act(async () => { fireEvent.click(saveBtn()); });
    expect(screen.getByRole("status")).toHaveTextContent(/modificato da un altro amministratore/);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Ricarica il catalogo" })); });
    expect(onChanged).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Annulla modifiche" }));
    expect(titles(container)[0]).toBe("Agricoltura");
  });

  it("rimuovere un layer non più pubblicato è una modifica da salvare", async () => {
    vi.mocked(store.saveCatalog).mockResolvedValue(2);
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Rimuovi dal catalogo" }));
    expect(screen.getByText("2 modifiche non salvate")).toBeInTheDocument();
    await act(async () => { fireEvent.click(saveBtn()); });
    expect(vi.mocked(store.saveCatalog).mock.calls[0][4].layers.some((l) => l.layer === "iride:gone")).toBe(false);
  });

  it("catalogo mai salvato: avviso e schema per workspace; tabelle mancanti: salvataggio disabilitato", () => {
    const { container, unmount } = setup(EMPTY_CATALOG);
    expect(screen.getByText(/non è ancora stato salvato/)).toBeInTheDocument();
    expect(titles(container)).toEqual(["demo", "Strade", "iride", "NDVI", "Particelle", "Altri prodotti"]);
    expect(saveBtn()).toBeEnabled();
    unmount();
    setup(EMPTY_CATALOG, "Tabelle del catalogo non trovate");
    expect(screen.getByText("Tabelle del catalogo non trovate")).toBeInTheDocument();
    expect(saveBtn()).toBeDisabled();
  });

  it("con un errore (es. elenco dei layer non letto) l'elenco dei 'non più pubblicati' non si mostra e non si salva", () => {
    setup(SAVED, "Elenco dei layer di GeoServer non disponibile");
    expect(screen.queryByRole("button", { name: "Rimuovi dal catalogo" })).toBeNull();
    expect(saveBtn()).toBeDisabled();
  });

  it("modifiche non salvate: la pagina chiede conferma prima di chiudersi", () => {
    const { container } = setup();
    fireEvent.click(rowOf(container, "f:agri"));
    fireEvent.change(field("Titolo"), { target: { value: "X" } });
    const ev = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});
