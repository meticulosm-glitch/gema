import { createContext, lazy, Suspense, useContext, useEffect, useMemo, useState } from "react";
import type Keycloak from "keycloak-js";
import { describeLayer, getWfsCount, getWfsFeatures, type Schema } from "./api";
import type { WidgetDef } from "./configStore";
import type { BasemapDef } from "./basemaps";
import { Markdown } from "./markdown";
import { GAUGE_LABEL, gaugeLevel, gaugeScale, periodKey, pieSlices, propsFor, tableRows } from "./widgetKinds";

/** Ambiente dei widget: gli sfondi per la mini-mappa (forniti dalla pagina che li mostra). */
export const WidgetEnv = createContext<{ basemaps: BasemapDef[] }>({ basemaps: [] });
// la mini-mappa (maplibre) si carica solo se una dashboard la usa
const WidgetMap = lazy(() => import("./WidgetMap"));

const MAX = 5000;
const NUMERIC = ["int", "integer", "long", "short", "byte", "double", "float", "decimal"];
export const isNum = (t: string) => NUMERIC.includes(t.toLowerCase());
export const isDate = (t: string) => t.toLowerCase().startsWith("date");
const fmt = (n: number) => n.toLocaleString("it-IT", { maximumFractionDigits: 2 });
const ident = (n: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : `"${n.replace(/"/g, '""')}"`);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
type Row = Record<string, unknown>;
export const andCql = (...p: (string | undefined)[]) => { const x = p.filter((c): c is string => !!c && !!c.trim()); return x.length === 1 ? x[0] : x.map((c) => `(${c})`).join(" AND "); };

export function aggregate(rows: Row[], agg: WidgetDef["agg"], valueField?: string): number {
  if (agg === "count" || !valueField) return rows.length;
  const nums = rows.map((r) => Number(r[valueField])).filter(Number.isFinite);
  if (nums.length === 0) return 0;
  switch (agg) {
    case "sum": return nums.reduce((a, b) => a + b, 0);
    case "avg": return nums.reduce((a, b) => a + b, 0) / nums.length;
    case "min": return Math.min(...nums);
    case "max": return Math.max(...nums);
  }
  return rows.length;
}

export interface Item { key: string; label: string; value: number; cql?: string }

export function buildItems(def: WidgetDef, rows: Row[]): Item[] {
  const f = def.field;
  if (!f) return [];
  if (def.type === "bar" || def.type === "pie") {
    const groups = new Map<string, Row[]>();
    for (const r of rows) { const k = r[f] === null || r[f] === undefined || r[f] === "" ? "\u0000" : String(r[f]); groups.set(k, [...(groups.get(k) ?? []), r]); }
    return [...groups.entries()]
      .map(([k, rs]): Item => k === "\u0000"
        ? { key: k, label: "(vuoto)", value: aggregate(rs, def.agg, def.valueField), cql: `${ident(f)} IS NULL` }
        : { key: k, label: k, value: aggregate(rs, def.agg, def.valueField), cql: `${ident(f)} = ${Number.isFinite(Number(k)) && typeof rs[0][f] === "number" ? k : lit(k)}` })
      .sort((a, b) => b.value - a.value).slice(0, def.type === "pie" ? undefined : 8);
  }
  if (def.type === "line") {
    const g = def.granularity ?? "month";
    const groups = new Map<string, Row[]>();
    for (const r of rows) { const k = periodKey(r[f], g); if (k) groups.set(k, [...(groups.get(k) ?? []), r]); }
    return [...groups.keys()].sort().slice(-400).map((k) => ({ key: k, label: k, value: aggregate(groups.get(k)!, def.agg, def.valueField) }));
  }
  if (def.type === "time") {
    const groups = new Map<string, Row[]>();
    for (const r of rows) { const s = String(r[f] ?? ""); if (/^\d{4}-\d{2}/.test(s)) groups.set(s.slice(0, 7), [...(groups.get(s.slice(0, 7)) ?? []), r]); }
    return [...groups.keys()].sort().slice(-36).map((k) => ({ key: k, label: k, value: aggregate(groups.get(k)!, def.agg, def.valueField) }));
  }
  if (def.type === "hist") {
    const nums = rows.map((r) => Number(r[f])).filter(Number.isFinite);
    if (nums.length === 0) return [];
    const min = Math.min(...nums), max = Math.max(...nums);
    const bins = min === max ? 1 : 10, w = (max - min) / bins || 1;
    const counts = new Array(bins).fill(0);
    for (const n of nums) counts[Math.min(bins - 1, Math.floor((n - min) / w))]++;
    return counts.map((c, i) => ({ key: String(i), label: fmt(min + i * w), value: c }));
  }
  return [];
}

/** Dati di un widget: WFS con i soli attributi necessari (al massimo 5000 oggetti). */
export function useWidgetData(def: WidgetDef, gs: string, kc: Keycloak | null, refresh = 0) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [capped, setCapped] = useState(false);
  const [total, setTotal] = useState<number | null>(null); // conteggio esatto dal server quando i dati sono troncati
  const sig = JSON.stringify([def.layer, def.field, def.valueField, def.cql, def.type, def.agg, def.columns, def.sortField]);
  const fetches = def.type !== "text" && def.type !== "map";
  useEffect(() => {
    let cancelled = false;
    if (!fetches) { setRows([]); setLoading(false); setError(null); return; }
    setLoading(true); setError(null);
    const t = setTimeout(async () => {
      try {
        if (!def.layer) throw new Error("layer non scelto");
        let props = propsFor(def);
        if (props.length === 0) props = [(await describeLayer(gs, kc, def.layer)).fields[0]?.name].filter(Boolean) as string[];
        const fs = await getWfsFeatures(gs, kc, def.layer, def.cql, MAX, props);
        if (cancelled) return;
        setRows(fs.map((f) => f.properties ?? {}));
        setCapped(fs.length >= MAX);
        setTotal(null);
        // oltre il limite il numero di oggetti lo dice GeoServer (resultType=hits), senza scaricarli
        if (fs.length >= MAX && def.agg === "count" && (def.type === "kpi" || def.type === "gauge")) {
          const n = await getWfsCount(gs, kc, def.layer, def.cql).catch(() => null);
          if (!cancelled) setTotal(n);
        }
      } catch (e) {
        if (!cancelled) { setRows([]); setError(String((e as Error).message)); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, gs, kc, refresh]);
  return { rows, loading, error, capped, total };
}

const cellText = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "number" ? fmt(v) : String(v));

/** Torta (ad anello): spicchi con 2px di stacco, legenda sempre visibile con valori e percentuali. */
function PieChart({ items, canOpen, onPick }: { items: Item[]; canOpen: boolean; onPick: (i: Item) => void }) {
  const slices = pieSlices(items);
  const total = slices.reduce((n, i) => n + i.value, 0);
  if (total <= 0) return null;
  const R = 60, r = 36, C = 70;
  let a0 = -Math.PI / 2;
  const arc = (from: number, to: number) => {
    const large = to - from > Math.PI ? 1 : 0;
    const p = (rad: number, rr: number) => `${C + rr * Math.cos(rad)} ${C + rr * Math.sin(rad)}`;
    if (to - from >= 2 * Math.PI - 1e-9) return `M ${p(from, R)} A ${R} ${R} 0 1 1 ${p(from + Math.PI, R)} A ${R} ${R} 0 1 1 ${p(from, R)} M ${p(from, r)} A ${r} ${r} 0 1 0 ${p(from + Math.PI, r)} A ${r} ${r} 0 1 0 ${p(from, r)} Z`;
    return `M ${p(from, R)} A ${R} ${R} 0 ${large} 1 ${p(to, R)} L ${p(to, r)} A ${r} ${r} 0 ${large} 0 ${p(from, r)} Z`;
  };
  const pct = (v: number) => `${((v / total) * 100).toLocaleString("it-IT", { maximumFractionDigits: 1 })}%`;
  return (
    <div className="pie">
      <svg viewBox="0 0 140 140" width="140" height="140" role="img" aria-label={`Torta: ${slices.map((s) => `${s.label} ${pct(s.value)}`).join(", ")}`}>
        {slices.map((sl, k) => {
          const a1 = a0 + (sl.value / total) * 2 * Math.PI;
          const d = arc(a0, a1);
          a0 = a1;
          const other = sl.key === "\u0001altri";
          return (
            <path key={sl.key} d={d} fillRule="evenodd" className={`pie-slice ${other ? "s-other" : `s${k + 1}`}${canOpen && sl.cql ? " clickable" : ""}`} onClick={() => canOpen && sl.cql && onPick(sl)}>
              <title>{`${sl.label}: ${fmt(sl.value)} (${pct(sl.value)})`}</title>
            </path>
          );
        })}
      </svg>
      <ul className="pie-legend">
        {slices.map((sl, k) => (
          <li key={sl.key}>
            <button className="pie-item" disabled={!canOpen || !sl.cql} onClick={() => onPick(sl)} title={sl.cql ? "Apri sulla mappa con questo filtro" : undefined}>
              <span className={`swatch ${sl.key === "\u0001altri" ? "s-other" : `s${k + 1}`}`} aria-hidden="true" />
              <span className="pie-label">{sl.label}</span>
              <span className="pie-val">{fmt(sl.value)} · {pct(sl.value)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Linea temporale: una linea da 2px, punti al passaggio del mouse, cursore verticale e valore. */
export function LineChart({ items }: { items: Item[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (items.length === 0) return null;
  const W = 600, H = 160, P = 6;
  const vals = items.map((i) => i.value);
  const lo = Math.min(0, ...vals), hi = Math.max(...vals, lo + 1);
  const x = (k: number) => (items.length === 1 ? W / 2 : P + (k * (W - 2 * P)) / (items.length - 1));
  const y = (v: number) => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P);
  const d = items.map((i, k) => `${k ? "L" : "M"} ${x(k).toFixed(1)} ${y(i.value).toFixed(1)}`).join(" ");
  const h = hover === null ? null : items[hover];
  return (
    <div className="line-wrap">
      <div className="cols-y"><span>{fmt(hi)}</span><span>{fmt(lo)}</span></div>
      <div className="line-plot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Linea: ${items.length} periodi, da ${items[0].label} a ${items[items.length - 1].label}`}
          onMouseMove={(e) => { const b = e.currentTarget.getBoundingClientRect(); const rel = (e.clientX - b.left) / b.width; setHover(Math.max(0, Math.min(items.length - 1, Math.round(rel * (items.length - 1))))); }}
          onMouseLeave={() => setHover(null)}>
          <line x1={0} x2={W} y1={y(0)} y2={y(0)} className="line-base" vectorEffect="non-scaling-stroke" />
          <path d={d} className="line-path" vectorEffect="non-scaling-stroke" />
          {items.length === 1 && <circle cx={x(0)} cy={y(items[0].value)} r={4} className="line-dot" />}
          {h && <line x1={x(hover!)} x2={x(hover!)} y1={0} y2={H} className="line-cross" vectorEffect="non-scaling-stroke" />}
        </svg>
        {h && (
          <>
            <span className="line-marker" style={{ left: `${(x(hover!) / W) * 100}%`, top: `${(y(h.value) / H) * 100}%` }} />
            <span className="line-tip" role="status" style={{ left: `${(x(hover!) / W) * 100}%`, transform: `translateX(${hover! / Math.max(1, items.length - 1) > 0.7 ? "-100%" : hover! / Math.max(1, items.length - 1) < 0.3 ? "0" : "-50%"})` }}><strong>{h.label}</strong> {fmt(h.value)}</span>
          </>
        )}
        <div className="line-axis"><span>{items[0].label}</span><span>{items[items.length - 1].label}</span></div>
      </div>
    </div>
  );
}

function TableWidget({ def, rows }: { def: WidgetDef; rows: Row[] }) {
  const shown = tableRows(rows, def);
  const cols = def.columns ?? [];
  return (
    <div className="w-table-wrap">
      <table className="w-table">
        <thead><tr>{cols.map((c) => <th key={c} scope="col">{c}{def.sortField === c ? (def.sortDesc ? " ▼" : " ▲") : ""}</th>)}</tr></thead>
        <tbody>
          {shown.map((r, k) => <tr key={k}>{cols.map((c) => <td key={c} className={typeof r[c] === "number" ? "num" : undefined}>{cellText(r[c])}</td>)}</tr>)}
        </tbody>
      </table>
      {rows.length > shown.length && <div className="muted">prime {shown.length} righe di {rows.length}</div>}
    </div>
  );
}

const LEVEL_ICON = { good: "✓", warning: "!", critical: "✕" } as const;
function Gauge({ def, value, unit }: { def: WidgetDef; value: number; unit: string }) {
  const level = gaugeLevel(value, def);
  const [lo, hi] = gaugeScale(value, def);
  const pos = (v: number) => `${Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100))}%`;
  return (
    <div className={`gauge g-${level}`}>
      <div className="kpi-big"><span className="k-value">{fmt(value)}</span><span className="k-label">{unit}</span></div>
      <div className="gauge-status"><span className="g-icon" aria-hidden="true">{LEVEL_ICON[level]}</span> {GAUGE_LABEL[level]}</div>
      <div className="gauge-track" role="meter" aria-valuemin={lo} aria-valuemax={hi} aria-valuenow={value} aria-valuetext={`${fmt(value)}: ${GAUGE_LABEL[level]}`}>
        <span className="gauge-fill" style={{ width: pos(value) }} />
        {Number.isFinite(def.warn) && <span className="gauge-tick t-warn" style={{ left: pos(def.warn!) }} title={`attenzione: ${fmt(def.warn!)}`} />}
        {Number.isFinite(def.crit) && <span className="gauge-tick t-crit" style={{ left: pos(def.crit!) }} title={`critico: ${fmt(def.crit!)}`} />}
      </div>
      <div className="gauge-scale"><span>{fmt(lo)}</span><span>soglie {fmt(def.warn ?? NaN)} / {fmt(def.crit ?? NaN)}</span><span>{fmt(hi)}</span></div>
    </div>
  );
}

export function WidgetCard({
  def: raw, gs, kc, refresh, canOpen, onOpenMap, filterCql = "", filterNote,
}: {
  def: WidgetDef; gs: string; kc: Keycloak | null; refresh?: number; canOpen: boolean; onOpenMap: (layer: string, cql: string) => void;
  filterCql?: string;  // filtri globali della dashboard (data, area), già in CQL
  filterNote?: string; // filtri globali che a questo widget non si applicano
}) {
  // il filtro del widget e quelli globali valgono insieme: dati, mini-mappa e "Apri sulla mappa"
  const def = useMemo(() => (filterCql ? { ...raw, cql: andCql(raw.cql, filterCql) } : raw), [raw, filterCql]);
  const { rows, loading, error, capped, total } = useWidgetData(def, gs, kc, refresh);
  const env = useContext(WidgetEnv);
  const items = useMemo(() => buildItems(def, rows), [def, rows]);
  const max = Math.max(1, ...items.map((i) => i.value));
  const unit = def.agg === "count" || !def.valueField ? "oggetti" : `${def.agg} ${def.valueField}`;
  const kpi = total ?? aggregate(rows, def.agg, def.valueField);
  const charts = ["bar", "pie", "hist", "time", "line"].includes(def.type);

  return (
    <section className={`widget w${def.w} wt-${def.type}`} aria-busy={loading}>
      <header className="widget-head">
        <h3>{def.title || (def.type === "text" ? "" : "(senza titolo)")}</h3>
        {def.type !== "text" && (
          <button className="link" disabled={!canOpen || !def.layer} title={canOpen ? "Apri il layer sulla mappa con il filtro del widget" : "Layer non disponibile per il tuo ruolo"} onClick={() => onOpenMap(def.layer, def.cql ?? "")}>
            Apri sulla mappa
          </button>
        )}
      </header>
      {error && <div className="error">{error}</div>}
      {!error && def.type === "kpi" && (
        <div className="kpi-big">
          <span className="k-value">{loading && rows.length === 0 ? "…" : `${fmt(kpi)}${capped && def.agg === "count" && total === null ? "+" : ""}`}</span>
          <span className="k-label">{unit}</span>
        </div>
      )}
      {!error && def.type === "gauge" && (loading && rows.length === 0 ? <div className="kpi-big"><span className="k-value">…</span></div> : <Gauge def={def} value={kpi} unit={unit} />)}
      {!error && def.type === "bar" && (
        <div className="bars">
          {items.map((i) => (
            <button key={i.key} className="bar-row" disabled={!canOpen || !i.cql} title={`${i.label}: ${fmt(i.value)}`} onClick={() => i.cql && onOpenMap(def.layer, andCql(def.cql, i.cql))}>
              <span className="bar-label">{i.label}</span>
              <span className="bar-track">
                <span className="bar-fill" style={{ width: `calc((100% - 56px) * ${i.value / max})` }} />
                <span className="bar-val">{fmt(i.value)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {!error && def.type === "pie" && <PieChart items={items} canOpen={canOpen} onPick={(i) => i.cql && onOpenMap(def.layer, andCql(def.cql, i.cql))} />}
      {!error && def.type === "line" && <LineChart items={items} />}
      {!error && (def.type === "hist" || def.type === "time") && items.length > 0 && (
        <div className="cols-wrap">
          <div className="cols-y"><span>{fmt(max)}</span><span>0</span></div>
          <div className="cols">
            {items.map((i, idx) => (
              <span key={i.key} className="col" title={`${i.label}: ${fmt(i.value)}`}>
                <span className="col-fill" style={{ height: `${Math.max(2, (i.value / max) * 100)}%` }} />
                {(idx === 0 || idx === items.length - 1) && <span className="col-axis">{i.label}</span>}
              </span>
            ))}
          </div>
        </div>
      )}
      {!error && def.type === "table" && !loading && <TableWidget def={def} rows={rows} />}
      {def.type === "text" && <Markdown text={def.text ?? ""} />}
      {def.type === "map" && (
        <Suspense fallback={<div className="w-map muted">Caricamento della mappa…</div>}>
          <WidgetMap def={def} gs={gs} kc={kc} basemaps={env.basemaps} refresh={refresh ?? 0} />
        </Suspense>
      )}
      {!error && !loading && charts && items.length === 0 && <div className="empty">Nessun dato.</div>}
      {!error && !loading && def.type === "table" && rows.length === 0 && <div className="empty">Nessun dato.</div>}
      {capped && <div className="muted">calcolato sui primi {MAX} oggetti</div>}
      {filterNote && <div className="muted w-filter-note">{filterNote}</div>}
    </section>
  );
}

export function fieldsOf(schema: Schema | null) { return schema?.fields ?? []; }
