import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type Keycloak from "keycloak-js";
import type { AccessConfig, AppConfig } from "./config";
import App from "./App";
import { Brand, PartnerLogos } from "./branding";
import AdminDashboards from "./AdminDashboards";
import AdminRoles, { roleList } from "./AdminRoles";
import AdminCatalog from "./AdminCatalog";
import AdminForms from "./AdminForms";
import AdminDiagnostics from "./AdminDiagnostics";
import AdminChangeLog from "./AdminChangeLog";
import AdminUsage from "./AdminUsage";
import AdminBackup from "./AdminBackup";
import { DashboardList, DashboardView } from "./DashboardPages";
import { fetchProducts, type Product } from "./capabilities";
import { dashId, isConfigLayer, isMissingTable, loadAnnouncements, loadCatalog, loadDashboardDrafts, loadDashboards, loadRoleViews, loadRules, type DashboardDef, type DashboardDraft } from "./configStore";
import { startViewFor, type RoleView } from "./roleView";
import { dismissKey, loadDismissed, storeDismissed, visibleAnnouncements, type Announcement } from "./announcements";
import AnnouncementBar from "./AnnouncementBar";
import { WidgetEnv } from "./Widgets";
import AdminAnnouncements from "./AdminAnnouncements";
import { resolveBasemaps } from "./basemaps";
import { EMPTY_CATALOG, applyCatalog, type Catalog } from "./catalog";
import { computePermissions, userRoles, type Permissions, type RoleRule } from "./roles";
import { Link, navigate, usePath } from "./router";
import { effectiveRoles, loadViewAs, storeViewAs } from "./viewAs";
import ViewAsBar from "./ViewAsBar";
import { startUsage, stopUsage, track } from "./usage";

/** Nome della pagina per le statistiche d'uso (senza id né parametri). */
export const pageName = (path: string) =>
  path === "/" ? "mappa" : path === "/dashboards" ? "elenco dashboard" : path.startsWith("/d/") ? "dashboard" : path.startsWith("/admin/") ? `admin ${path.slice(7).split("/")[0]}` : path.replace(/^\//, "");

const toAbsolute = (u: string) => new URL(u, window.location.origin).href.replace(/\/$/, "");

/** Pagine di amministrazione, nel menu "Admin" (si aggiungono qui). */
export const ADMIN_PAGES = [
  { to: "/admin/roles", label: "Ruoli e permessi" },
  { to: "/admin/catalog", label: "Catalogo prodotti" },
  { to: "/admin/forms", label: "Moduli di modifica" },
  { to: "/admin/announcements", label: "Avvisi" },
  { to: "/admin/dashboards", label: "Crea dashboard" },
  { to: "/admin/changes", label: "Registro modifiche" },
  { to: "/admin/usage", label: "Statistiche d'uso" },
  { to: "/admin/backup", label: "Backup e ripristino" },
  { to: "/admin/diagnostics", label: "Diagnostica" },
];

/** Menu "Admin": un pulsante con la pagina corrente e l'elenco a discesa (tastiera: Esc chiude). */
function AdminMenu({ path, viewRoles, onViewAs }: { path: string; viewRoles: string[]; onViewAs: (role: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = ADMIN_PAGES.find((p) => path === p.to || path.startsWith(p.to + "/"));
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [open]);
  return (
    <div className="nav-admin" ref={ref}>
      <button type="button" className={`nav-tag${current ? " on" : ""}`} aria-expanded={open} aria-controls="admin-menu" onClick={() => setOpen((o) => !o)}>
        <span>Admin</span>{current && <span className="nav-current">· {current.label}</span>}<span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="nav-menu" id="admin-menu">
          {ADMIN_PAGES.map((p) => <Link key={p.to} to={p.to} className={current?.to === p.to ? "on" : ""}>{p.label}</Link>)}
          {viewRoles.length > 0 && (
            <div className="nav-menu-group" role="group" aria-label="Visualizza come ruolo">
              <span className="nav-menu-title">Visualizza come ruolo</span>
              {viewRoles.map((r) => <button key={r} type="button" onClick={() => onViewAs(r)}>{r}</button>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Nav({ perms, path, showDash, viewRoles = [], onViewAs = () => {} }: { perms: Permissions; path: string; showDash: boolean; viewRoles?: string[]; onViewAs?: (role: string) => void }) {
  const on = (p: string) => (path === p || path.startsWith(p + "/") ? "on" : "");
  return (
    <nav className="nav" aria-label="Sezioni">
      <Link to="/" className={path === "/" ? "on" : ""}>Mappa</Link>
      {showDash && <Link to="/dashboards" className={on("/dashboards") || on("/d")}>Dashboard</Link>}
      {perms.admin && (
        <>
          <span className="nav-sep" aria-hidden="true" />
          <AdminMenu path={path} viewRoles={viewRoles} onViewAs={onViewAs} />
        </>
      )}
    </nav>
  );
}

function Page({ cfg, kc, nav, children, banner = null }: { cfg: AppConfig; kc: Keycloak; nav: ReactNode; children: ReactNode; banner?: ReactNode }) {
  return (
    <div className="app">
      <header className="header">
        <Brand cfg={cfg} />
        {nav}
        <div className="spacer" />
        <PartnerLogos cfg={cfg} />
        <span className="user">{String((kc.tokenParsed as any)?.preferred_username ?? "")}</span>
        <button className="btn" onClick={() => kc.logout()}>Esci</button>
      </header>
      {banner}
      <main className="page">{children}</main>
    </div>
  );
}

function Gate({ cfg, kc, acc }: { cfg: AppConfig; kc: Keycloak; acc: AccessConfig }) {
  const gs = useMemo(() => toAbsolute(cfg.geoserverUrl), [cfg.geoserverUrl]);
  const widgetEnv = useMemo(() => ({ basemaps: resolveBasemaps(cfg) }), [cfg]); // sfondi per le mini-mappe delle dashboard
  const path = usePath();
  const [rules, setRules] = useState<RoleRule[]>([]);
  const [dashboards, setDashboards] = useState<DashboardDef[]>([]);
  const [drafts, setDrafts] = useState<DashboardDraft[] | undefined>(undefined);
  const [draftsError, setDraftsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);       // impossibile leggere la configurazione
  const [storeError, setStoreError] = useState<string | null>(null); // tabelle non installate
  const [products, setProducts] = useState<Product[]>([]);
  const [productsReady, setProductsReady] = useState(false);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Catalog>(EMPTY_CATALOG);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogReady, setCatalogReady] = useState(false);
  const [roleViews, setRoleViews] = useState<RoleView[]>([]);
  const [roleViewsError, setRoleViewsError] = useState<string | null>(null);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [annError, setAnnError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());
  const [now, setNow] = useState(() => Date.now());

  // avvisi: letti all'avvio e ogni 5 minuti (così una manutenzione programmata arriva anche a chi ha la pagina aperta);
  // l'orologio scorre ogni minuto per far comparire e sparire gli avvisi programmati
  const loadAnn = useCallback(async () => {
    try { setAnnouncements(await loadAnnouncements(gs, kc, acc)); setAnnError(null); }
    catch (e) {
      setAnnouncements([]);
      setAnnError(isMissingTable(e)
        ? `Tabella degli avvisi non trovata: in GeoServer deve esistere il layer ${acc.workspace}:announcements (riesegui il Job di configurazione).`
        : `Impossibile leggere gli avvisi: ${(e as Error).message}`);
    }
  }, [gs, kc, acc]);
  useEffect(() => {
    void loadAnn();
    const poll = setInterval(() => void loadAnn(), 5 * 60_000);
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [loadAnn]);

  const load = useCallback(async () => {
    // viste iniziali per ruolo: se non si leggono (tabella non ancora creata) la mappa usa la vista globale
    const views = loadRoleViews(gs, kc, acc).then(
      (v) => { setRoleViews(v); setRoleViewsError(null); },
      (e) => {
        console.warn("[mapp] viste iniziali per ruolo non disponibili:", (e as Error)?.message ?? e);
        setRoleViews([]);
        setRoleViewsError(isMissingTable(e)
          ? `Tabella delle viste iniziali non trovata: in GeoServer deve esistere il layer ${acc.workspace}:role_views (riesegui il Job di configurazione). Finché manca, area, sfondo e layer accesi per ruolo non si possono salvare.`
          : `Impossibile leggere le viste iniziali dei ruoli: ${(e as Error).message}`);
      },
    );
    // bozze delle dashboard: solo per gli amministratori (GeoServer le nega agli altri ruoli). Tabella assente = si pubblica subito.
    const draftsP = userRoles(kc, acc).includes(acc.adminRole)
      ? loadDashboardDrafts(gs, kc, acc).then(
        (l) => { setDrafts(l); setDraftsError(null); },
        (e) => {
          setDrafts(undefined);
          setDraftsError(isMissingTable(e)
            ? `Bozze non disponibili: in GeoServer deve esistere il layer ${acc.workspace}:dashboard_drafts (riesegui il Job di configurazione). Finché manca, salvare una dashboard la pubblica subito.`
            : `Impossibile leggere le bozze delle dashboard (${(e as Error).message}): salvare una dashboard la pubblica subito.`);
        },
      )
      : Promise.resolve();
    try {
      const [r, d] = await Promise.all([loadRules(gs, kc, acc), loadDashboards(gs, kc, acc), views, draftsP]);
      setRules(r); setDashboards(d); setError(null); setStoreError(null);
    } catch (e) {
      if (isMissingTable(e)) {
        setRules([]); setDashboards([]); setError(null);
        setStoreError(`Tabelle di configurazione non trovate: in GeoServer devono esistere i layer ${acc.workspace}:role_rules e ${acc.workspace}:dashboards (esegui db/mapp-config.sql e pubblicali nel workspace "${acc.workspace}", con questi nomi esatti).`);
      } else {
        setError(`Impossibile leggere la configurazione dei ruoli: ${(e as Error).message}`);
      }
    } finally {
      setLoading(false);
    }
  }, [gs, kc, acc]);
  useEffect(() => { void load(); }, [load]);

  // catalogo prodotti: serve solo alle pagine admin (la mappa lo legge da sé). Tabelle assenti = catalogo vuoto, con avviso.
  const loadCat = useCallback(async () => {
    try {
      setCatalog(await loadCatalog(gs, kc, acc)); setCatalogError(null);
    } catch (e) {
      setCatalog(EMPTY_CATALOG);
      setCatalogError(isMissingTable(e)
        ? `Tabelle del catalogo non trovate: in GeoServer devono esistere i layer ${acc.workspace}:catalog_folders e ${acc.workspace}:catalog_layers (riesegui il Job di configurazione: mapp-config.sql e publish-geoserver.sh).`
        : `Impossibile leggere il catalogo: ${(e as Error).message}`);
    } finally {
      setCatalogReady(true);
    }
  }, [gs, kc, acc]);

  // «Visualizza come ruolo»: per un amministratore i ruoli effettivi possono essere quelli di un altro ruolo
  const [viewAs, setViewAsState] = useState<string | null>(() => loadViewAs());
  const tokenRoles = userRoles(kc, acc);
  const realAdmin = tokenRoles.includes(acc.adminRole);
  const activeViewAs = realAdmin && viewAs && viewAs !== acc.adminRole ? viewAs : null;
  const roles = effectiveRoles(tokenRoles, acc, activeViewAs);
  const setViewAs = (r: string | null, to?: string) => { storeViewAs(r); setViewAsState(r); if (to) navigate(to); };
  // l'admin vede la vista globale; gli altri quella dei propri ruoli (calcolata una volta: la mappa la legge all'avvio)
  const rolesKey = roles.join(",");
  const isAdmin = roles.includes(acc.adminRole);
  const shownAnn = visibleAnnouncements(announcements, roles, now, dismissed);
  const viewRoles = realAdmin ? roleList(acc, rules, dashboards) : [];
  const banner = (
    <>
    {activeViewAs && <ViewAsBar role={activeViewAs} roles={viewRoles} onChange={(r) => setViewAs(r)} onExit={() => setViewAs(null)} />}
    <AnnouncementBar
      items={shownAnn}
      onDismiss={(a) => setDismissed((d) => { const n = new Set(d); n.add(dismissKey(a)); storeDismissed(n); return n; })}
    />
    </>
  );
  const startView = useMemo(() => (isAdmin ? null : startViewFor(rolesKey.split(","), roleViews)), [isAdmin, rolesKey, roleViews]);
  const perms = computePermissions(roles, rules, acc);
  const visible = perms.admin ? dashboards : dashboards.filter((d) => d.roles.some((r) => roles.includes(r)));
  const adminPage = path.startsWith("/admin");

  // statistiche d'uso: una raccolta per pagina, spenta mentre l'amministratore guarda l'app come un altro ruolo
  const usageMode = cfg.usageStats ?? "anonymous";
  const tokenRolesKey = tokenRoles.join(",");
  useEffect(() => {
    if (usageMode === "off" || activeViewAs) return;
    startUsage({ gs, kc, acc, mode: usageMode, roles: tokenRolesKey ? tokenRolesKey.split(",") : [] });
    return () => stopUsage();
  }, [usageMode, activeViewAs, gs, kc, acc, tokenRolesKey]);
  const dashTitle = path.startsWith("/d/") ? visible.find((d) => dashId(d.fid) === path.slice(3))?.title : undefined;
  useEffect(() => {
    if (loading) return;
    track("page", pageName(path));
    if (dashTitle) track("dashboard", dashTitle, path.slice(3));
  }, [path, loading, dashTitle, activeViewAs]);

  useEffect(() => {
    if (!perms.admin || !adminPage || productsReady) return;
    fetchProducts(gs, kc.token)
      .then((l) => { setProducts(l.filter((p) => !isConfigLayer(acc, p.name))); setProductsError(null); })
      .catch((e) => { setProducts([]); setProductsError(`Elenco dei layer di GeoServer non disponibile (${(e as Error).message}): il catalogo non si può modificare finché non si legge.`); })
      .finally(() => setProductsReady(true));
  }, [perms.admin, adminPage, gs, kc, acc.workspace, productsReady]);
  useEffect(() => {
    if (perms.admin && adminPage && !catalogReady) void loadCat();
  }, [perms.admin, adminPage, catalogReady, loadCat]);

  const nav = <Nav perms={perms} path={path} showDash={visible.length > 0 || perms.admin} viewRoles={viewRoles} onViewAs={(r) => setViewAs(r, "/")} />;

  if (loading) return <Page cfg={cfg} kc={kc} banner={banner} nav={null}><div className="page-inner"><div className="empty">Caricamento…</div></div></Page>;
  if (error && !perms.admin) return <Page cfg={cfg} kc={kc} banner={banner} nav={null}><div className="page-inner"><h1>Configurazione non disponibile</h1><div className="error">{error}</div></div></Page>;
  if (perms.none) {
    return (
      <Page cfg={cfg} kc={kc} banner={banner} nav={null}>
        <div className="page-inner">
          <h1>Accesso non configurato</h1>
          {activeViewAs
            ? <p>Il ruolo <strong>{activeViewAs}</strong> non ha regole: chi ha solo questo ruolo non entra nell'applicazione. Le regole si danno in Ruoli e permessi.</p>
            : <p>Il tuo utente non ha un ruolo abilitato a questa applicazione.</p>}
          {!activeViewAs && <p className="muted">Ruoli letti dal token: {roles.length ? roles.join(", ") : "nessuno"}. Chiedi a un amministratore ({acc.adminRole}) di abilitare il tuo ruolo.</p>}
        </div>
      </Page>
    );
  }

  if (adminPage) {
    if (activeViewAs) return <Page cfg={cfg} kc={kc} banner={banner} nav={nav}><div className="page-inner"><h1>Pagina di amministrazione</h1><p>Stai vedendo l'applicazione come <strong>{activeViewAs}</strong>, che non ha accesso a questa pagina.</p><button className="btn-sm primary" onClick={() => setViewAs(null)}>Torna amministratore</button></div></Page>;
    if (!perms.admin) return <Page cfg={cfg} kc={kc} banner={banner} nav={nav}><div className="page-inner"><h1>Accesso negato</h1><p>Le pagine di amministrazione richiedono il ruolo <strong>{acc.adminRole}</strong>.</p></div></Page>;
    // nelle pagine admin i layer si chiamano come nel catalogo
    const common = { gs, kc, acc, rules, dashboards, products: applyCatalog(products, catalog), storeError: error ?? storeError, onChanged: load };
    const rolesProps = { ...common, roleViews, roleViewsError, basemaps: resolveBasemaps(cfg), mapStart: { center: cfg.mapCenter, zoom: cfg.mapZoom, bounds: cfg.mapBounds } };
    return (
      <Page cfg={cfg} kc={kc} banner={banner} nav={nav}>
        {path.startsWith("/admin/dashboards") ? <WidgetEnv.Provider value={widgetEnv}><AdminDashboards {...common} drafts={drafts} draftsError={draftsError} roleViews={roleViews} mapStart={rolesProps.mapStart} /></WidgetEnv.Provider>
          : path.startsWith("/admin/announcements") ? <AdminAnnouncements gs={gs} kc={kc} acc={acc} items={announcements} tableError={annError} knownRoles={roleList(acc, rules, dashboards)} onChanged={loadAnn} />
          : path.startsWith("/admin/backup") ? <AdminBackup gs={gs} kc={kc} acc={acc} products={common.products} onChanged={async () => { await load(); await loadAnn(); if (catalogReady) await loadCat(); }} />
          : path.startsWith("/admin/usage") ? <AdminUsage gs={gs} kc={kc} acc={acc} mode={usageMode} products={common.products} dashboards={dashboards} />
          : path.startsWith("/admin/changes") ? <AdminChangeLog gs={gs} kc={kc} acc={acc} onChanged={async () => { await load(); await loadAnn(); if (catalogReady) await loadCat(); }} />
          : path.startsWith("/admin/diagnostics") ? <AdminDiagnostics cfg={cfg} acc={acc} gs={gs} kc={kc} />
          : path.startsWith("/admin/forms") ? <AdminForms gs={gs} kc={kc} acc={acc} products={common.products} />
          : path.startsWith("/admin/catalog") ? (
            productsReady && catalogReady
              ? <AdminCatalog gs={gs} kc={kc} acc={acc} products={products} catalog={catalog} catalogError={catalogError ?? productsError} onChanged={loadCat} />
              : <div className="page-inner"><div className="empty">Caricamento…</div></div>
          )
          : <AdminRoles {...rolesProps} onViewAs={(r) => setViewAs(r, "/")} />}
      </Page>
    );
  }
  if (path === "/dashboards") return <Page cfg={cfg} kc={kc} banner={banner} nav={nav}><DashboardList dashboards={visible} /></Page>;
  if (path.startsWith("/d/")) return <Page cfg={cfg} kc={kc} banner={banner} nav={nav}><WidgetEnv.Provider value={widgetEnv}><DashboardView key={path} id={path.slice(3)} dashboards={visible} gs={gs} kc={kc} perms={perms} roleBbox={startView?.bbox} mapStart={{ center: cfg.mapCenter, zoom: cfg.mapZoom, bounds: cfg.mapBounds }} /></WidgetEnv.Provider></Page>;
  return <App key={`map|${activeViewAs ?? ""}`} cfg={cfg} kc={kc} perms={perms} nav={nav} startView={startView} banner={banner} />;
}

export default function Root({ cfg, kc }: { cfg: AppConfig; kc: Keycloak | null }) {
  const acc = cfg.access;
  if (!acc?.enabled || !kc) return <App cfg={cfg} kc={kc} />;
  return <Gate cfg={cfg} kc={kc} acc={acc} />;
}
