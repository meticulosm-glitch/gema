import { useEffect, useMemo, useState } from "react";
import type Keycloak from "keycloak-js";
import { describeLayer, getWfsFeatures, type Schema } from "./api";
import type { WidgetDef } from "./configStore";

const MAX = 5000;
const NUMERIC = ["int", "integer", "long", "short", "byte", "double", "float", "decimal"];
export const isNum = (t: string) => NUMERIC.includes(t.toLowerCase());
export const isDate = (t: string) => t.toLowerCase().startsWith("date");
const fmt = (n: number) => n.toLocaleString("it-IT", { maximumFractionDigits: 2 });
const ident = (n: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : `"${n.replace(/"/g, '""')}"`);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
type Row = Record<string, unknown>;
const andCql = (...p: (string | undefined)[]) => { const x = p.filter((c): c is string => !!c && !!c.trim()); return x.length === 1 ? x[0] : x.map((c) => `(${c})`).join(" AND "); };

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
  if (def.type === "bar") {
    const groups = new Map<string, Row[]>();
    for (const r of rows) { const k = r[f] === null || r[f] === undefined || r[f] === "" ? "\u0000" : String(r[f]); groups.set(k, [...(groups.get(k) ?? []), r]); }
    return [...groups.entries()]
      .map(([k, rs]): Item => k === "\u0000"
        ? { key: k, label: "(vuoto)", value: aggregate(rs, def.agg, def.valueField), cql: `${ident(f)} IS NULL` }
        : { key: k, label: k, value: aggregate(rs, def.agg, def.valueField), cql: `${ident(f)} = ${Number.isFinite(Number(k)) && typeof rs[0][f] === "number" ? k : lit(k)}` })
      .sort((a, b) => b.value - a.value).slice(0, 8);
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
  const sig = JSON.stringify([def.layer, def.field, def.valueField, def.cql, def.type, def.agg]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    const t = setTimeout(async () => {
      try {
        if (!def.layer) throw new Error("layer non scelto");
        let props = [def.field, def.valueField].filter((x): x is string => !!x);
        if (props.length === 0) props = [(await describeLayer(gs, kc, def.layer)).fields[0]?.name].filter(Boolean) as string[];
        const fs = await getWfsFeatures(gs, kc, def.layer, def.cql, MAX, props);
        if (cancelled) return;
        setRows(fs.map((f) => f.properties ?? {}));
        setCapped(fs.length >= MAX);
      } catch (e) {
        if (!cancelled) { setRows([]); setError(String((e as Error).message)); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, gs, kc, refresh]);
  return { rows, loading, error, capped };
}

export function WidgetCard({
  def, gs, kc, refresh, canOpen, onOpenMap,
}: { def: WidgetDef; gs: string; kc: Keycloak | null; refresh?: number; canOpen: boolean; onOpenMap: (layer: string, cql: string) => void }) {
  const { rows, loading, error, capped } = useWidgetData(def, gs, kc, refresh);
  const items = useMemo(() => buildItems(def, rows), [def, rows]);
  const max = Math.max(1, ...items.map((i) => i.value));
  const unit = def.agg === "count" || !def.valueField ? "oggetti" : `${def.agg} ${def.valueField}`;
  const kpi = aggregate(rows, def.agg, def.valueField);

  return (
    <section className={`widget w${def.w}`} aria-busy={loading}>
      <header className="widget-head">
        <h3>{def.title || "(senza titolo)"}</h3>
        <button className="link" disabled={!canOpen || !def.layer} title={canOpen ? "Apri il layer sulla mappa con il filtro del widget" : "Layer non disponibile per il tuo ruolo"} onClick={() => onOpenMap(def.layer, def.cql ?? "")}>
          Apri sulla mappa
        </button>
      </header>
      {error && <div className="error">{error}</div>}
      {!error && def.type === "kpi" && (
        <div className="kpi-big">
          <span className="k-value">{loading && rows.length === 0 ? "…" : `${fmt(kpi)}${capped && def.agg === "count" ? "+" : ""}`}</span>
          <span className="k-label">{unit}</span>
        </div>
      )}
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
      {!error && !loading && def.type !== "kpi" && items.length === 0 && <div className="empty">Nessun dato.</div>}
      {capped && <div className="muted">calcolato sui primi {MAX} oggetti</div>}
    </section>
  );
}

export function fieldsOf(schema: Schema | null) { return schema?.fields ?? []; }
