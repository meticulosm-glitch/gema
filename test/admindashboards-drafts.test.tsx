// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DashboardDef, DashboardDraft } from "../src/configStore";
import { ACC, fakeKc } from "./support";

vi.mock("../src/configStore", async (orig) => ({
  ...(await orig<typeof import("../src/configStore")>()),
  saveDashboard: vi.fn(), saveDashboardDraft: vi.fn(), publishDashboard: vi.fn(), deleteDashboardDraft: vi.fn(), deleteDashboardAndDraft: vi.fn(), deleteDashboard: vi.fn(),
}));
vi.mock("../src/api", async (orig) => ({ ...(await orig<typeof import("../src/api")>()), describeLayer: vi.fn(() => new Promise(() => {})) }));
vi.mock("../src/Widgets", async (orig) => ({
  ...(await orig<typeof import("../src/Widgets")>()),
  WidgetCard: (p: any) => <div data-testid="widget" data-open={String(p.canOpen)}>{p.def.title}</div>,
}));
import * as store from "../src/configStore";
import AdminDashboards from "../src/AdminDashboards";

const W = (id: string, layer = "iride:parcels") => ({ id, type: "kpi" as const, title: `K${id}`, layer, agg: "count" as const, w: 1 as const });
const PUB: DashboardDef[] = [
  { fid: "dashboards.1", title: "Alfa", description: "", roles: ["fss-etl-viewer"], widgets: [W("a")], updatedBy: "ada", updatedAt: "2026-10-01T10:00:00Z" },
  { fid: "dashboards.2", title: "Beta", description: "", roles: ["fss-etl-viewer"], widgets: [W("a")] },
];
const DRAFTS: DashboardDraft[] = [
  { fid: "dashboard_drafts.5", dashboardId: "2", def: { title: "Beta", description: "", roles: ["fss-etl-viewer", "ops"], widgets: [W("a"), W("b", "iride:other")] }, updatedBy: "bea" },
  { fid: "dashboard_drafts.6", dashboardId: "", def: { title: "Gamma", description: "", roles: [], widgets: [] } },
];
const PRODUCTS = [{ name: "iride:parcels", title: "Particelle", workspace: "iride", vector: true }, { name: "iride:other", title: "Altro", workspace: "iride", vector: true }];
const RULES = [{ role: "fss-etl-viewer", layers: ["iride:parcels"], tools: [] }, { role: "ops", layers: ["*"], tools: [] }];

const setup = (extra: Record<string, unknown> = {}) => {
  const onChanged = vi.fn(async () => {});
  const props = { gs: "g", kc: fakeKc({ preferred_username: "ada" }), acc: ACC, rules: RULES as any, dashboards: PUB, products: PRODUCTS, storeError: null, onChanged, drafts: DRAFTS, draftsError: null, ...extra };
  const r = render(<AdminDashboards {...props} />);
  return { onChanged, rerender: (p: Record<string, unknown>) => r.rerender(<AdminDashboards {...props} {...p} />) };
};
const item = (title: RegExp) => screen.getByRole("button", { name: title });
const title = () => screen.getAllByLabelText("Titolo")[0] as HTMLInputElement;

beforeEach(() => {
  for (const f of [store.saveDashboard, store.deleteDashboardDraft, store.deleteDashboardAndDraft, store.deleteDashboard]) vi.mocked(f).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(store.saveDashboardDraft).mockReset().mockResolvedValue("dashboard_drafts.9");
  vi.mocked(store.publishDashboard).mockReset().mockResolvedValue("dashboards.12");
});

describe("AdminDashboards: bozze e pubblicazione", () => {
  it("elenco con lo stato di ciascuna", () => {
    setup();
    expect(item(/Alfa/)).toHaveTextContent("Pubblicata");
    expect(item(/Beta/)).toHaveTextContent("Bozza da pubblicare");
    expect(item(/Gamma/)).toHaveTextContent("Mai pubblicata");
  });

  it("pubblicata: si modifica in bozza; la versione pubblicata non cambia", async () => {
    setup();
    fireEvent.click(item(/Alfa/));
    expect(screen.getByRole("note")).toHaveTextContent("Pubblicata da ada");
    expect(screen.getByRole("button", { name: "Salva bozza" })).toBeDisabled(); // nessuna modifica
    expect(screen.getByRole("button", { name: "Pubblica" })).toBeDisabled();
    expect(screen.queryByText("Modifiche non salvate")).toBeNull();
    fireEvent.change(title(), { target: { value: "Alfa 2" } });
    expect(screen.getByText("Modifiche non salvate")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Salva bozza" }));
    await waitFor(() => expect(store.saveDashboardDraft).toHaveBeenCalled());
    const [, , , arg] = vi.mocked(store.saveDashboardDraft).mock.calls[0];
    expect(arg).toMatchObject({ fid: undefined, dashboardId: "1", def: { title: "Alfa 2", fid: "dashboards.1" } });
    expect(await screen.findByText(/Bozza salvata: chi usa la dashboard vede ancora la versione pubblicata/)).toBeInTheDocument();
    expect(screen.queryByText("Modifiche non salvate")).toBeNull();
    expect(store.publishDashboard).not.toHaveBeenCalled();
  });

  it("bozza di una pubblicata: contenuto della bozza, differenze, pubblica e scarta", async () => {
    const { onChanged } = setup();
    fireEvent.click(item(/Beta/));
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Stai modificando la bozza di bea");
    expect(note).toHaveTextContent("Differenze: ruoli aggiunti: ops; 1 widget nuovo.");
    expect(screen.getAllByTestId("widget")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Apri la versione pubblicata" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pubblica" }));
    await waitFor(() => expect(store.publishDashboard).toHaveBeenCalled());
    const [, , , d, draftFid] = vi.mocked(store.publishDashboard).mock.calls[0];
    expect(d).toMatchObject({ fid: "dashboards.2", roles: ["fss-etl-viewer", "ops"] });
    expect(d.widgets).toHaveLength(2);
    expect(draftFid).toBe("dashboard_drafts.5");
    expect(await screen.findByText("Dashboard pubblicata: la vedono fss-etl-viewer, ops.")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();

    fireEvent.click(item(/Beta/));
    fireEvent.click(screen.getByRole("button", { name: "Scarta bozza" }));
    await waitFor(() => expect(store.deleteDashboardDraft).toHaveBeenCalledWith("g", expect.anything(), ACC, "dashboard_drafts.5"));
    expect(await screen.findByText("Bozza scartata: torna la versione pubblicata.")).toBeInTheDocument();
    expect(screen.getAllByTestId("widget")).toHaveLength(1); // di nuovo la pubblicata
  });

  it("nuova: la bozza si salva anche incompleta; pubblicare richiede che sia completa", async () => {
    const { rerender } = setup();
    expect(screen.getByRole("button", { name: "Salva bozza" })).toBeDisabled(); // manca il titolo
    fireEvent.change(title(), { target: { value: "Delta" } });
    expect(screen.getByText(/Puoi salvare la bozza anche incompleta/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pubblica" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Salva bozza" }));
    await waitFor(() => expect(store.saveDashboardDraft).toHaveBeenCalled());
    expect(vi.mocked(store.saveDashboardDraft).mock.calls[0][3]).toMatchObject({ dashboardId: "", def: { title: "Delta", widgets: [] } });
    expect(await screen.findByText("Bozza salvata: nessuno la vede finché non la pubblichi.")).toBeInTheDocument();
    // dopo il ricaricamento la bozza nuova è selezionata
    rerender({ drafts: [...DRAFTS, { fid: "dashboard_drafts.9", dashboardId: "", def: { title: "Delta", description: "", roles: [], widgets: [] } }] });
    expect(item(/Delta/)).toHaveClass("on");
    expect(screen.getByRole("note")).toHaveTextContent("Bozza mai pubblicata");
    expect(screen.queryByRole("button", { name: "Scarta bozza" })).toBeNull();
  });

  it("bozza mai pubblicata: pubblica (inserimento) e la seleziona con il nuovo id", async () => {
    const { rerender } = setup();
    fireEvent.click(item(/Gamma/));
    fireEvent.click(screen.getByRole("button", { name: "+ Aggiungi widget" }));
    fireEvent.click(screen.getByRole("button", { name: "Pubblica" }));
    await waitFor(() => expect(store.publishDashboard).toHaveBeenCalled());
    expect(vi.mocked(store.publishDashboard).mock.calls[0][3].fid).toBeUndefined();
    expect(vi.mocked(store.publishDashboard).mock.calls[0][4]).toBe("dashboard_drafts.6");
    expect(await screen.findByText("Dashboard pubblicata: nessun ruolo la vede ancora (solo gli amministratori).")).toBeInTheDocument();
    rerender({ dashboards: [...PUB, { fid: "dashboards.12", title: "Gamma", description: "", roles: [], widgets: [W("x")] }], drafts: DRAFTS.slice(0, 1) });
    expect(item(/Gamma/)).toHaveClass("on");
    expect(item(/Gamma/)).toHaveTextContent("Pubblicata");
  });

  it("elimina: dashboard e bozza insieme; bozza nuova da sola", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    setup();
    fireEvent.click(item(/Beta/));
    fireEvent.click(screen.getByRole("button", { name: "Elimina" }));
    expect(window.confirm).toHaveBeenCalledWith('Eliminare la dashboard "Beta" e la sua bozza?');
    await waitFor(() => expect(store.deleteDashboardAndDraft).toHaveBeenCalledWith("g", expect.anything(), ACC, "dashboards.2", "dashboard_drafts.5"));
    fireEvent.click(item(/Gamma/));
    fireEvent.click(screen.getByRole("button", { name: "Elimina" }));
    await waitFor(() => expect(store.deleteDashboardAndDraft).toHaveBeenLastCalledWith("g", expect.anything(), ACC, undefined, "dashboard_drafts.6"));
    expect(await screen.findByText("Bozza eliminata.")).toBeInTheDocument();
  });

  it("senza la tabella delle bozze: avviso e salvataggio diretto come prima", async () => {
    setup({ drafts: undefined, draftsError: "Bozze non disponibili: manca il layer." });
    expect(screen.getByText("Bozze non disponibili: manca il layer.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Salva bozza" })).toBeNull();
    expect(screen.queryByText("Mai pubblicata")).toBeNull();
    expect(screen.queryByRole("button", { name: /Gamma/ })).toBeNull(); // le bozze non si mostrano
    fireEvent.click(item(/Alfa/));
    fireEvent.change(title(), { target: { value: "Alfa 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Salva dashboard" }));
    await waitFor(() => expect(store.saveDashboard).toHaveBeenCalled());
    expect(store.saveDashboardDraft).not.toHaveBeenCalled();
  });
});

describe("AdminDashboards: anteprima per ruolo", () => {
  it("come la vede un ruolo: avvisi su ruoli e layer; nessun salto alla mappa", () => {
    setup();
    fireEvent.click(item(/Beta/));
    const prev = screen.getByRole("region", { name: "Anteprima" });
    const sel = within(prev).getByLabelText("Anteprima come ruolo") as HTMLSelectElement;
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(["", "fss-etl-viewer", "ops"]);
    expect(within(prev).queryByRole("list")).toBeNull();
    fireEvent.change(sel, { target: { value: "fss-etl-viewer" } });
    const notes = within(prev).getByRole("list");
    expect(notes).toHaveTextContent("fss-etl-viewer trova questa dashboard nell'elenco");
    expect(notes).toHaveTextContent("Layer non abilitati per fss-etl-viewer nella pagina Ruoli e permessi: iride:other.");
    fireEvent.change(sel, { target: { value: "ops" } });
    expect(within(prev).getByRole("list")).not.toHaveTextContent("Layer non abilitati");
    expect(within(prev).getAllByTestId("widget").every((w) => w.dataset.open === "false")).toBe(true);
  });

  it("ruolo tolto dalla dashboard: l'anteprima lo dice subito", () => {
    setup();
    fireEvent.click(item(/Alfa/));
    fireEvent.change(screen.getByLabelText("Anteprima come ruolo"), { target: { value: "fss-etl-viewer" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "fss-etl-viewer" }));
    expect(screen.getByRole("region", { name: "Anteprima" })).toHaveTextContent("fss-etl-viewer non è tra i ruoli della dashboard: non la vedrà.");
  });
});
