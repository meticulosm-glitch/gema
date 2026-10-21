// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { UsageReport } from "../src/usageStats";
import { ACC, fakeKc } from "./support";

vi.mock("../src/usageStats", async (orig) => ({ ...(await orig<typeof import("../src/usageStats")>()), loadUsage: vi.fn() }));
import * as us from "../src/usageStats";
import AdminUsage from "../src/AdminUsage";

const T = (target: string, events: number, sessions = 1) => ({ target, events, sessions, users: 0 });
const REPORT: UsageReport = {
  from: "2026-09-21", to: "2026-10-20",
  days: [{ day: "2026-10-19", events: 10, sessions: 3, users: 0 }, { day: "2026-10-20", events: 4, sessions: 1, users: 0 }],
  totals: { events: 14, sessions: 4, users: 0 },
  byKind: { layer: [T("iride:parcels", 6, 3), T("iride:sensors", 2)], tool: [T("length", 3)], dashboard: [T("Monitoraggio", 2)], page: [T("mappa", 5)], search: [T("luogo", 1)], download: [] },
  roles: [{ role: "fss-etl-viewer", events: 12, sessions: 3 }, { role: ACC.adminRole, events: 2, sessions: 1 }],
  users: [],
};
const PRODUCTS = [{ name: "iride:parcels", title: "Particelle", workspace: "iride" }];
const setup = (mode: "off" | "anonymous" | "named" = "anonymous", dashboards = [{ fid: "dashboards.1", title: "Monitoraggio" }, { fid: "dashboards.2", title: "Mai vista" }]) =>
  render(<AdminUsage gs="g" kc={fakeKc({})} acc={ACC} mode={mode} products={PRODUCTS as any} dashboards={dashboards} />);

beforeEach(() => vi.mocked(us.loadUsage).mockReset().mockResolvedValue(REPORT));

describe("AdminUsage", () => {
  it("totali, sessioni al giorno, classifiche con titoli dei layer e nomi degli strumenti, ruoli", async () => {
    setup();
    const kpis = await screen.findByRole("group", { name: "Totali del periodo" });
    expect(kpis).toHaveTextContent("4sessioni");
    expect(kpis).toHaveTextContent("—utenti");
    expect(kpis).toHaveTextContent("non raccolti (modalità anonima)");
    expect(kpis).toHaveTextContent("14azioni");
    expect(vi.mocked(us.loadUsage).mock.calls[0][3]).toBe(30);
    expect(screen.getByRole("img", { name: /Linea: 2 periodi, da 19\/10 a 20\/10/ })).toBeInTheDocument();
    const layers = within(screen.getByRole("region", { name: "Layer accesi" })).getAllByRole("listitem").map((li) => li.textContent);
    expect(layers).toEqual(["Particelle6", "iride:sensors2"]);
    expect(within(screen.getByRole("region", { name: "Strumenti" })).getByText("Misura distanza")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Ricerche" })).getByText("Luoghi")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Scarichi" })).getByText("Nessuno scarico.")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Per ruolo" })).getAllByRole("row").map((r) => r.textContent)).toEqual(["RuoloSessioniAzioni", "fss-etl-viewer312", `${ACC.adminRole} (amministratori)12`]);
    expect(screen.queryByRole("region", { name: "Utenti più attivi" })).toBeNull();
    expect(screen.getByText("Dashboard mai aperte nel periodo: Mai vista.")).toBeInTheDocument();
  });

  it("periodo e aggiorna", async () => {
    setup();
    await screen.findByRole("group", { name: "Totali del periodo" });
    fireEvent.change(screen.getByLabelText("Periodo"), { target: { value: "7" } });
    await waitFor(() => expect(vi.mocked(us.loadUsage).mock.calls.at(-1)![3]).toBe(7));
    fireEvent.click(screen.getByRole("button", { name: "Aggiorna" }));
    await waitFor(() => expect(us.loadUsage).toHaveBeenCalledTimes(3));
  });

  it("modalità con nomi: utenti e classifica degli utenti", async () => {
    vi.mocked(us.loadUsage).mockResolvedValue({ ...REPORT, totals: { ...REPORT.totals, users: 2 }, users: [{ username: "bea", events: 9, sessions: 3, days: 1, last: "2026-10-20" }] });
    setup("named");
    expect(await screen.findByText(/Raccolta con il nome utente/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Totali del periodo" })).toHaveTextContent("2utentidiversi nel periodo");
    expect(within(screen.getByRole("region", { name: "Utenti più attivi" })).getAllByRole("row")[1]).toHaveTextContent("bea1320/10/2026");
  });

  it("raccolta spenta, nessun dato, viste mancanti", async () => {
    vi.mocked(us.loadUsage).mockResolvedValueOnce({ ...REPORT, totals: { events: 0, sessions: 0, users: 0 }, byKind: {}, roles: [], days: [] });
    setup("off", []);
    expect(await screen.findByText(/Raccolta spenta/)).toBeInTheDocument();
    expect(screen.getByText("Nessun dato nel periodo.")).toBeInTheDocument();
    expect(screen.getByText("Nessun layer acceso.")).toBeInTheDocument();
    vi.mocked(us.loadUsage).mockRejectedValueOnce(new Error("Feature type mapp:usage_sessions unknown"));
    fireEvent.click(screen.getByRole("button", { name: "Aggiorna" }));
    expect(await screen.findByText(/Statistiche non disponibili: .*mapp:usage_events/)).toBeInTheDocument();
  });
});
