// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ChangeEntry } from "../src/changeLog";
import { ACC, fakeKc } from "./support";

vi.mock("../src/changeLog", async (orig) => ({ ...(await orig<typeof import("../src/changeLog")>()), loadChangeLog: vi.fn(), restoreVersion: vi.fn() }));
import * as cl from "../src/changeLog";
import AdminChangeLog from "../src/AdminChangeLog";

const now = new Date().toISOString();
const E = (seq: number, extra: Partial<ChangeEntry>): ChangeEntry => ({ fid: `change_log.${seq}`, seq, table: "role_rules", rowId: 1, op: "UPDATE", old: null, new: null, changedBy: "ada", dbUser: "gs_config", changedAt: now, ...extra });
const ENTRIES = [
  E(3, { op: "DELETE", table: "dashboards", rowId: 9, old: { id: 9, title: "Vecchia", roles: '["v"]' }, changedBy: "cleo" }),
  E(2, { op: "UPDATE", old: { id: 1, role: "ops", tools: "[]" }, new: { id: 1, role: "ops", tools: '["info","table"]' }, changedBy: "bea" }),
  E(1, { op: "INSERT", new: { id: 1, role: "ops", tools: "[]" }, changedAt: new Date(Date.now() - 60_000).toISOString() }),
];

const setup = () => {
  const onChanged = vi.fn(async () => {});
  render(<AdminChangeLog gs="g" kc={fakeKc({ preferred_username: "dora" })} acc={ACC} onChanged={onChanged} />);
  return { onChanged };
};
const entry = (fid: string) => document.querySelector(`[data-fid="${fid}"]`) as HTMLElement;

beforeEach(() => {
  vi.mocked(cl.loadChangeLog).mockReset().mockResolvedValue({ entries: ENTRIES, capped: false });
  vi.mocked(cl.restoreVersion).mockReset().mockResolvedValue("updated");
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("AdminChangeLog", () => {
  it("elenco: quando, cosa, chi; campi cambiati; versione attuale", async () => {
    setup();
    expect(await screen.findByText("3 modifiche.")).toBeInTheDocument();
    const q = vi.mocked(cl.loadChangeLog).mock.calls[0][3];
    expect(q.from).toMatch(/^\d{4}-\d{2}-\d{2}$/); // ultimi 30 giorni
    const del = entry("change_log.3");
    expect(del).toHaveTextContent("Eliminato");
    expect(del).toHaveTextContent("Dashboard Vecchia");
    expect(del).toHaveTextContent("cleo");
    const upd = within(entry("change_log.2"));
    expect(entry("change_log.2").querySelector(".cl-fields")).toHaveTextContent("tools");
    expect(upd.getByText("versione attuale")).toBeInTheDocument();
    expect(within(entry("change_log.1")).queryByText("versione attuale")).toBeNull();
    // dettaglio: prima e dopo, JSON leggibile
    const rows = within(entry("change_log.2").querySelector("table")!).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("tools[][");
    expect(upd.getByRole("button", { name: "Torna a questa versione" })).toBeDisabled();
  });

  it("ripristina un elemento eliminato, poi ricarica registro e configurazione", async () => {
    vi.mocked(cl.restoreVersion).mockResolvedValue("inserted");
    const { onChanged } = setup();
    await screen.findByText("3 modifiche.");
    fireEvent.click(within(entry("change_log.3")).getByRole("button", { name: "Ripristina l'elemento eliminato" }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Ripristinare l'elemento eliminato?\nDashboard · Vecchia"));
    await waitFor(() => expect(cl.restoreVersion).toHaveBeenCalledWith("g", expect.anything(), ACC, ENTRIES[0]));
    expect(await screen.findByText("Ripristinato: Dashboard · Vecchia (ricreato come elemento nuovo).")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
    expect(cl.loadChangeLog).toHaveBeenCalledTimes(2);
  });

  it("torna a una versione precedente; annullato dalla conferma non fa nulla; errore mostrato", async () => {
    setup();
    await screen.findByText("3 modifiche.");
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(within(entry("change_log.1")).getByRole("button", { name: "Torna a questa versione" }));
    expect(cl.restoreVersion).not.toHaveBeenCalled();
    fireEvent.click(within(entry("change_log.1")).getByRole("button", { name: "Torna a questa versione" }));
    expect(await screen.findByText(/Riportato alla versione del .*: Regole dei ruoli · ops\./)).toBeInTheDocument();
    vi.mocked(cl.restoreVersion).mockRejectedValueOnce(new Error("duplicate key"));
    fireEvent.click(within(entry("change_log.1")).getByRole("button", { name: "Torna a questa versione" }));
    expect(await screen.findByText("Ripristino non riuscito: duplicate key")).toBeInTheDocument();
    vi.mocked(cl.restoreVersion).mockResolvedValueOnce("unchanged");
    fireEvent.click(within(entry("change_log.1")).getByRole("button", { name: "Torna a questa versione" }));
    expect(await screen.findByText(/è già com'era in questa versione/)).toBeInTheDocument();
  });

  it("filtri e cronologia di un elemento", async () => {
    setup();
    await screen.findByText("3 modifiche.");
    fireEvent.change(screen.getByLabelText("Cosa"), { target: { value: "dashboards" } });
    fireEvent.change(screen.getByLabelText("Utente"), { target: { value: "cleo" } });
    fireEvent.change(screen.getByLabelText("Cerca"), { target: { value: "vecchia" } });
    fireEvent.click(screen.getByRole("button", { name: "Cerca" }));
    await waitFor(() => expect(vi.mocked(cl.loadChangeLog).mock.calls.at(-1)![3]).toMatchObject({ table: "dashboards", user: "cleo", text: "vecchia" }));
    // con un filtro per utente non si può dire quale sia la versione attuale
    await screen.findByText("3 modifiche.");
    expect(screen.queryByText("versione attuale")).toBeNull();
    fireEvent.click(within(entry("change_log.2")).getByRole("button", { name: "Cronologia di questo elemento" }));
    await waitFor(() => expect(vi.mocked(cl.loadChangeLog).mock.calls.at(-1)![3]).toEqual({ table: "role_rules", rowId: 1 }));
    expect(await screen.findByText(/Cronologia di un solo elemento \(Regole dei ruoli #1\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mostra tutto" }));
    await waitFor(() => expect(vi.mocked(cl.loadChangeLog).mock.calls.at(-1)![3]).toMatchObject({ table: "role_rules", from: expect.any(String) }));
    expect(vi.mocked(cl.loadChangeLog).mock.calls.at(-1)![3].rowId).toBeUndefined();
  });

  it("tabella mancante o errore; elenco vuoto; risultati limitati", async () => {
    vi.mocked(cl.loadChangeLog).mockRejectedValueOnce(new Error("Feature type mapp:change_log unknown"));
    setup();
    expect(await screen.findByText(/Registro non disponibile: .*mapp:change_log/)).toBeInTheDocument();
    vi.mocked(cl.loadChangeLog).mockResolvedValueOnce({ entries: [], capped: false });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cerca" })); });
    expect(await screen.findByText("Nessuna modifica con questi filtri.")).toBeInTheDocument();
    vi.mocked(cl.loadChangeLog).mockResolvedValueOnce({ entries: ENTRIES, capped: true });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Ultimi 30 giorni" })); });
    expect(await screen.findByText(/le più recenti: restringi i filtri/)).toBeInTheDocument();
  });
});
