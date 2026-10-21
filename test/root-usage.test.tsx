// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { AppConfig } from "../src/config";
import { ACC, fakeKc } from "./support";

vi.mock("../src/usage", () => ({ startUsage: vi.fn(), stopUsage: vi.fn(), track: vi.fn() }));
vi.mock("../src/App", () => ({ default: () => <div data-testid="app" /> }));
vi.mock("../src/AdminUsage", () => ({ default: (p: any) => <div data-testid="admin-usage">mode={p.mode} prodotti={p.products.length} dashboard={p.dashboards.length}</div> }));
vi.mock("../src/DashboardPages", () => ({ DashboardList: () => <div data-testid="dash-list" />, DashboardView: () => <div data-testid="dash-view" /> }));
vi.mock("../src/capabilities", () => ({ fetchProducts: vi.fn(async () => []) }));
vi.mock("../src/configStore", async (orig) => ({
  ...(await orig<typeof import("../src/configStore")>()),
  loadRules: vi.fn(async () => []), loadDashboards: vi.fn(async () => [{ fid: "dashboards.4", title: "Monitoraggio", description: "", roles: ["fss-etl-viewer"], widgets: [] }]),
  loadCatalog: vi.fn(async () => ({ folders: [], layers: [] })), loadRoleViews: vi.fn(async () => []), loadAnnouncements: vi.fn(async () => []), loadDashboardDrafts: vi.fn(async () => []),
}));
import * as usage from "../src/usage";
import Root, { pageName } from "../src/Root";

const cfg = (usageStats?: AppConfig["usageStats"]): AppConfig => ({ apiUrl: "", geoserverUrl: "/geoserver", basemapTiles: "", mapCenter: [12, 42], mapZoom: 5, access: ACC, ...(usageStats ? { usageStats } : {}) });
const user = (roles: string[]) => fakeKc({ preferred_username: "ada", resource_access: { mapp: { roles } } });
const at = (p: string) => window.history.replaceState(null, "", p);

beforeEach(() => { for (const f of [usage.startUsage, usage.stopUsage, usage.track]) vi.mocked(f).mockReset(); sessionStorage.clear(); });
afterEach(() => at("/"));

describe("Root: statistiche d'uso", () => {
  it("nomi delle pagine senza id", () => {
    expect(["/", "/dashboards", "/d/12", "/admin/roles", "/admin/usage/x", "/altro"].map(pageName)).toEqual(["mappa", "elenco dashboard", "dashboard", "admin roles", "admin usage", "altro"]);
  });

  it("raccolta anonima di default con i ruoli del token; pagina e dashboard aperta", async () => {
    at("/d/4");
    render(<Root cfg={cfg()} kc={user([ACC.viewerRole])} />);
    await screen.findByTestId("dash-view");
    expect(usage.startUsage).toHaveBeenCalledWith(expect.objectContaining({ mode: "anonymous", roles: [ACC.viewerRole], acc: ACC }));
    await waitFor(() => expect(usage.track).toHaveBeenCalledWith("dashboard", "Monitoraggio", "4"));
    expect(usage.track).toHaveBeenCalledWith("page", "dashboard");
  });

  it("USAGE_STATS=off: nessuna raccolta", async () => {
    render(<Root cfg={cfg("off")} kc={user([ACC.viewerRole])} />);
    await screen.findByTestId("app");
    expect(usage.startUsage).not.toHaveBeenCalled();
  });

  it("mentre l'amministratore guarda come un altro ruolo la raccolta è spenta", async () => {
    sessionStorage.setItem("gema.viewAs", ACC.viewerRole);
    render(<Root cfg={cfg("named")} kc={user([ACC.adminRole])} />);
    await screen.findByTestId("app");
    expect(usage.startUsage).not.toHaveBeenCalled();
  });

  it("pagina admin delle statistiche con la modalità e i dati per le etichette", async () => {
    at("/admin/usage");
    render(<Root cfg={cfg("named")} kc={user([ACC.adminRole])} />);
    expect(await screen.findByTestId("admin-usage")).toHaveTextContent("mode=named prodotti=0 dashboard=1");
    expect(usage.startUsage).toHaveBeenCalledWith(expect.objectContaining({ mode: "named" }));
    await waitFor(() => expect(usage.track).toHaveBeenCalledWith("page", "admin usage"));
  });
});
