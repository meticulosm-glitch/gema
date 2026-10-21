import { useCallback, useEffect, useRef, useState } from "react";
import type Keycloak from "keycloak-js";
import type { AccessConfig } from "./config";
import type { Product } from "./capabilities";
import { isMissingTable } from "./configStore";
import { TOOLS } from "./roles";
import { LineChart } from "./Widgets";
import { loadUsage, type TopRow, type UsageReport } from "./usageStats";
import type { UsageMode } from "./usage";

const PERIODS = [7, 30, 90, 365];
const fmt = (n: number) => n.toLocaleString("it-IT");
const shortDay = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const TOOL_LABEL: Record<string, string> = {
  ...Object.fromEntries(TOOLS.map((t) => [t.id, t.label])),
  info: "Interroga oggetti", series: "Serie storica in un punto", coord: "Coordinate", length: "Misura distanza", area: "Misura area", export: "Stampa / esporta PNG",
};

/** Elenco con barre orizzontali: etichetta, barra proporzionale, valore (testo sempre nei colori del testo). */
function BarList({ title, rows, label = (t) => t || "(senza nome)", unit, empty, max = 10 }: {
  title: string; rows: TopRow[] | undefined; label?: (t: string) => string; unit: string; empty: string; max?: number;
}) {
  const list = (rows ?? []).slice(0, max);
  const top = Math.max(1, ...list.map((r) => r.events));
  return (
    <section className="us-card" aria-label={title}>
      <h2>{title}</h2>
      {list.length === 0 ? <div className="muted">{empty}</div> : (
        <ol className="us-bars">
          {list.map((r) => (
            <li key={r.target} title={`${label(r.target)}: ${fmt(r.events)} ${unit}, ${fmt(r.sessions)} sessioni`}>
              <span className="us-label">{label(r.target)}</span>
              <span className="us-track"><span className="us-fill" style={{ width: `${(r.events / top) * 100}%` }} /></span>
              <span className="us-val">{fmt(r.events)}</span>
            </li>
          ))}
        </ol>
      )}
      {(rows?.length ?? 0) > max && <div className="muted">e altri {rows!.length - max}</div>}
    </section>
  );
}

/** Admin → Statistiche d'uso. */
export default function AdminUsage({ gs, kc, acc, mode, products, dashboards }: {
  gs: string; kc: Keycloak; acc: AccessConfig; mode: UsageMode; products: Product[]; dashboards: { fid?: string; title: string }[];
}) {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const gen = useRef(0);
  const load = useCallback(async (d: number) => {
    const id = ++gen.current;
    setLoading(true);
    try { const r = await loadUsage(gs, kc, acc, d); if (gen.current === id) { setReport(r); setError(null); } }
    catch (e) {
      if (gen.current !== id) return;
      setReport(null);
      setError(isMissingTable(e)
        ? `Statistiche non disponibili: in GeoServer devono esistere ${acc.workspace}:usage_events e le viste usage_daily, usage_sessions, usage_roles, usage_users (riesegui il Job di configurazione).`
        : `Impossibile leggere le statistiche: ${(e as Error).message}`);
    } finally { if (gen.current === id) setLoading(false); }
  }, [gs, kc, acc]);
  useEffect(() => { void load(days); }, [load, days]);

  const title = new Map(products.map((p) => [p.name, p.title]));
  const layerLabel = (n: string) => (title.get(n) ? `${title.get(n)}` : n);
  const k = report?.byKind ?? {};
  const pages = k.page;
  const downloads = k.download;
  return (
    <div className="page-inner wide">
      <div className="page-title">
        <div>
          <h1>Statistiche d'uso</h1>
          <p className="muted">
            {mode === "off" ? "Raccolta spenta (USAGE_STATS=off): qui restano i dati già raccolti."
              : mode === "named" ? "Raccolta con il nome utente (USAGE_STATS=named)."
              : "Raccolta anonima: ruoli e sessione, senza nomi utente (USAGE_STATS=anonymous)."}
            {" "}Si contano pagine, layer accesi, strumenti, dashboard, scarichi, ricerche e viste salvate aperte; mai i contenuti.
          </p>
        </div>
        <div className="btn-row">
          <label className="us-period"><span>Periodo</span>
            <select aria-label="Periodo" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {PERIODS.map((p) => <option key={p} value={p}>{p === 365 ? "Ultimi 12 mesi" : `Ultimi ${p} giorni`}</option>)}
            </select>
          </label>
          <button className="btn-sm" disabled={loading} onClick={() => void load(days)}>Aggiorna</button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {loading && !report && <div className="empty">Caricamento…</div>}
      {report && (
        <>
          <div className="us-kpis" role="group" aria-label="Totali del periodo">
            <div className="us-kpi"><span className="k-value">{fmt(report.totals.sessions)}</span><span className="k-label">sessioni</span><span className="muted">somma per giorno</span></div>
            <div className="us-kpi"><span className="k-value">{mode === "named" || report.totals.users ? fmt(report.totals.users) : "—"}</span><span className="k-label">utenti</span><span className="muted">{mode === "named" || report.totals.users ? "diversi nel periodo" : "non raccolti (modalità anonima)"}</span></div>
            <div className="us-kpi"><span className="k-value">{fmt(report.totals.events)}</span><span className="k-label">azioni</span><span className="muted">{report.from.split("-").reverse().join("/")} – {report.to.split("-").reverse().join("/")}</span></div>
          </div>
          <section className="us-card us-wide" aria-label="Sessioni al giorno">
            <h2>Sessioni al giorno</h2>
            {report.totals.events === 0 ? <div className="muted">Nessun dato nel periodo.</div>
              : <LineChart items={report.days.map((d) => ({ key: d.day, label: shortDay(d.day), value: d.sessions }))} />}
          </section>
          <div className="us-grid">
            <BarList title="Layer accesi" rows={k.layer} label={layerLabel} unit="accensioni" empty="Nessun layer acceso." />
            <BarList title="Dashboard aperte" rows={k.dashboard} unit="aperture" empty="Nessuna dashboard aperta." label={(t) => t || "(senza titolo)"} />
            <BarList title="Strumenti" rows={k.tool} label={(t) => TOOL_LABEL[t] ?? t} unit="usi" empty="Nessuno strumento usato." />
            <BarList title="Pagine" rows={pages} unit="visite" empty="Nessuna pagina." />
            <BarList title="Scarichi" rows={downloads} label={layerLabel} unit="scarichi" empty="Nessuno scarico." />
            <BarList title="Ricerche" rows={k.search} label={(t) => (t === "luogo" ? "Luoghi" : t === "attributo" ? "Oggetti per attributo" : t)} unit="ricerche" empty="Nessuna ricerca." />
            <section className="us-card" aria-label="Per ruolo">
              <h2>Per ruolo</h2>
              {report.roles.length === 0 ? <div className="muted">Nessun dato.</div> : (
                <table className="us-table">
                  <thead><tr><th scope="col">Ruolo</th><th scope="col" className="num">Sessioni</th><th scope="col" className="num">Azioni</th></tr></thead>
                  <tbody>{report.roles.map((r) => <tr key={r.role}><td>{r.role}{r.role === acc.adminRole && <span className="muted"> (amministratori)</span>}</td><td className="num">{fmt(r.sessions)}</td><td className="num">{fmt(r.events)}</td></tr>)}</tbody>
                </table>
              )}
              <div className="muted">Chi ha più ruoli conta in ciascuno.</div>
            </section>
            {(mode === "named" || report.users.length > 0) && (
              <section className="us-card" aria-label="Utenti più attivi">
                <h2>Utenti più attivi</h2>
                {report.users.length === 0 ? <div className="muted">Nessun utente nel periodo.</div> : (
                  <table className="us-table">
                    <thead><tr><th scope="col">Utente</th><th scope="col" className="num">Giorni</th><th scope="col" className="num">Sessioni</th><th scope="col">Ultimo accesso</th></tr></thead>
                    <tbody>{report.users.slice(0, 20).map((u) => <tr key={u.username}><td>{u.username}</td><td className="num">{fmt(u.days)}</td><td className="num">{fmt(u.sessions)}</td><td>{u.last.split("-").reverse().join("/")}</td></tr>)}</tbody>
                  </table>
                )}
              </section>
            )}
            {(k.view?.length ?? 0) > 0 && <BarList title="Viste salvate aperte" rows={k.view} unit="aperture" empty="" label={() => "Viste salvate"} />}
          </div>
          {dashboards.length > 0 && (() => {
            const opened = new Set((k.dashboard ?? []).map((r) => r.target));
            const never = dashboards.filter((d) => !opened.has(d.title));
            return never.length > 0 ? <div className="notice">Dashboard mai aperte nel periodo: {never.map((d) => d.title).join(", ")}.</div> : null;
          })()}
        </>
      )}
    </div>
  );
}
