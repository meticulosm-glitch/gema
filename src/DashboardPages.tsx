import { useState } from "react";
import type Keycloak from "keycloak-js";
import type { DashboardDef } from "./configStore";
import { dashId } from "./configStore";
import { layerAllowed, type Permissions } from "./roles";
import { Link, navigate } from "./router";
import { WidgetCard } from "./Widgets";

const mapLink = (layer: string, cql: string) => `/#s=${encodeURIComponent(JSON.stringify({ l: [[layer, 1, cql, ""]] }))}`;

export function DashboardList({ dashboards }: { dashboards: DashboardDef[] }) {
  return (
    <div className="page-inner">
      <h1>Dashboard</h1>
      {dashboards.length === 0 && <div className="empty">Nessuna dashboard disponibile per i tuoi ruoli.</div>}
      <div className="cards">
        {dashboards.map((d) => (
          <Link key={d.fid} to={`/d/${dashId(d.fid)}`} className="card-link">
            <strong>{d.title}</strong>
            <span className="muted">{d.description || `${d.widgets.length} widget`}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function DashboardView({ id, dashboards, gs, kc, perms }: { id: string; dashboards: DashboardDef[]; gs: string; kc: Keycloak; perms: Permissions }) {
  const d = dashboards.find((x) => dashId(x.fid) === id);
  const [refresh, setRefresh] = useState(0);
  if (!d) return <div className="page-inner"><h1>Dashboard non trovata</h1><div className="empty">Non esiste, oppure non è assegnata ai tuoi ruoli. <Link to="/dashboards">Torna all'elenco</Link></div></div>;
  return (
    <div className="page-inner wide">
      <div className="page-title">
        <div><h1>{d.title}</h1>{d.description && <p className="muted">{d.description}</p>}</div>
        <button className="btn-sm" onClick={() => setRefresh((n) => n + 1)}>Aggiorna dati</button>
      </div>
      <div className="dash-grid">
        {d.widgets.map((w) => (
          <WidgetCard key={w.id} def={w} gs={gs} kc={kc} refresh={refresh} canOpen={layerAllowed(perms, w.layer)} onOpenMap={(layer, cql) => navigate(mapLink(layer, cql))} />
        ))}
      </div>
    </div>
  );
}
