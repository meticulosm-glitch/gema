import { useEffect, useMemo, useState } from "react";
import type * as maplibregl from "maplibre-gl";
import type Keycloak from "keycloak-js";
import { describeLayer, getWfsFeatures, type Schema } from "./api";

/** Selezione fatta cliccando un grafico: diventa un filtro CQL sul layer (mappa e tabella). */
export interface DashSel { field: string; cql: string; label: string; key: string }

const NUMERIC = ["int", "integer", "long", "short", "byte", "double", "float", "decimal"];
const MAX_FEATURES = 5000;
const TOP = 12;

type Kind = "num" | "date" | "cat";
const kindOf = (t: string): Kind => {
  const x = t.toLowerCase();
  return NUMERIC.includes(x) ? "num" : x.startsWith("date") ? "date" : "cat";
};
const ident = (n: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : `"${n.replace(/"/g, '""')}"`);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const fmt = (n: number) => n.toLocaleString("it-IT", { maximumFractionDigits: 2 });
const pct = (n: number, tot: number) => (tot ? `${((n / tot) * 100).toFixed(1)}%` : "");

function nextMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

interface Item { key: string; label: string; tip?: string; value: number; cql?: string; selLabel?: string }

interface Tip { x: number; y: number; label: string; value: number; share: string }

const BAR_RESERVE = 56; // spazio a destra della barra più lunga, per il valore

function useTip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const show = (e: { clientX: number; clientY: number }, i: Item, total: number) =>
    setTip({ x: e.clientX, y: e.clientY, label: i.tip ?? i.label, value: i.value, share: pct(i.value, total) });
  const showFocus = (el: HTMLElement, i: Item, total: number) => {
    const r = el.getBoundingClientRect();
    setTip({ x: r.left + r.width / 2, y: r.top, label: i.tip ?? i.label, value: i.value, share: pct(i.value, total) });
  };
  return { tip, show, showFocus, hide: () => setTip(null) };
}

function TipBox({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  const left = Math.min(tip.x + 14, window.innerWidth - 290);
  const top = Math.max(8, Math.min(tip.y + 14, window.innerHeight - 70));
  return (
    <div className="viz-tip" role="status" style={{ left, top }}>
      <strong><span className="key" />{fmt(tip.value)}{tip.share ? ` · ${tip.share}` : ""}</strong>
      <span className="muted">{tip.label}</span>
    </div>
  );
}

function Bars({ items, total, selKey, hasSel, onPick }: {
  items: Item[]; total: number; selKey?: string; hasSel: boolean; onPick: (i: Item) => void;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const { tip, show, showFocus, hide } = useTip();
  return (
    <div className="bars">
      {items.map((i) => {
        const on = hasSel && selKey === i.key;
        return (
          <button
            key={i.key}
            className={`bar-row${on ? " on" : ""}${hasSel && !on ? " dim" : ""}`}
            disabled={!i.cql}
            aria-pressed={on}
            aria-label={`${i.label}: ${i.value}`}
            onClick={() => onPick(i)}
            onPointerMove={(e) => show(e, i, total)}
            onPointerLeave={hide}
            onFocus={(e) => showFocus(e.currentTarget, i, total)}
            onBlur={hide}
          >
            <span className="bar-label" title={i.label}>{i.label}</span>
            <span className="bar-track">
              <span className="bar-fill" style={{ width: `calc((100% - ${BAR_RESERVE}px) * ${i.value / max})` }} />
              <span className="bar-val">{fmt(i.value)}</span>
            </span>
          </button>
        );
      })}
      <TipBox tip={tip} />
    </div>
  );
}

function Columns({ items, total, selKey, hasSel, onPick }: {
  items: Item[]; total: number; selKey?: string; hasSel: boolean; onPick: (i: Item) => void;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const last = items.length - 1;
  const maxIdx = items.findIndex((i) => i.value === max);
  const { tip, show, showFocus, hide } = useTip();
  return (
    <div className="cols-wrap">
      <div className="cols-y"><span>{fmt(max)}</span><span>0</span></div>
      <div className="cols">
        {items.map((i, idx) => {
          const on = hasSel && selKey === i.key;
          const h = Math.max(2, (i.value / max) * 100);
          const showAxis = idx === 0 || idx === last || (items.length > 6 && idx === Math.floor(last / 2));
          return (
            <button
              key={i.key}
              className={`col${on ? " on" : ""}${hasSel && !on ? " dim" : ""}`}
              aria-pressed={on}
              aria-label={`${i.tip ?? i.label}: ${i.value}`}
              onClick={() => onPick(i)}
              onPointerMove={(e) => show(e, i, total)}
              onPointerLeave={hide}
              onFocus={(e) => showFocus(e.currentTarget, i, total)}
              onBlur={hide}
            >
              {idx === maxIdx && <span className="col-cap" style={{ bottom: `calc(${h}% + 2px)` }}>{fmt(i.value)}</span>}
              <span className="col-fill" style={{ height: `${h}%` }} />
              {showAxis && <span className="col-axis">{i.label}</span>}
            </button>
          );
        })}
      </div>
      <TipBox tip={tip} />
    </div>
  );
}

function DataTable({ items, total, head }: { items: Item[]; total: number; head: string }) {
  return (
    <table className="viz-table">
      <thead><tr><th>{head}</th><th className="n">Oggetti</th><th className="n">Quota</th></tr></thead>
      <tbody>
        {items.map((i) => (
          <tr key={i.key}><td>{i.tip ?? i.label}</td><td className="n">{fmt(i.value)}</td><td className="n">{pct(i.value, total)}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Dashboard di un layer vettoriale: KPI e grafico di un attributo, calcolati sugli oggetti
 * (opzionalmente solo quelli nella vista corrente). Un clic su una barra filtra la mappa.
 */
export default function Dashboard({
  map, gsUrl, kc, layer, cql, refreshKey, selection, onSelect,
}: {
  map: maplibregl.Map;
  gsUrl: string;
  kc: Keycloak | null;
  layer: string;
  cql: string;                       // filtro dell'utente (senza la selezione del grafico)
  refreshKey: number;
  selection: DashSel | null;
  onSelect: (s: DashSel | null) => void;
}) {
  const [schema, setSchema] = useState<Schema | null>(null);
  const [field, setField] = useState<string>("");
  const [inView, setInView] = useState(true);
  const [viewTick, setViewTick] = useState(0);
  const [values, setValues] = useState<unknown[]>([]);
  const [capped, setCapped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"chart" | "table">("chart");

  useEffect(() => {
    let cancelled = false;
    setSchema(null); setError(null); setLoading(true);
    describeLayer(gsUrl, kc, layer)
      .then((s) => {
        if (cancelled) return;
        setSchema(s);
        const pick = s.fields.find((f) => kindOf(f.type) === "cat") ?? s.fields[0];
        setField(pick?.name ?? "");
      })
      .catch((e) => { if (!cancelled) { setError(`Dashboard disponibile solo per i layer vettoriali (${e.message}).`); setLoading(false); } });
    return () => { cancelled = true; };
  }, [gsUrl, kc, layer]);

  // la vista cambia: ricalcola (con un po' di attesa)
  useEffect(() => {
    if (!inView) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const onMove = () => { clearTimeout(t); t = setTimeout(() => setViewTick((n) => n + 1), 450); };
    map.on("moveend", onMove);
    return () => { clearTimeout(t); map.off("moveend", onMove); };
  }, [map, inView]);

  useEffect(() => {
    if (!schema || !field) return;
    let cancelled = false;
    setLoading(true); setError(null);
    let filter = cql.trim() ? `(${cql.trim()})` : "";
    if (inView) {
      const [[w, s], [e, n]] = map.getBounds().toArray();
      const cl = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)).toFixed(6);
      const box = `BBOX(${ident(schema.geomName)},${cl(w, -180, 180)},${cl(s, -90, 90)},${cl(e, -180, 180)},${cl(n, -90, 90)},'EPSG:4326')`;
      filter = filter ? `${filter} AND ${box}` : box;
    }
    getWfsFeatures(gsUrl, kc, layer, filter, MAX_FEATURES, [field])
      .then((fs) => {
        if (cancelled) return;
        setValues(fs.map((f) => f.properties?.[field]));
        setCapped(fs.length >= MAX_FEATURES);
      })
      .catch((e) => { if (!cancelled) { setValues([]); setError(`Dati non disponibili: ${e.message}`); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [schema, field, inView, viewTick, cql, refreshKey, gsUrl, kc, layer, map]);

  const fieldType = schema?.fields.find((f) => f.name === field)?.type ?? "string";
  const kind = kindOf(fieldType);
  const total = values.length;

  const model = useMemo(() => {
    const id = ident(field);
    const empty = (v: unknown) => v === null || v === undefined || v === "";
    if (kind === "num") {
      const nums = values.map((v) => (empty(v) ? NaN : Number(v))).filter(Number.isFinite);
      if (nums.length === 0) return { kind, kpis: [] as [string, string][], items: [] as Item[] };
      let min = Infinity, max = -Infinity, sum = 0;
      for (const n of nums) { if (n < min) min = n; if (n > max) max = n; sum += n; }
      const bins = min === max ? 1 : 10;
      const w = (max - min) / bins || 1;
      const counts = new Array(bins).fill(0);
      for (const n of nums) counts[Math.min(bins - 1, Math.floor((n - min) / w))]++;
      const items: Item[] = counts.map((c, i) => {
        const a = min + i * w, b = a + w, lastBin = i === bins - 1;
        return {
          key: `${i}`, label: fmt(a), tip: min === max ? fmt(min) : `${fmt(a)} – ${fmt(b)}`, value: c,
          cql: min === max ? `${id} = ${min}` : `${id} >= ${a} AND ${id} ${lastBin ? "<=" : "<"} ${b}`,
          selLabel: min === max ? `${field} = ${fmt(min)}` : `${field}: ${fmt(a)} – ${fmt(b)}`,
        };
      });
      return {
        kind,
        kpis: [["Somma", fmt(sum)], ["Media", fmt(sum / nums.length)], ["Min", fmt(min)], ["Max", fmt(max)]] as [string, string][],
        items,
      };
    }
    if (kind === "date") {
      const counts = new Map<string, number>();
      for (const v of values) {
        const s = String(v ?? "");
        if (/^\d{4}-\d{2}/.test(s)) counts.set(s.slice(0, 7), (counts.get(s.slice(0, 7)) ?? 0) + 1);
      }
      const keys = [...counts.keys()].sort().slice(-36);
      const items: Item[] = keys.map((k) => ({
        key: k, label: k, value: counts.get(k)!,
        cql: `${id} DURING ${k}-01T00:00:00Z/${nextMonth(k)}-01T00:00:00Z`,
        selLabel: `${field}: ${k}`,
      }));
      return { kind, kpis: keys.length ? ([["Dal", keys[0]], ["Al", keys[keys.length - 1]]] as [string, string][]) : [], items };
    }
    const counts = new Map<string, number>();
    for (const v of values) {
      const k = empty(v) ? "\u0000" : String(v);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const isBool = fieldType.toLowerCase() === "boolean";
    const top: Item[] = sorted.slice(0, TOP).map(([k, c]) =>
      k === "\u0000"
        ? { key: k, label: "(vuoto)", value: c, cql: `${id} IS NULL`, selLabel: `${field}: vuoto` }
        : { key: k, label: k, value: c, cql: isBool ? `${id} = ${k}` : `${id} = ${lit(k)}`, selLabel: `${field} = ${k}` },
    );
    const rest = sorted.slice(TOP).reduce((s, [, c]) => s + c, 0);
    if (rest > 0) top.push({ key: "__rest", label: `Altri (${sorted.length - TOP})`, value: rest });
    return { kind, kpis: [["Valori distinti", String(counts.size)]] as [string, string][], items: top };
  }, [values, kind, field, fieldType]);

  const pick = (i: Item) => {
    if (!i.cql) return;
    if (selection?.field === field && selection.key === i.key) onSelect(null);
    else onSelect({ field, cql: i.cql, label: i.selLabel ?? i.label, key: i.key });
  };
  const hasSel = selection?.field === field;

  if (error && !schema) return <div className="dock-scroll"><div className="error">{error}</div></div>;

  const title =
    model.kind === "cat" ? `Oggetti per ${field}` : model.kind === "date" ? `Oggetti per mese (${field})` : `Distribuzione di ${field}`;
  const sub =
    model.kind === "cat" ? (model.items.some((i) => i.key === "__rest") ? `primi ${TOP} valori` : "")
    : model.kind === "date" ? (model.items.length >= 36 ? "ultimi 36 mesi" : "")
    : "classi di uguale ampiezza";
  const stale = loading && values.length > 0;

  return (
    <>
      <div className="dock-tools">
        <label className="dock-field">Attributo
          <select value={field} onChange={(e) => setField(e.target.value)}>
            {schema?.fields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
          </select>
        </label>
        <label className="dock-check">
          <input type="checkbox" checked={inView} onChange={(e) => setInView(e.target.checked)} /> Solo vista corrente
        </label>
        {selection && (
          <span className="chip">
            Filtro grafico: {selection.label}
            <button className="icon-btn" title="Rimuovi la selezione" onClick={() => onSelect(null)}>×</button>
          </span>
        )}
        <span className="dock-count">{loading ? "aggiornamento…" : capped ? `primi ${MAX_FEATURES} oggetti` : ""}</span>
      </div>
      <div className={`dock-scroll dash${stale ? " stale" : ""}`}>
        {error && <div className="error">{error}</div>}
        <div className="kpis">
          <div className="kpi"><span className="k-label">Oggetti{inView ? " in vista" : ""}</span><span className="k-value">{loading && !values.length ? "…" : `${fmt(total)}${capped ? "+" : ""}`}</span></div>
          {model.kpis.map(([l, v]) => <div className="kpi" key={l}><span className="k-label">{l}</span><span className="k-value">{v}</span></div>)}
        </div>
        {!loading && !error && model.items.length === 0 && <div className="empty">Nessun dato da rappresentare per questo attributo.</div>}
        {model.items.length > 0 && (
          <>
            <div className="viz-head">
              <span className="viz-title">{title}</span>
              <span className="viz-sub">{sub}</span>
              <span className="viz-toggle" role="group" aria-label="Vista">
                <button className={view === "chart" ? "on" : ""} onClick={() => setView("chart")}>Grafico</button>
                <button className={view === "table" ? "on" : ""} onClick={() => setView("table")}>Tabella</button>
              </span>
            </div>
            {view === "table"
              ? <DataTable items={model.items} total={total} head={field} />
              : model.kind === "cat"
                ? <Bars items={model.items} total={total} selKey={selection?.key} hasSel={hasSel} onPick={pick} />
                : <Columns items={model.items} total={total} selKey={selection?.key} hasSel={hasSel} onPick={pick} />}
            {view === "chart" && model.items.some((i) => i.cql) && <div className="muted">Clic su un elemento per filtrare la mappa e la tabella.</div>}
          </>
        )}
      </div>
    </>
  );
}
