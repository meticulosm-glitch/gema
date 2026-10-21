// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AppConfig } from "../src/config";
import { effectiveRoles, loadViewAs, storeViewAs } from "../src/viewAs";
import ViewAsBar from "../src/ViewAsBar";
import { ACC, fakeKc } from "./support";

vi.mock("../src/App", () => ({
  default: (p: any) => <div data-testid="app">perms={p.perms.layers === "*" ? "*" : [...p.perms.layers].join("+")} tools={[...p.perms.tools].join("+")} admin={String(p.perms.admin)} vista={JSON.stringify(p.startView ?? null)}{p.nav}{p.banner}</div>,
}));
vi.mock("../src/AdminRoles", async (orig) => ({
  roleList: (await orig<typeof import("../src/AdminRoles")>()).roleList,
  default: (p: any) => <div data-testid="admin-roles"><button onClick={() => p.onViewAs("ops")}>come ops</button></div>,
}));
vi.mock("../src/AdminDashboards", () => ({ default: () => <div data-testid="admin-dash" /> }));
vi.mock("../src/DashboardPages", () => ({
  DashboardList: (p: any) => <div data-testid="dash-list">{p.dashboards.map((d: any) => d.title).join(",")}</div>,
  DashboardView: (p: any) => <div data-testid="dash-view">{p.id}</div>,
}));
vi.mock("../src/capabilities", () => ({ fetchProducts: vi.fn(async () => []) }));
vi.mock("../src/configStore", async (orig) => ({
  ...(await orig<typeof import("../src/configStore")>()),
  loadRules: vi.fn(), loadDashboards: vi.fn(), loadCatalog: vi.fn(async () => ({ folders: [], layers: [] })), loadRoleViews: vi.fn(), loadAnnouncements: vi.fn(), loadDashboardDrafts: vi.fn(async () => []),
}));
import * as store from "../src/configStore";
import Root from "../src/Root";

const cfg: AppConfig = { apiUrl: "", geoserverUrl: "/geoserver", basemapTiles: "", mapCenter: [12, 42], mapZoom: 5, title: "App", access: ACC };
const user = (roles: string[]) => fakeKc({ preferred_username: "ada", resource_access: { mapp: { roles } } });
const at = (p: string) => window.history.replaceState(null, "", p);
const D = (title: string, roles: string[]) => ({ fid: `dashboards.${title.length}`, title, description: "", roles, widgets: [] });

beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(store.loadRules).mockResolvedValue([
    { role: ACC.viewerRole, layers: ["iride:a"], tools: ["info"] },
    { role: "ops", layers: ["*"], tools: ["info", "edit"] },
  ]);
  vi.mocked(store.loadDashboards).mockResolvedValue([D("Per viewer", [ACC.viewerRole]), D("Per ops", ["ops"])]);
  vi.mocked(store.loadRoleViews).mockResolvedValue([{ role: "ops", bbox: [9, 45, 10, 46], basemap: "", layers: [] }]);
  vi.mocked(store.loadAnnouncements).mockResolvedValue([
    { fid: "a.1", message: "Solo per ops", level: "info", startsAt: "", endsAt: "", roles: ["ops"], dismissible: true, active: true },
  ]);
});
afterEach(() => { at("/"); sessionStorage.clear(); });

describe("viewAs", () => {
  it("ruoli effettivi: solo per chi è davvero amministratore, mai il ruolo admin stesso", () => {
    expect(effectiveRoles([ACC.adminRole, "x"], ACC, "ops")).toEqual(["ops"]);
    expect(effectiveRoles([ACC.viewerRole], ACC, "ops")).toEqual([ACC.viewerRole]);
    expect(effectiveRoles([ACC.adminRole], ACC, ACC.adminRole)).toEqual([ACC.adminRole]);
    expect(effectiveRoles([ACC.adminRole], ACC, null)).toEqual([ACC.adminRole]);
  });
  it("resta nella scheda; storage non disponibile = nessun effetto", () => {
    storeViewAs(" ops ");
    expect(loadViewAs()).toBe("ops");
    storeViewAs(null);
    expect(loadViewAs()).toBeNull();
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("bloccato"); });
    expect(loadViewAs()).toBeNull();
    spy.mockRestore();
  });
  it("barra: ruolo, cambio ruolo, uscita", () => {
    const onChange = vi.fn(); const onExit = vi.fn();
    render(<ViewAsBar role="ops" roles={["a", "b"]} onChange={onChange} onExit={onExit} />);
    const bar = screen.getByRole("region", { name: "Visualizza come ruolo" });
    expect(bar).toHaveTextContent("Stai vedendo l'applicazione come ops");
    expect(Array.from((within(bar).getByLabelText("Cambia ruolo") as HTMLSelectElement).options).map((o) => o.value)).toEqual(["ops", "a", "b"]);
    fireEvent.change(within(bar).getByLabelText("Cambia ruolo"), { target: { value: "b" } });
    expect(onChange).toHaveBeenCalledWith("b");
    fireEvent.click(within(bar).getByRole("button", { name: "Torna amministratore" }));
    expect(onExit).toHaveBeenCalled();
  });
});

describe("Root: visualizza come ruolo", () => {
  it("dal menu Admin: la mappa riparte con permessi, strumenti, vista e avvisi del ruolo; il menu Admin sparisce", async () => {
    render(<Root cfg={cfg} kc={user([ACC.adminRole])} />);
    expect(await screen.findByTestId("app")).toHaveTextContent("admin=true");
    expect(screen.queryByText("Solo per ops")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Admin/ }));
    const group = screen.getByRole("group", { name: "Visualizza come ruolo" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual([ACC.viewerRole, "ops"]);
    fireEvent.click(within(group).getByRole("button", { name: "ops" }));
    await waitFor(() => expect(screen.getByTestId("app")).toHaveTextContent("perms=* tools=info+edit admin=false"));
    const app = screen.getByTestId("app");
    expect(app).toHaveTextContent(`vista={"bbox":[9,45,10,46],"roles":["ops"]}`);
    expect(screen.getByRole("region", { name: "Visualizza come ruolo" })).toHaveTextContent("come ops");
    expect(screen.getByText("Solo per ops")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Admin/ })).toBeNull();
    expect(sessionStorage.getItem("gema.viewAs")).toBe("ops");
  });

  it("cambio ruolo dalla barra e ritorno amministratore", async () => {
    sessionStorage.setItem("gema.viewAs", "ops");
    render(<Root cfg={cfg} kc={user([ACC.adminRole])} />);
    await screen.findByText(/perms=\*/);
    fireEvent.change(screen.getByLabelText("Cambia ruolo"), { target: { value: ACC.viewerRole } });
    await waitFor(() => expect(screen.getByTestId("app")).toHaveTextContent("perms=iride:a tools=info admin=false"));
    fireEvent.click(screen.getByRole("button", { name: "Torna amministratore" }));
    expect(screen.getByTestId("app")).toHaveTextContent("admin=true");
    expect(screen.queryByRole("region", { name: "Visualizza come ruolo" })).toBeNull();
    expect(sessionStorage.getItem("gema.viewAs")).toBeNull();
  });

  it("dashboard: solo quelle del ruolo", async () => {
    sessionStorage.setItem("gema.viewAs", ACC.viewerRole);
    at("/dashboards");
    render(<Root cfg={cfg} kc={user([ACC.adminRole])} />);
    expect(await screen.findByTestId("dash-list")).toHaveTextContent(/^Per viewer$/);
  });

  it("pagine admin: spiegazione e uscita, non 'accesso negato'", async () => {
    sessionStorage.setItem("gema.viewAs", "ops");
    at("/admin/roles");
    render(<Root cfg={cfg} kc={user([ACC.adminRole])} />);
    expect(await screen.findByText(/che non ha accesso a questa pagina/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Torna amministratore" })[1]);
    expect(await screen.findByTestId("admin-roles")).toBeInTheDocument();
  });

  it("dalla pagina Ruoli e permessi: si apre la mappa come quel ruolo", async () => {
    at("/admin/roles");
    render(<Root cfg={cfg} kc={user([ACC.adminRole])} />);
    fireEvent.click(await screen.findByRole("button", { name: "come ops" }));
    expect(await screen.findByTestId("app")).toHaveTextContent("admin=false");
    expect(window.location.pathname).toBe("/");
  });

  it("ruolo senza regole: lo spiega, e la barra permette di uscire", async () => {
    sessionStorage.setItem("gema.viewAs", "nuovo");
    render(<Root cfg={cfg} kc={user([ACC.adminRole])} />);
    expect(await screen.findByText(/Il ruolo/)).toHaveTextContent("Il ruolo nuovo non ha regole");
    expect(screen.queryByText(/Ruoli letti dal token/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Torna amministratore" }));
    expect(await screen.findByTestId("app")).toHaveTextContent("admin=true");
  });

  it("chi non è amministratore non può usarlo (anche con il valore nello storage)", async () => {
    sessionStorage.setItem("gema.viewAs", "ops");
    render(<Root cfg={cfg} kc={user([ACC.viewerRole])} />);
    expect(await screen.findByTestId("app")).toHaveTextContent("perms=iride:a");
    expect(screen.queryByRole("region", { name: "Visualizza come ruolo" })).toBeNull();
  });
});
