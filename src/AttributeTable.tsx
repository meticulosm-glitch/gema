import { useEffect, useMemo, useState } from "react";
import type Keycloak from "keycloak-js";
import { getWfsFeatures, type Feature } from "./api";
import { IconEdit, IconZoom } from "./icons";

const cell = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/**
 * Tabella attributi di un layer vettoriale (WFS), con filtro rapido e filtro CQL lato server.
 * `baseCql` è il filtro già attivo sulla mappa (filtro del layer + selezione dal grafico).
 */
export default function AttributeTable({
  gsUrl, kc, layer, baseCql, refreshKey, canEdit, onEdit, onSelect,
}: {
  gsUrl: string;
  kc: Keycloak | null;
  layer: string;
  baseCql: string;
  refreshKey: number;
  canEdit: boolean;
  onEdit: (f: Feature) => void;
  onSelect: (features: Feature[]) => void;
}) {
  const [rows, setRows] = useState<Feature[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cqlInput, setCqlInput] = useState("");
  const [cql, setCql] = useState("");
  const [quick, setQuick] = useState("");
  const [selected, setSelected] = useState<number | null>(null);

  // cambia il layer: si riparte da zero
  useEffect(() => { setCql(""); setCqlInput(""); setQuick(""); }, [layer]);

  const effective = [baseCql, cql].filter((s) => s.trim()).map((s) => `(${s.trim()})`).join(" AND ");

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setSelected(null);
    getWfsFeatures(gsUrl, kc, layer, effective)
      .then((f) => { if (!cancelled) setRows(f); })
      .catch((e) => {
        if (!cancelled) { setRows([]); setError(`${e.message} — il layer potrebbe non essere vettoriale (raster) oppure il filtro CQL non è valido.`); }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [gsUrl, kc, layer, effective, refreshKey]);

  const columns = useMemo(() => {
    const keys: string[] = [];
    for (const r of rows.slice(0, 30)) for (const k of Object.keys(r.properties ?? {})) if (!keys.includes(k)) keys.push(k);
    return keys.slice(0, 14);
  }, [rows]);

  const q = quick.trim().toLowerCase();
  const shown = useMemo(
    () => (q ? rows.filter((r) => Object.values(r.properties ?? {}).some((v) => cell(v).toLowerCase().includes(q))) : rows),
    [rows, q],
  );

  return (
    <>
      <div className="dock-tools">
        <input className="search" placeholder="Filtro rapido…" value={quick} onChange={(e) => setQuick(e.target.value)} />
        <input
          className="search cql"
          placeholder="Filtro CQL (es. nome LIKE 'A%')"
          value={cqlInput}
          onChange={(e) => setCqlInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") setCql(cqlInput); }}
        />
        <button className="btn-sm" onClick={() => setCql(cqlInput)}>Applica</button>
        <button className="icon-btn" title="Zoom su tutti gli oggetti" disabled={!shown.length} onClick={() => onSelect(shown)}><IconZoom /></button>
        <span className="dock-count">{loading ? "…" : `${shown.length}${q ? ` / ${rows.length}` : ""} oggetti`}</span>
      </div>
      <div className="dock-scroll">
        {error && <div className="error">{error}</div>}
        {!error && !loading && rows.length === 0 && <div className="empty">Nessun oggetto.</div>}
        {rows.length > 0 && (
          <table className="attr">
            <thead><tr>{canEdit && <th />}{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {shown.slice(0, 500).map((r, i) => (
                <tr key={r.id ?? i} className={selected === i ? "sel" : ""} onClick={() => { setSelected(i); onSelect([r]); }}>
                  {canEdit && (
                    <td className="act">
                      <button className="icon-btn" title="Modifica questo oggetto" onClick={(e) => { e.stopPropagation(); onEdit(r); }}><IconEdit /></button>
                    </td>
                  )}
                  {columns.map((c) => <td key={c} title={cell(r.properties?.[c])}>{cell(r.properties?.[c])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
