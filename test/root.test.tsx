// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import Root from "../src/Root";
import type { AppConfig } from "../src/config";
import { ACC, fakeKc } from "./support";

// le schermate pesanti (mappa, editor admin) si sostituiscono con segnaposto che espongono le props ricevute
vi.mock("../src/App", () => ({ default: (p: any) => <div data-testid="app">mappa perms={p.perms ? (p.perms.layers === "*" ? "*" : [...p.perms.layers].join("+")) : "none"} vista={JSON.stringify(p.startView ?? null)}{p.nav}{p.banner}</div> }));
vi.mock("../src/AdminRoles", () => ({ roleList: (_acc: unknown, rules: { role: string }[]) => rules.map((r) => r.role), default: (p: any) => <div data-testid="admin-roles">viste={String(p.roleViews?.length)} erroreViste={String(p.roleViewsError)} sfondi={p.basemaps?.map((b: any) => b.id).join("+")} store={String(p.storeError)} prodotti={p.products.map((x: any) => x.name).join(",")} titoli={p.products.map((x: any) => x.title).join(",")}</div> }));
vi.mock("../src/AdminDashboards", () => ({ default: (p: any) => <div data-testid="admin-dash">bozze={p.drafts ? p.drafts.map((d: any) => d.def.title).join(",") : "nessuna"} errore={String(p.draftsError)} viste={String(p.roleViews?.length)} zoom={String(p.mapStart?.zoom)}</div> }));
vi.mock("../src/AdminBackup", () => ({ default: (p: any) => <div data-testid="admin-backup">ws={p.acc.workspace}<button onClick={() => void p.onChanged()}>dopo ripristino</button></div> }));
vi.mock("../src/AdminChangeLog", () => ({ default: (p: any) => <div data-testid="admin-log">ws={p.acc.workspace}<button onClick={() => void p.onChanged()}>ricarica</button></div> }));
vi.mock("../src/AdminDiagnostics", () => ({ default: (p: any) => <div data-testid="admin-diag">gs={p.gs} ws={p.acc.workspace}</div> }));
vi.mock("../src/AdminForms", () => ({ default: (p: any) => <div data-testid="admin-forms">prodotti={p.products.map((x: any) => x.name).join(",")}</div> }));
vi.mock("../src/AdminCatalog", () => ({ default: (p: any) => <div data-testid="admin-catalog">errore={String(p.catalogError)} prodotti={p.products.map((x: any) => x.name).join(",")} cartelle={p.catalog.folders.map((f: any) => f.key).join(",")}</div> }));
vi.mock("../src/DashboardPages", () => ({
  DashboardList: (p: any) => <div data-testid="dash-list">{p.dashboards.map((d: any) => d.title).join(",")}</div>,
  DashboardView: (p: any) => <div data-testid="dash-view">{p.id}</div>,
}));
vi.mock("../src/capabilities", () => ({ fetchProducts: vi.fn() }));
vi.mock("../src/configStore", async (orig) => ({ ...(await orig<typeof import("../src/configStore")>()), loadRules: vi.fn(), loadDashboards: vi.fn(), loadCatalog: vi.fn(), loadRoleViews: vi.fn(), loadAnnouncements: vi.fn(), loadDashboardDrafts: vi.fn() }));
import * as store from "../src/configStore";
import * as caps from "../src/capabilities";

const cfg = (access = true): AppConfig => ({ apiUrl: "", geoserverUrl: "/geoserver", basemapTiles: "", mapCenter: [12, 42], mapZoom: 5, title: "App", access: access ? ACC : undefined });
const user = (roles: string[]) => fakeKc({ preferred_username: "pippo", resource_access: { mapp: { roles } } });
const at = (p: string) => window.history.replaceState(null, "", p);

beforeEach(() => {
  vi.mocked(store.loadRules).mockResolvedValue([]);
  vi.mocked(store.loadDashboards).mockResolvedValue([]);
  vi.mocked(caps.fetchProducts).mockResolvedValue([]);
  vi.mocked(store.loadCatalog).mockResolvedValue({ folders: [], layers: [] });
  vi.mocked(store.loadRoleViews).mockResolvedValue([]);
  vi.mocked(store.loadAnnouncements).mockResolvedValue([]);
  vi.mocked(store.loadDashboardDrafts).mockReset().mockResolvedValue([]);
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

  describe("avvisi", () => {
    const A = (message: string, extra: Record<string, unknown> = {}) => ({ fid: `announcements.${message.length}`, message, level: "info" as const, startsAt: "", endsAt: "", roles: [], dismissible: true, active: true, updatedAt: "2026-10-01T00:00:00Z", ...extra });
    it("banner sopra la mappa e nelle pagine, per ruolo; la chiusura si ricorda", async () => {
      vi.mocked(store.loadAnnouncements).mockResolvedValue([A("Per tutti"), A("Solo ops", { roles: ["ops"] }), A("Manutenzione!", { level: "maintenance", dismissible: false })]);
      const { unmount } = render(<Root cfg={cfg()} kc={user([ACC.viewerRole])} />);
      await screen.findByTestId("app");
      await waitFor(() => expect(screen.getAllByRole("alert").map((e) => e.textContent)).toEqual(["🛠Manutenzione: Manutenzione!"]));
      expect(screen.getByRole("status")).toHaveTextContent("Per tutti");
      expect(screen.queryByText("Solo ops")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Chiudi l'avviso" }));
      expect(screen.queryByText("Per tutti")).toBeNull();
      unmount();
      at("/dashboards");
      render(<Root cfg={cfg()} kc={user([ACC.viewerRole])} />);
      await screen.findByText("Manutenzione!");
      expect(screen.queryByText("Per tutti")).toBeNull(); // chiusura ricordata nel browser
      localStorage.clear();
    });
    it("/admin/announcements: pagina con gli avvisi e l'eventuale errore della tabella", async () => {
      vi.mocked(store.loadAnnouncements).mockRejectedValue(new Error("Feature type mapp:announcements unknown"));
      at("/admin/announcements");
      render(<Root cfg={cfg()} kc={user([ACC.adminRole])} />);
      expect(await screen.findByText(/Tabella degli avvisi non trovata: .*mapp:announcements/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Nuovo avviso" })).toBeDisabled();
    });
  });

  describe("vista iniziale per ruolo", () => {
    const views = [
      { role: ACC.viewerRole, bbox: [12, 41, 13, 42] as [number, number, number, number], basemap: "grigio", layers: ["iride:a"] },
      { role: "ops", bbox: [9, 45, 10, 46] as [number, number, number, number], basemap: "", layers: [] },
    ];
    it("la mappa riceve la vista dei ruoli dell'utente", async () => {
      vi.mocked(store.loadRoleViews).mockResolvedValue(views);
      render(<Root cfg={cfg()} kc={user([ACC.viewerRole, "ops"])} />);
      expect(await screen.findByTestId("app")).toHaveTextContent(`vista={"bbox":[9,41,13,46],"basemap":"grigio","layers":["iride:a"],"roles":["fss-etl-viewer","ops"]}`);
    });
    it("l'admin usa la vista globale", async () => {
      vi.mocked(store.loadRoleViews).mockResolvedValue(views);
      render(<Root cfg={cfg()} kc={user([ACC.adminRole, ACC.viewerRole])} />);
      expect(await screen.findByTestId("app")).toHaveTextContent("vista=null");
    });
    it("tabella mancante: la mappa si apre con la vista globale; la pagina Ruoli riceve l'avviso, gli sfondi e le viste", async () => {
      vi.mocked(store.loadRoleViews).mockRejectedValue(new Error("Feature type mapp:role_views unknown"));
      const { unmount } = render(<Root cfg={cfg()} kc={user([ACC.viewerRole])} />);
      expect(await screen.findByTestId("app")).toHaveTextContent("vista=null");
      unmount();
      at("/admin/roles");
      render(<Root cfg={cfg()} kc={user([ACC.adminRole])} />);
      const adm = await screen.findByTestId("admin-roles");
      expect(adm).toHaveTextContent(/erroreViste=Tabella delle viste iniziali non trovata: .*mapp:role_views/);
      expect(adm).toHaveTextContent("sfondi=osm+sat+dark+none");
      expect(adm).toHaveTextContent("store=null"); // le altre tabelle ci sono: niente errore generale
    });
    it("pagina Ruoli: riceve le viste salvate", async () => {
      vi.mocked(store.loadRoleViews).mockResolvedValue(views);
      at("/admin/roles");
      render(<Root cfg={cfg()} kc={user([ACC.adminRole])} />);
      expect(await screen.findByTestId("admin-roles")).toHaveTextContent("viste=2 erroreViste=null");
    });
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
      const menu = await screen.findByRole("button", { name: /^Admin.*Ruoli e permessi/ });
      expect(menu).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(menu);
      expect(screen.getAllByRole("link").map((a) => a.textContent).filter((t) => t !== "Mappa" && t !== "Dashboard")).toEqual(["Ruoli e permessi", "Catalogo prodotti", "Moduli di modifica", "Avvisi", "Crea dashboard", "Registro modifiche", "Statistiche d'uso", "Backup e ripristino", "Diagnostica"]);
      expect(screen.getByRole("link", { name: "Ruoli e permessi" })).toHaveClass("on");
      fireEvent.keyDown(document, { key: "Escape" });
      expect(menu).toHaveAttribute("aria-expanded", "false");
      await waitFor(() => expect(screen.getByTestId("admin-roles")).toHaveTextContent("prodotti=mapp:strade,iride:a"));
    });
    it("/admin/catalog: editor del catalogo con prodotti (senza tabelle di configurazione) e catalogo salvato", async () => {
      vi.mocked(caps.fetchProducts).mockResolvedValue([
        { name: "mapp:catalog_layers", title: "c", workspace: "mapp" }, { name: "iride:a", title: "a", workspace: "iride" },
      ]);
      vi.mocked(store.loadCatalog).mockResolvedValue({ folders: [{ key: "agri", parent: "", title: "Agricoltura", description: "", position: 0, expanded: false, hidden: false }], layers: [] });
      at("/admin/catalog");
      render(<Root cfg={cfg()} kc={user([ACC.adminRole])} />);
      expect(await screen.findByRole("button", { name: /^Admin.*Catalogo prodotti/ })).toHaveClass("on");
      const el = await screen.findByTestId("admin-catalog");
      expect(el).toHaveTextContent("errore=null prodotti=iride:a cartelle=agri");
      expect(store.loadCatalog).toHaveBeenCalledWith("http://localhost:3000/geoserver", expect.anything(), ACC);
    });
    it("/admin/catalog con le tabelle del catalogo mancanti: avviso con il workspace giusto", async () => {
      vi.mocked(store.loadCatalog).mockRejectedValue(new Error("Feature type mapp:catalog_folders unknown"));
      at("/admin/catalog");
      render(<Root cfg={cfg()} kc={user([ACC.adminRole])} />);
      expect(await screen.findByTestId("admin-catalog")).toHaveTextContent(/mapp:catalog_folders e mapp:catalog_layers/);
    });
    it("/admin/catalog senza l'elenco dei layer di GeoServer: errore (e niente modifiche), non un catalogo di layer 'dismessi'", async () => {
      vi.mocked(caps.fetchProducts).mockRejectedValue(new Error("HTTP 503"));
      at("/admin/catalog");
      render(<Root cfg={cfg()} kc={user([ACC.adminRole])} />);
      expect(await screen.findByTestId("admin-catalog")).toHaveTextContent(/Elenco dei layer di GeoServer non disponibile \(HTTP 503\)/);
    });
    it("/admin/catalog con un altro errore: lo riporta", async () => {
      vi.mocked(store.loadCatalog).mockRejectedValue(new Error("HTTP 502"));
      at("/admin/catalog");
      render(<Root cfg={cfg()} kc={user([ACC.adminRole])} />);
      expect(await screen.findByTestId("admin-catalog")).toHaveTextContent("Impossibile leggere il catalogo: HTTP 502");
    });
    it("pagine admin: i titoli dei layer sono quelli del catalogo", async () => {
      vi.mocked(caps.fetchProducts).mockResolvedValue([{ name: "iride:a", title: "a", workspace: "iride" }]);
      vi.mocked(store.loadCatalog).mockResolvedValue({ folders: [], layers: [{ layer: "iride:a", folder: "", position: 0, title: "Titolo catalogo", description: "", hidden: false, defaultOn: false }] });
      at("/admin/roles");
      render(<Root cfg={cfg()} kc={user([ACC.adminRole])} />);
      await waitFor(() => expect(screen.getByTestId("admin-roles")).toHaveTextContent("prodotti=iride:a titoli=Titolo catalogo"));
    });
    it("il visualizzatore non legge il catalogo da Root (lo fa la mappa)", async () => {
      render(<Root cfg={cfg()} kc={user([ACC.viewerRole])} />);
      await screen.findByTestId("app");
      expect(store.loadCatalog).not.toHaveBeenCalled();
    });
    it("/admin/forms apre la pagina dei moduli di modifica con i soli layer del catalogo applicato", async () => {
      vi.mocked(caps.fetchProducts).mockResolvedValue([{ name: "iride:a", title: "a", workspace: "iride" }]);
      at("/admin/forms");
      render(<Root cfg={cfg()} kc={user([ACC.adminRole])} />);
      expect(await screen.findByTestId("admin-forms")).toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId("admin-forms")).toHaveTextContent("prodotti=iride:a"));
      expect(screen.getByRole("button", { name: /^Admin.*Moduli di modifica/ })).toBeInTheDocument();
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

  describe("bozze delle dashboard", () => {
    it("lette solo per l'amministratore e passate alla pagina insieme a viste e inquadratura", async () => {
      vi.mocked(store.loadDashboardDrafts).mockResolvedValue([{ fid: "dashboard_drafts.1", dashboardId: "", def: { title: "Bozza", description: "", roles: [], widgets: [] } }]);
      at("/admin/dashboards");
      render(<Root cfg={cfg()} kc={user([ACC.adminRole])} />);
      expect(await screen.findByTestId("admin-dash")).toHaveTextContent("bozze=Bozza errore=null viste=0 zoom=5");
    });

    it("il visualizzatore non le chiede mai", async () => {
      render(<Root cfg={cfg()} kc={user([ACC.viewerRole])} />);
      await screen.findByTestId("app");
      expect(store.loadDashboardDrafts).not.toHaveBeenCalled();
    });

    it("tabella mancante: avviso e salvataggio diretto (nessuna bozza)", async () => {
      vi.mocked(store.loadDashboardDrafts).mockRejectedValue(new Error("Feature type mapp:dashboard_drafts unknown"));
      at("/admin/dashboards");
      render(<Root cfg={cfg()} kc={user([ACC.adminRole])} />);
      const el = await screen.findByTestId("admin-dash");
      expect(el).toHaveTextContent("bozze=nessuna");
      expect(el).toHaveTextContent(`deve esistere il layer ${ACC.workspace}:dashboard_drafts`);
    });

    it("altro errore: lo riporta, e si salva comunque in modo diretto", async () => {
      vi.mocked(store.loadDashboardDrafts).mockRejectedValue(new Error("HTTP 500"));
      at("/admin/dashboards");
      render(<Root cfg={cfg()} kc={user([ACC.adminRole])} />);
      expect(await screen.findByTestId("admin-dash")).toHaveTextContent("Impossibile leggere le bozze delle dashboard (HTTP 500)");
    });
  });

  it("/admin/diagnostics: pagina di diagnostica nel menu Admin", async () => {
    at("/admin/diagnostics");
    render(<Root cfg={cfg()} kc={user([ACC.adminRole])} />);
    expect(await screen.findByTestId("admin-diag")).toHaveTextContent(`gs=http://localhost:3000/geoserver ws=${ACC.workspace}`);
    fireEvent.click(screen.getByRole("button", { name: /Admin/ }));
    expect(screen.getByRole("link", { name: "Diagnostica" })).toHaveClass("on");
  });

  it("/admin/changes: registro modifiche; dopo un ripristino si ricarica la configurazione", async () => {
    at("/admin/changes");
    render(<Root cfg={cfg()} kc={user([ACC.adminRole])} />);
    expect(await screen.findByTestId("admin-log")).toHaveTextContent(`ws=${ACC.workspace}`);
    const before = vi.mocked(store.loadRules).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "ricarica" }));
    await waitFor(() => expect(vi.mocked(store.loadRules).mock.calls.length).toBe(before + 1));
    expect(store.loadAnnouncements).toHaveBeenCalledTimes(2);
  });

  it("/admin/backup: backup e ripristino; dopo un ripristino si ricarica la configurazione", async () => {
    at("/admin/backup");
    render(<Root cfg={cfg()} kc={user([ACC.adminRole])} />);
    expect(await screen.findByTestId("admin-backup")).toHaveTextContent(`ws=${ACC.workspace}`);
    const before = vi.mocked(store.loadRules).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "dopo ripristino" }));
    await waitFor(() => expect(vi.mocked(store.loadRules).mock.calls.length).toBe(before + 1));
  });
});
