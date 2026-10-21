import { lazy, Suspense, useContext, useEffect, useState } from "react";
import type Keycloak from "keycloak-js";
import { describeLayer } from "./api";
import { DATE_PRESETS, initialState, presetRange, stateToSearch, widgetFilter, type DashFilters, type DatePreset, type FilterState } from "./dashFilters";
import { formatBbox, type Bbox } from "./roleView";
import type { DashboardDef } from "./configStore";
import { dashId } from "./configStore";
import { layerAllowed, type Permissions } from "./roles";
import { Link, navigate } from "./router";
import { WidgetCard, WidgetEnv } from "./Widgets";

const BboxPicker = lazy(() => import("./BboxPicker"));
export interface MapStart { center: [number, number]; zoom: number; bounds?: number[] }

/** Barra dei filtri globali: date (con scorciatoie) e area (scelta sulla mappa o quella del proprio ruolo). */
function FilterBar({ f, state, onChange, roleBbox, mapStart }: { f: DashFilters; state: FilterState; onChange: (s: FilterState) => void; roleBbox?: Bbox; mapStart: MapStart }) {
  const env = useContext(WidgetEnv);
  const [picking, setPicking] = useState(false);
  const preset = DATE_PRESETS.find((p) => { const r = presetRange(p.id); return r.from === state.from && r.to === state.to; })?.id ?? "custom";
  const def = presetRange(f.date?.preset);
  const isDefault = state.from === def.from && state.to === def.to && !state.bbox;
  return (
    <div className="dash-filters" role="group" aria-label="Filtri della dashboard">
      {f.date && (
        <div className="df-group">
          <span className="df-label">Periodo</span>
          <select aria-label="Periodo" value={preset} onChange={(e) => { if (e.target.value !== "custom") onChange({ ...state, ...presetRange(e.target.value as DatePreset) }); }}>
            {DATE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            <option value="custom" disabled>Personalizzato</option>
          </select>
          <label className="df-date"><span>dal</span><input type="date" aria-label="Dal" value={state.from} onChange={(e) => onChange({ ...state, from: e.target.value })} /></label>
          <label className="df-date"><span>al</span><input type="date" aria-label="Al" value={state.to} onChange={(e) => onChange({ ...state, to: e.target.value })} /></label>
        </div>
      )}
      {f.area && (
        <div className="df-group">
          <span className="df-label">Area</span>
          <span className="df-area" aria-live="polite">{state.bbox ? formatBbox(state.bbox).split(",").map((n) => Number(n).toFixed(2)).join(", ") : "tutta"}</span>
          <button className="btn-sm" onClick={() => setPicking((p) => !p)} aria-expanded={picking}>{picking ? "Chiudi la mappa" : "Scegli sulla mappa"}</button>
          {roleBbox && <button className="btn-sm" onClick={() => onChange({ ...state, bbox: roleBbox })}>La mia area</button>}
          {state.bbox && <button className="btn-sm" onClick={() => onChange({ ...state, bbox: undefined })}>Tutta l'area</button>}
        </div>
      )}
      {!isDefault && <button className="btn-sm df-reset" onClick={() => onChange({ ...def })}>Ripristina</button>}
      {picking && (
        <div className="df-picker">
          <Suspense fallback={<div className="muted">Caricamento della mappa…</div>}>
            <BboxPicker basemaps={env.basemaps} initial={state.bbox} start={mapStart}
              onPick={(b) => { onChange({ ...state, bbox: b }); setPicking(false); }} onCancel={() => setPicking(false)} />
          </Suspense>
        </div>
      )}
    </div>
  );
}

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

/**
 * Contenuto di una dashboard: barra dei filtri e widget. Lo usano la pagina della dashboard (con lo stato dei filtri
 * nell'indirizzo) e l'anteprima della pagina admin (`preview`: stato solo locale, nessun salto alla mappa).
 */
export function DashboardBody({
  d, gs, kc, perms, roleBbox, mapStart = { center: [12.5, 42], zoom: 5 }, refresh = 0, preview = false,
}: { d: DashboardDef; gs: string; kc: Keycloak | null; perms: Permissions; roleBbox?: Bbox; mapStart?: MapStart; refresh?: number; preview?: boolean }) {
  const [state, setState] = useState<FilterState>(() => initialState(d.filters, preview ? "" : window.location.search));
  const [geoms, setGeoms] = useState<Record<string, string | undefined>>({});
  // il filtro per area serve la colonna geometrica di ogni layer (i raster non ce l'hanno: restano senza filtro)
  const layersKey = Array.from(new Set(d.widgets.map((w) => w.layer).filter(Boolean))).sort().join("|");
  const area = !!d.filters?.area;
  useEffect(() => {
    if (!area || !layersKey) return;
    let off = false;
    const layers = layersKey.split("|");
    void Promise.all(layers.map((l) => describeLayer(gs, kc, l).then((s) => [l, s.geomName] as const, () => [l, undefined] as const)))
      .then((pairs) => { if (!off) setGeoms(Object.fromEntries(pairs)); });
    return () => { off = true; };
  }, [area, layersKey, gs, kc]);
  // lo stato dei filtri resta nell'indirizzo: ricaricare o condividere il link riapre la stessa vista
  useEffect(() => {
    if (preview || !d.filters) return;
    const search = stateToSearch(d.filters, state, window.location.search);
    if (search !== window.location.search) window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}`);
  }, [d.filters, state, preview]);
  const geomsReady = !area || (layersKey ? layersKey.split("|") : []).every((l) => l in geoms);
  return (
    <>
      {d.filters && <FilterBar f={d.filters} state={state} onChange={setState} roleBbox={roleBbox} mapStart={mapStart} />}
      <div className="dash-grid">
        {d.widgets.map((w) => {
          const flt = widgetFilter(w.layer, d.filters, state, (l) => geoms[l]);
          const note = flt.skipped.length && geomsReady ? `Non filtrato per ${flt.skipped.join(" e ")}: il layer non ha ${flt.skipped.map((x) => (x === "data" ? "un campo data indicato" : "una geometria")).join(" né ")}.` : undefined;
          return (
            <WidgetCard key={w.id} def={w} gs={gs} kc={kc} refresh={refresh} canOpen={!preview && layerAllowed(perms, w.layer)} filterCql={flt.cql} filterNote={note}
              onOpenMap={(layer, cql) => navigate(mapLink(layer, cql))} />
          );
        })}
      </div>
    </>
  );
}

export function DashboardView({
  id, dashboards, gs, kc, perms, roleBbox, mapStart,
}: { id: string; dashboards: DashboardDef[]; gs: string; kc: Keycloak; perms: Permissions; roleBbox?: Bbox; mapStart?: MapStart }) {
  const d = dashboards.find((x) => dashId(x.fid) === id);
  const [refresh, setRefresh] = useState(0);
  if (!d) return <div className="page-inner"><h1>Dashboard non trovata</h1><div className="empty">Non esiste, oppure non è assegnata ai tuoi ruoli. <Link to="/dashboards">Torna all'elenco</Link></div></div>;
  return (
    <div className="page-inner wide">
      <div className="page-title">
        <div><h1>{d.title}</h1>{d.description && <p className="muted">{d.description}</p>}</div>
        <button className="btn-sm" onClick={() => setRefresh((n) => n + 1)}>Aggiorna dati</button>
      </div>
      <DashboardBody d={d} gs={gs} kc={kc} perms={perms} roleBbox={roleBbox} mapStart={mapStart} refresh={refresh} />
    </div>
  );
}
