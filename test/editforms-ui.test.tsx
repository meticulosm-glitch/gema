// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import EditFields from "../src/EditFields";
import { resolveForm } from "../src/editForm";
import { ACC, fakeKc } from "./support";

vi.mock("../src/api", async (orig) => ({ ...(await orig<typeof import("../src/api")>()), describeLayer: vi.fn(), getWfsFeatures: vi.fn() }));
vi.mock("../src/configStore", async (orig) => ({ ...(await orig<typeof import("../src/configStore")>()), loadEditForms: vi.fn(), saveEditForm: vi.fn() }));
import * as api from "../src/api";
import * as store from "../src/configStore";
import AdminForms from "../src/AdminForms";

const SCHEMA = [{ name: "name", type: "string" }, { name: "kind", type: "string" }, { name: "area", type: "double" }, { name: "surveyed", type: "date" }, { name: "ok", type: "boolean" }];

describe("EditFields", () => {
  const fields = resolveForm(SCHEMA, {
    fields: [
      { name: "kind", alias: "Tipo", required: true, options: [{ value: "A", label: "Agricola" }, { value: "B", label: "Boschiva" }] },
      { name: "name", alias: "Nome", help: "Come da visura" },
      { name: "area", readonly: true },
      { name: "surveyed", hidden: true, default: "2026-01-01" },
    ],
  });

  it("etichette, ordine, nascosti assenti, sola lettura disattivati, aiuto ed errori collegati al campo", () => {
    const onChange = vi.fn();
    render(<EditFields fields={fields} values={{ kind: "", name: "x", area: "5" }} errors={{ kind: "Campo obbligatorio." }} isNew={false} onChange={onChange} />);
    expect(Array.from(document.querySelectorAll(".ed-field > span")).map((s) => s.textContent)).toEqual(["Tipo", "Nome", "area", "ok"]);
    expect(screen.getByLabelText("area")).toBeDisabled();
    const kind = screen.getByLabelText("Tipo");
    expect(kind).toHaveAttribute("aria-invalid", "true");
    expect(kind).toHaveAttribute("aria-required", "true");
    expect(kind).toHaveAccessibleDescription("Campo obbligatorio.");
    expect(screen.getByLabelText("Nome")).toHaveAccessibleDescription("Come da visura");
    expect(within(kind).getAllByRole("option").map((o) => o.textContent)).toEqual(["— scegli —", "Agricola", "Boschiva"]);
    fireEvent.change(kind, { target: { value: "B" } });
    expect(onChange).toHaveBeenCalledWith("kind", "B");
    expect(within(screen.getByLabelText("ok")).getAllByRole("option").map((o) => o.textContent)).toEqual(["", "sì", "no"]);
  });

  it("valore non previsto dal menu: resta selezionabile come 'valore attuale'", () => {
    render(<EditFields fields={fields} values={{ kind: "Z" }} isNew={false} onChange={() => {}} />);
    expect((screen.getByLabelText("Tipo") as HTMLSelectElement).value).toBe("Z");
    expect(screen.getByRole("option", { name: "Z (valore attuale)" })).toBeInTheDocument();
  });
});

describe("AdminForms", () => {
  const products = [
    { name: "iride:parcels", title: "Particelle", workspace: "iride", vector: true },
    { name: "iride:ndvi", title: "NDVI", workspace: "iride", vector: false },
  ];
  beforeEach(() => {
    vi.mocked(api.describeLayer).mockResolvedValue({ prefix: "iride", ns: "x", typeName: "parcels", geomName: "geom", geomType: "MultiPolygon", fields: SCHEMA });
    vi.mocked(store.loadEditForms).mockResolvedValue([]);
    vi.mocked(store.saveEditForm).mockReset().mockResolvedValue();
    vi.mocked(api.getWfsFeatures).mockResolvedValue([{ geometry: null, properties: { kind: "B" } }, { geometry: null, properties: { kind: "A" } }, { geometry: null, properties: { kind: "B" } }]);
  });
  const openParcels = async () => {
    render(<AdminForms gs="http://gs" kc={fakeKc({ preferred_username: "ada" })} acc={ACC} products={products} />);
    fireEvent.click(await screen.findByRole("button", { name: /Particelle/ }));
    await screen.findByText("kind", { selector: "code" });
  };
  const card = (name: string) => document.querySelector(`.form-field-card[data-field="${name}"]`) as HTMLElement;

  it("solo layer vettoriali; un riquadro per colonna; niente da salvare finché non cambia nulla", async () => {
    await openParcels();
    expect(screen.queryByRole("button", { name: /NDVI/ })).toBeNull();
    expect(Array.from(document.querySelectorAll(".form-field-card")).map((c) => (c as HTMLElement).dataset.field)).toEqual(SCHEMA.map((f) => f.name));
    expect(screen.getByRole("button", { name: "Salva modulo" })).toBeDisabled();
  });

  it("modifica, menu dai valori del layer, ordine, anteprima e salvataggio", async () => {
    await openParcels();
    fireEvent.change(within(card("kind")).getByPlaceholderText("kind"), { target: { value: "Tipo" } });
    fireEvent.click(within(card("kind")).getByRole("button", { name: "Menu a tendina…" }));
    await act(async () => { fireEvent.click(within(card("kind")).getByRole("button", { name: "Aggiungi i valori presenti nel layer" })); });
    expect(api.getWfsFeatures).toHaveBeenCalledWith("http://gs", expect.anything(), "iride:parcels", "", 5000, ["kind"]);
    expect((within(card("kind")).getByLabelText("Voci del menu di kind") as HTMLTextAreaElement).value).toBe("A\nB");
    expect(within(card("kind")).getByText("2 valori trovati nel layer.")).toBeInTheDocument();
    fireEvent.click(within(card("kind")).getByLabelText("Sposta su kind"));
    fireEvent.click(within(card("name")).getByLabelText(/Obbligatorio/));
    const preview = document.querySelector(".forms-preview") as HTMLElement;
    expect(Array.from(preview.querySelectorAll(".ed-field > span")).map((s) => s.textContent)).toEqual(["Tipo", "name", "area", "surveyed", "ok"]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Salva modulo" })); });
    const def = vi.mocked(store.saveEditForm).mock.calls[0][3];
    expect(def.layer).toBe("iride:parcels");
    expect(def.fields.map((r) => r.name)).toEqual(["kind", "name", "area", "surveyed", "ok"]);
    expect(def.fields[0]).toEqual({ name: "kind", alias: "Tipo", options: [{ value: "A", label: "A" }, { value: "B", label: "B" }] });
    expect(def.fields[1]).toEqual({ name: "name", required: true });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Modulo salvato"));
  });

  it("controlli: predefinito non valido o obbligatorio in sola lettura senza predefinito bloccano il salvataggio", async () => {
    await openParcels();
    fireEvent.change(within(card("area")).getByLabelText("Valore predefinito (nuovi oggetti)"), { target: { value: "molto" } });
    expect(screen.getByText(/Valore predefinito di «area»: serve un numero/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salva modulo" })).toBeDisabled();
    fireEvent.change(within(card("area")).getByLabelText("Valore predefinito (nuovi oggetti)"), { target: { value: "" } });
    fireEvent.click(within(card("area")).getByLabelText(/Obbligatorio/));
    fireEvent.click(within(card("area")).getByLabelText(/Sola lettura/));
    expect(screen.getByText(/nessun nuovo oggetto si potrebbe salvare/)).toBeInTheDocument();
    fireEvent.click(within(card("surveyed")).getByLabelText(/Obbligatorio/));
    fireEvent.click(within(card("surveyed")).getByLabelText(/Nascosto/));
    expect(screen.getByText(/«surveyed» è nascosto: l'obbligo non si applica/)).toBeInTheDocument();
  });

  it("modulo esistente: si riapre; 'Ripristina predefinito' salva un modulo vuoto; tornare all'ordine e ai valori iniziali = modulo vuoto", async () => {
    vi.mocked(store.loadEditForms).mockResolvedValue([{ fid: "edit_forms.1", layer: "iride:parcels", fields: [{ name: "name", alias: "Nome" }] }]);
    await openParcels();
    expect((within(card("name")).getByPlaceholderText("name") as HTMLInputElement).value).toBe("Nome");
    expect(screen.getByRole("button", { name: /Particelle/ })).toHaveTextContent("modulo configurato");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Ripristina predefinito" })); });
    expect(vi.mocked(store.saveEditForm).mock.calls[0][3]).toEqual({ fid: "edit_forms.1", layer: "iride:parcels", fields: [] });
    fireEvent.change(within(card("name")).getByPlaceholderText("name"), { target: { value: "" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Salva modulo" })); });
    expect(vi.mocked(store.saveEditForm).mock.calls[1][3].fields).toEqual([]);
  });

  it("tabella mancante: avviso e salvataggio disattivato", async () => {
    vi.mocked(store.loadEditForms).mockRejectedValue(new Error("Feature type mapp:edit_forms unknown"));
    await openParcels();
    expect(screen.getByText(/Tabella dei moduli non trovata: .*mapp:edit_forms/)).toBeInTheDocument();
    fireEvent.change(within(card("kind")).getByPlaceholderText("kind"), { target: { value: "Tipo" } });
    expect(screen.getByRole("button", { name: "Salva modulo" })).toBeDisabled();
  });
});
