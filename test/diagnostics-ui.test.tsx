// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { AppConfig } from "../src/config";
import type { CheckResult } from "../src/diagnostics";
import { ACC, fakeKc } from "./support";

vi.mock("../src/download", async (orig) => ({ ...(await orig<typeof import("../src/download")>()), saveBlob: vi.fn() }));
import * as dl from "../src/download";
import AdminDiagnostics from "../src/AdminDiagnostics";

const cfg: AppConfig = { apiUrl: "", geoserverUrl: "/geoserver", basemapTiles: "", mapCenter: [12, 42], mapZoom: 5, access: ACC };
const R = (id: string, group: string, status: CheckResult["status"], extra: Partial<CheckResult> = {}): CheckResult => ({ id, group, label: id, status, detail: `dettaglio ${id}`, ...extra });
const RESULTS = [
  R("config", "Configurazione", "info"),
  R("gs-wms", "GeoServer", "ok", { ms: 12 }),
  R("table-dashboard_drafts", "Tabelle di configurazione", "fail", { hint: "Riesegui il Job" }),
  R("token-roles", "Keycloak e token", "warn"),
];

beforeEach(() => vi.mocked(dl.saveBlob).mockReset());

describe("AdminDiagnostics", () => {
  it("esegue i controlli all'apertura: parziali, poi raggruppati con stato, durata e rimedio", async () => {
    let finish!: (r: CheckResult[]) => void;
    const run = vi.fn((_ctx: any, onResult?: (r: CheckResult[]) => void) => { onResult?.(RESULTS.slice(0, 1)); return new Promise<CheckResult[]>((res) => { finish = res; }); });
    render(<AdminDiagnostics cfg={cfg} acc={ACC} gs="https://app/geoserver" kc={fakeKc({})} run={run} />);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toMatchObject({ gs: "https://app/geoserver", acc: ACC, origin: window.location.origin });
    expect(screen.getByRole("status")).toHaveTextContent("Controllo in corso");
    expect(screen.getByRole("button", { name: "Controllo in corso…" })).toBeDisabled();
    expect(screen.getByRole("region", { name: "Configurazione" })).toBeInTheDocument();
    await act(async () => finish(RESULTS));
    expect(screen.getByRole("status")).toHaveTextContent("1 errori, 1 avvisi, 1 controlli superati.");
    const tables = screen.getByRole("region", { name: "Tabelle di configurazione" });
    expect(within(tables).getByText("Errore")).toBeInTheDocument();
    expect(within(tables).getByText("Riesegui il Job")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "GeoServer" })).getByText("12 ms")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Sfondi" })).toBeNull(); // gruppi senza risultati non compaiono
    const todo = screen.getByRole("region", { name: "Da sistemare" });
    expect(within(todo).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["table-dashboard_drafts", "#diag-table-dashboard_drafts"], ["token-roles", "#diag-token-roles"]]);
  });

  it("ripeti, copia e scarica il rapporto", async () => {
    const run = vi.fn(async () => RESULTS.slice(0, 2));
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(<AdminDiagnostics cfg={cfg} acc={ACC} gs="g" kc={fakeKc({})} run={run} />);
    expect(await screen.findByText("Tutto a posto: 1 controlli superati.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Da sistemare" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ripeti i controlli" }));
    expect(run).toHaveBeenCalledTimes(2);
    await screen.findByText("Tutto a posto: 1 controlli superati.");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copia rapporto" })); });
    expect(writeText.mock.calls[0][0]).toContain("[OK] gs-wms (12 ms)");
    expect(screen.getByText("Rapporto copiato negli appunti.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Scarica rapporto" }));
    const [blob, name] = vi.mocked(dl.saveBlob).mock.calls[0];
    expect(name).toMatch(/^diagnostica-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.txt$/);
    expect(await (blob as Blob).text()).toContain("## GeoServer");
  });

  it("copia non consentita: lo dice", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => { throw new Error("no"); }) } });
    render(<AdminDiagnostics cfg={cfg} acc={ACC} gs="g" kc={fakeKc({})} run={async () => RESULTS} />);
    await screen.findByText(/1 errori/);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copia rapporto" })); });
    expect(screen.getByText(/Copia non consentita/)).toBeInTheDocument();
  });

  it("solo avvisi: riepilogo senza errori", async () => {
    render(<AdminDiagnostics cfg={cfg} acc={ACC} gs="g" kc={fakeKc({})} run={async () => [R("a", "GeoServer", "warn"), R("b", "GeoServer", "ok")]} />);
    expect(await screen.findByText("Nessun errore; 1 avvisi, 1 controlli superati.")).toBeInTheDocument();
  });
});
