import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type Keycloak from "keycloak-js";
import type { AccessConfig, AppConfig } from "./config";
import App from "./App";
import { Brand, PartnerLogos } from "./branding";
import AdminDashboards from "./AdminDashboards";
import AdminRoles from "./AdminRoles";
import { DashboardList, DashboardView } from "./DashboardPages";
import { fetchProducts, type Product } from "./capabilities";
import { isConfigLayer, isMissingTable, loadDashboards, loadRules, type DashboardDef } from "./configStore";
import { computePermissions, userRoles, type Permissions, type RoleRule } from "./roles";
import { Link, usePath } from "./router";

const toAbsolute = (u: string) => new URL(u, window.location.origin).href.replace(/\/$/, "");

function Nav({ perms, path, showDash }: { perms: Permissions; path: string; showDash: boolean }) {
  const on = (p: string) => (path === p || path.startsWith(p + "/") ? "on" : "");
  return (
    <nav className="nav" aria-label="Sezioni">
      <Link to="/" className={path === "/" ? "on" : ""}>Mappa</Link>
      {showDash && <Link to="/dashboards" className={on("/dashboards") || on("/d")}>Dashboard</Link>}
      {perms.admin && (
        <>
          <span className="nav-sep" aria-hidden="true" />
          <span className="nav-tag">Admin</span>
          <Link to="/admin/roles" className={on("/admin/roles")}>Ruoli e permessi</Link>
          <Link to="/admin/dashboards" className={on("/admin/dashboards")}>Crea dashboard</Link>
        </>
      )}
    </nav>
  );
}

function Page({ cfg, kc, nav, children }: { cfg: AppConfig; kc: Keycloak; nav: ReactNode; children: ReactNode }) {
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
      <main className="page">{children}</main>
    </div>
  );
}

function Gate({ cfg, kc, acc }: { cfg: AppConfig; kc: Keycloak; acc: AccessConfig }) {
  const gs = useMemo(() => toAbsolute(cfg.geoserverUrl), [cfg.geoserverUrl]);
  const path = usePath();
  const [rules, setRules] = useState<RoleRule[]>([]);
  const [dashboards, setDashboards] = useState<DashboardDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);       // impossibile leggere la configurazione
  const [storeError, setStoreError] = useState<string | null>(null); // tabelle non installate
  const [products, setProducts] = useState<Product[]>([]);

  const load = useCallback(async () => {
    try {
      const [r, d] = await Promise.all([loadRules(gs, kc, acc), loadDashboards(gs, kc, acc)]);
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

  const roles = userRoles(kc, acc);
  const perms = computePermissions(roles, rules, acc);
  const visible = perms.admin ? dashboards : dashboards.filter((d) => d.roles.some((r) => roles.includes(r)));
  const adminPage = path.startsWith("/admin");

  useEffect(() => {
    if (!perms.admin || !adminPage || products.length > 0) return;
    fetchProducts(gs, kc.token).then((l) => setProducts(l.filter((p) => !isConfigLayer(acc, p.name)))).catch(() => setProducts([]));
  }, [perms.admin, adminPage, gs, kc, acc.workspace, products.length]);

  const nav = <Nav perms={perms} path={path} showDash={visible.length > 0 || perms.admin} />;

  if (loading) return <Page cfg={cfg} kc={kc} nav={null}><div className="page-inner"><div className="empty">Caricamento…</div></div></Page>;
  if (error && !perms.admin) return <Page cfg={cfg} kc={kc} nav={null}><div className="page-inner"><h1>Configurazione non disponibile</h1><div className="error">{error}</div></div></Page>;
  if (perms.none) {
    return (
      <Page cfg={cfg} kc={kc} nav={null}>
        <div className="page-inner">
          <h1>Accesso non configurato</h1>
          <p>Il tuo utente non ha un ruolo abilitato a questa applicazione.</p>
          <p className="muted">Ruoli letti dal token: {roles.length ? roles.join(", ") : "nessuno"}. Chiedi a un amministratore ({acc.adminRole}) di abilitare il tuo ruolo.</p>
        </div>
      </Page>
    );
  }

  if (adminPage) {
    if (!perms.admin) return <Page cfg={cfg} kc={kc} nav={nav}><div className="page-inner"><h1>Accesso negato</h1><p>Le pagine di amministrazione richiedono il ruolo <strong>{acc.adminRole}</strong>.</p></div></Page>;
    const common = { gs, kc, acc, rules, dashboards, products, storeError: error ?? storeError, onChanged: load };
    return (
      <Page cfg={cfg} kc={kc} nav={nav}>
        {path.startsWith("/admin/dashboards") ? <AdminDashboards {...common} /> : <AdminRoles {...common} />}
      </Page>
    );
  }
  if (path === "/dashboards") return <Page cfg={cfg} kc={kc} nav={nav}><DashboardList dashboards={visible} /></Page>;
  if (path.startsWith("/d/")) return <Page cfg={cfg} kc={kc} nav={nav}><DashboardView id={path.slice(3)} dashboards={visible} gs={gs} kc={kc} perms={perms} /></Page>;
  return <App key="map" cfg={cfg} kc={kc} perms={perms} nav={nav} />;
}

export default function Root({ cfg, kc }: { cfg: AppConfig; kc: Keycloak | null }) {
  const acc = cfg.access;
  if (!acc?.enabled || !kc) return <App cfg={cfg} kc={kc} />;
  return <Gate cfg={cfg} kc={kc} acc={acc} />;
}
