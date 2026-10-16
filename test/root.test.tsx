// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import Root from "../src/Root";
import type { AppConfig } from "../src/config";
import { ACC, fakeKc } from "./support";

// le schermate pesanti (mappa, editor admin) si sostituiscono con segnaposto che espongono le props ricevute
vi.mock("../src/App", () => ({ default: (p: any) => <div data-testid="app">mappa perms={p.perms ? (p.perms.layers === "*" ? "*" : [...p.perms.layers].join("+")) : "none"}{p.nav}</div> }));
vi.mock("../src/AdminRoles", () => ({ default: (p: any) => <div data-testid="admin-roles">store={String(p.storeError)} prodotti={p.products.map((x: any) => x.name).join(",")}</div> }));
vi.mock("../src/AdminDashboards", () => ({ default: () => <div data-testid="admin-dash" /> }));
vi.mock("../src/DashboardPages", () => ({
  DashboardList: (p: any) => <div data-testid="dash-list">{p.dashboards.map((d: any) => d.title).join(",")}</div>,
  DashboardView: (p: any) => <div data-testid="dash-view">{p.id}</div>,
}));
vi.mock("../src/capabilities", () => ({ fetchProducts: vi.fn() }));
vi.mock("../src/configStore", async (orig) => ({ ...(await orig<typeof import("../src/configStore")>()), loadRules: vi.fn(), loadDashboards: vi.fn() }));
import * as store from "../src/configStore";
import * as caps from "../src/capabilities";

const cfg = (access = true): AppConfig => ({ apiUrl: "", geoserverUrl: "/geoserver", basemapTiles: "", mapCenter: [12, 42], mapZoom: 5, title: "App", access: access ? ACC : undefined });
const user = (roles: string[]) => fakeKc({ preferred_username: "pippo", resource_access: { mapp: { roles } } });
const at = (p: string) => window.history.replaceState(null, "", p);

beforeEach(() => {
  vi.mocked(store.loadRules).mockResolvedValue([]);
  vi.mocked(store.loadDashboards).mockResolvedValue([]);
  vi.mocked(caps.fetchProducts).mockResolvedValue([]);
});
afterEach(() => at("/"));

describe("Root", () => {
  it("controllo accessi spento o auth disabilitata: mappa semplice, senza permessi", () => {
    const { unmount } = render(<Root cfg={cfg(false)} kc={null} />);
    expect(screen.getByTestId("app")).toHaveTextContent("perms=none");
    unmount();
    render(<Root cfg={cfg(true)} kc={null} />);
    expect(screen.getByTestId("app")).toHaveTextContent("perms=none");
    expect(store.loadRules).not.toHaveBeenCalled();
  });

  it("visualizzatore senza regole: mappa su tutti i layer; l'utente appare nell'header con Esci", async () => {
    const kc = user([ACC.viewerRole]); kc.logout = vi.fn();
    render(<Root cfg={cfg()} kc={kc} />);
    expect(await screen.findByTestId("app")).toHaveTextContent("perms=*");
    expect(store.loadRules).toHaveBeenCalledWith("http://localhost:3000/geoserver", kc, ACC);
  });

  it("senza ruoli abilitati: 'Accesso non configurato' con i ruoli letti dal token", async () => {
    render(<Root cfg={cfg()} kc={user(["boh", "altro"])} />);
    expect(await screen.findByText("Accesso non configurato")).toBeInTheDocument();
    expect(screen.getByText(/boh, altro/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(ACC.adminRole))).toBeInTheDocument();
    expect(screen.queryByTestId("app")).toBeNull();
  });

  it("utente senza ruoli: lo dice", async () => {
    render(<Root cfg={cfg()} kc={fakeKc({})} />);
    expect(await screen.findByText(/Ruoli letti dal token: nessuno/)).toBeInTheDocument();
  });

  it("regola per il ruolo: la mappa riceve solo quei layer", async () => {
    vi.mocked(store.loadRules).mockResolvedValue([{ role: "ops", layers: ["iride:a", "iride:b"], tools: ["info"] }]);
    render(<Root cfg={cfg()} kc={user(["ops"])} />);
    expect(await screen.findByTestId("app")).toHaveTextContent("perms=iride:a+iride:b");
  });

  it("errore nel leggere la configurazione: schermata dedicata per il visualizzatore", async () => {
    vi.mocked(store.loadRules).mockRejectedValue(new Error("HTTP 500"));
    render(<Root cfg={cfg()} kc={user([ACC.viewerRole])} />);
    expect(await screen.findByText("Configurazione non disponibile")).toBeInTheDocument();
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
  });

  it("tabelle mancanti: il visualizzatore usa la mappa, l'admin vede l'avviso con il workspace giusto", async () => {
    vi.mocked(store.loadRules).mockRejectedValue(new Error("Feature type test:role_rules unknown"));
    const acc = { ...ACC, workspace: "test" };
    const c = { ...cfg(), access: acc };
    const { unmount } = render(<Root cfg={c} kc={user([ACC.viewerRole])} />);
    expect(await screen.findByTestId("app")).toBeInTheDocument();
    unmount();
    at("/admin/roles");
    render(<Root cfg={c} kc={user([ACC.adminRole])} />);
    const adm = await screen.findByTestId("admin-roles");
    expect(adm).toHaveTextContent(/test:role_rules e test:dashboards/);
    expect(adm).toHaveTextContent(/workspace "test"/);
  });

  describe("pagine admin", () => {
    it("il visualizzatore non vi accede", async () => {
      at("/admin/roles");
      render(<Root cfg={cfg()} kc={user([ACC.viewerRole])} />);
      expect(await screen.findByText("Accesso negato")).toBeInTheDocument();
      expect(screen.queryByTestId("admin-roles")).toBeNull();
      expect(screen.queryByText("Admin")).toBeNull();
    });
    it("l'admin vede menu e pagine; l'elenco prodotti esclude le due tabelle di configurazione ma non il resto del workspace", async () => {
      vi.mocked(caps.fetchProducts).mockResolvedValue([
        { name: "mapp:role_rules", title: "r", workspace: "mapp" }, { name: "mapp:dashboards", title: "d", workspace: "mapp" },
        { name: "mapp:strade", title: "s", workspace: "mapp" }, { name: "iride:a", title: "a", workspace: "iride" },
      ]);
      at("/admin/roles");
      render(<Root cfg={cfg()} kc={user([ACC.adminRole])} />);
      expect(await screen.findByText("Ruoli e permessi")).toBeInTheDocument();
      expect(screen.getByText("Crea dashboard")).toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId("admin-roles")).toHaveTextContent("prodotti=mapp:strade,iride:a"));
    });
    it("/admin/dashboards apre l'editor delle dashboard", async () => {
      at("/admin/dashboards");
      render(<Root cfg={cfg()} kc={user([ACC.adminRole])} />);
      expect(await screen.findByTestId("admin-dash")).toBeInTheDocument();
    });
  });

  describe("dashboard", () => {
    const dashes = [
      { title: "Per viewer", description: "", roles: ["fss-etl-viewer"], widgets: [] },
      { title: "Solo ops", description: "", roles: ["ops"], widgets: [] },
    ];
    beforeEach(() => vi.mocked(store.loadDashboards).mockResolvedValue(dashes));

    it("il visualizzatore vede solo quelle assegnate al suo ruolo", async () => {
      at("/dashboards");
      render(<Root cfg={cfg()} kc={user([ACC.viewerRole])} />);
      expect(await screen.findByTestId("dash-list")).toHaveTextContent(/^Per viewer$/);
      expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    });
    it("l'admin le vede tutte", async () => {
      at("/dashboards");
      render(<Root cfg={cfg()} kc={user([ACC.adminRole])} />);
      expect(await screen.findByTestId("dash-list")).toHaveTextContent("Per viewer,Solo ops");
    });
    it("/d/<id> apre la dashboard", async () => {
      at("/d/7");
      render(<Root cfg={cfg()} kc={user([ACC.viewerRole])} />);
      expect(await screen.findByTestId("dash-view")).toHaveTextContent("7");
    });
    it("senza dashboard assegnate il menu Dashboard non compare", async () => {
      vi.mocked(store.loadDashboards).mockResolvedValue([dashes[1]]);
      render(<Root cfg={cfg()} kc={user([ACC.viewerRole])} />);
      await screen.findByTestId("app");
      expect(screen.getByRole("link", { name: "Mappa" })).toBeInTheDocument(); // il menu c'è, ma senza la voce Dashboard
      expect(screen.queryByRole("link", { name: "Dashboard" })).toBeNull();
    });
  });
});
