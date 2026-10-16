import { useEffect, useMemo, useRef, useState } from "react";
import type Keycloak from "keycloak-js";
import type * as maplibregl from "maplibre-gl";
import type { LayerParams } from "./api";
import { IconClose } from "./icons";
import { sampleSteps, shortTime } from "./timeline";
import { fetchSeries, seriesCsv, type SeriesData, type SeriesPoint } from "./timeseries";

/** Numero massimo di richieste GetFeatureInfo per serie: oltre, gli istanti vengono campionati in modo uniforme. */
export const MAX_POINTS = 60;

export interface SeriesCandidate { name: string; title: string; steps: string[] }

const fmt = (n: number) => n.toLocaleString("it-IT", { maximumFractionDigits: 4 });

/** Grafico a linee con interruzioni sui dati mancanti. */
export function SeriesChart({ points, field }: { points: SeriesPoint[]; field: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 380, H = 190, L = 46, R = 10, T = 10, B = 26;
  const vals = points.map((p) => p.values[field] ?? null);
  const nums = vals.filter((v): v is number => v !== null);
  if (nums.length === 0) return <div className="empty">Nessun valore in questo punto per «{field}».</div>;
  let lo = Math.min(...nums), hi = Math.max(...nums);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.06;
  lo -= pad; hi += pad;
  const x0 = points[0].x, x1 = points[points.length - 1].x;
  const sx = (x: number) => L + (x1 === x0 ? (W - L - R) / 2 : ((x - x0) / (x1 - x0)) * (W - L - R));
  const sy = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

  let d = "";
  let pen = false;
  vals.forEach((v, i) => {
    if (v === null) { pen = false; return; }
    d += `${pen ? "L" : "M"}${sx(points[i].x).toFixed(1)},${sy(v).toFixed(1)}`;
    pen = true;
  });
  const yTicks = [0, 1, 2, 3, 4].map((k) => lo + ((hi - lo) * k) / 4);
  const xIdx = Array.from(new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]));

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0, bd = Infinity;
    points.forEach((p, i) => { const dd = Math.abs(sx(p.x) - px); if (dd < bd) { bd = dd; best = i; } });
    setHover(best);
  };
  const hp = hover !== null ? points[hover] : null;
  const hv = hp ? hp.values[field] ?? null : null;

  return (
    <div>
      <svg className="series-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Serie storica di ${field}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} className="sc-grid" />
            <text x={L - 5} y={sy(v) + 3} textAnchor="end" className="sc-tick">{fmt(v)}</text>
          </g>
        ))}
        {xIdx.map((i) => <text key={i} x={sx(points[i].x)} y={H - 8} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"} className="sc-tick">{shortTime(points[i].t)}</text>)}
        <path d={d} className="sc-line" />
        {points.map((p, i) => vals[i] !== null && <circle key={p.t} cx={sx(p.x)} cy={sy(vals[i] as number)} r={hover === i ? 4 : 2.2} className="sc-dot" />)}
        {hp && <line x1={sx(hp.x)} x2={sx(hp.x)} y1={T} y2={H - B} className="sc-cursor" />}
      </svg>
      <div className="muted sc-readout" aria-live="polite">
        {hp ? <><strong>{shortTime(hp.t)}</strong>: {hp.error ? "errore" : hv === null ? "nessun dato" : fmt(hv)}</> : `${nums.length} valori su ${points.length} istanti · passa il mouse sul grafico`}
      </div>
    </div>
  );
}

/** Pannello della serie storica in un punto: legge il layer scelto a date diverse con più GetFeatureInfo. */
export default function SeriesPanel({
  map, gsUrl, kc, candidates, point, paramsFor, onClose,
}: {
  map: maplibregl.Map;
  gsUrl: string;
  kc: Keycloak | null;
  candidates: SeriesCandidate[];
  point: { lng: number; lat: number } | null;
  paramsFor: (name: string) => LayerParams;
  onClose: () => void;
}) {
  const [layer, setLayer] = useState(candidates[0]?.name ?? "");
  const cand = candidates.find((c) => c.name === layer) ?? candidates[0];
  const steps = cand?.steps ?? [];
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(Math.max(0, steps.length - 1));
  const [data, setData] = useState<SeriesData | null>(null);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [field, setField] = useState("");
  const paramsRef = useRef(paramsFor); paramsRef.current = paramsFor;

  // il layer scelto non è più tra i candidati (spento, o senza TIME): si passa al primo disponibile
  useEffect(() => {
    if (candidates.length > 0 && !candidates.some((c) => c.name === layer)) setLayer(candidates[0].name);
  }, [candidates, layer]);
  // cambiando layer, l'intervallo riparte dall'intera serie
  useEffect(() => { setFrom(0); setTo(Math.max(0, steps.length - 1)); }, [cand?.name, steps.length]);

  const times = useMemo(() => sampleSteps(steps.slice(Math.min(from, to), Math.max(from, to) + 1), MAX_POINTS), [steps, from, to]);
  const timesKey = times.join("|"); // identità stabile: un nuovo array con gli stessi istanti non rilancia la serie
  const total = Math.abs(to - from) + 1;

  useEffect(() => {
    if (!point || !cand || times.length === 0) { setData(null); return; }
    const ctrl = new AbortController();
    setData(null);
    setProgress([0, times.length]);
    // un attimo di attesa: cambiare in sequenza i due estremi non deve lanciare due serie complete
    const id = setTimeout(() => {
      fetchSeries({
        gsUrl, kc, layer: cand.name, map, ll: point, params: paramsRef.current(cand.name), times, signal: ctrl.signal,
        onProgress: (d, t) => { if (!ctrl.signal.aborted) setProgress([d, t]); },
      })
        .then((r) => { if (!ctrl.signal.aborted) { setData(r); setProgress(null); } })
        .catch((e) => { if (!ctrl.signal.aborted) { setData({ points: [], fields: [], failed: times.length, aborted: false }); setProgress(null); console.error("[mapp] serie storica", e); } });
    }, 250);
    return () => { clearTimeout(id); ctrl.abort(); };
  }, [point, cand?.name, timesKey, gsUrl, kc, map]); // eslint-disable-line react-hooks/exhaustive-deps

  // valore tracciato: la scelta dell'utente se esiste ancora tra i campi letti, altrimenti il primo (calcolato al render, senza effetti: nessuna gara)
  const shown = data && data.fields.includes(field) ? field : data?.fields[0] ?? "";

  const download = () => {
    if (!data || !shown) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([seriesCsv(data.points, shown)], { type: "text/csv" }));
    a.download = `serie_${cand.name.replace(/[^\w.-]+/g, "_")}_${point?.lat.toFixed(4)}_${point?.lng.toFixed(4)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="float-panel series">
      <div className="fp-head">
        <strong>Serie storica nel punto</strong>
        <button className="icon-btn" title="Chiudi" aria-label="Chiudi" onClick={onClose}><IconClose /></button>
      </div>
      <div className="fp-body">
        {candidates.length === 0 ? (
          <div className="empty">Accendi un layer con dimensione TIME (con più di una data): la serie si calcola su quelle date.</div>
        ) : (
          <>
            <select value={cand.name} aria-label="Layer" onChange={(e) => setLayer(e.target.value)}>
              {candidates.map((c) => <option key={c.name} value={c.name}>{c.title}</option>)}
            </select>
            <div className="fb-row">
              <label className="muted">Da
                <select value={from} onChange={(e) => setFrom(Number(e.target.value))}>{steps.map((s, i) => <option key={s} value={i}>{shortTime(s)}</option>)}</select>
              </label>
              <label className="muted">a
                <select value={to} onChange={(e) => setTo(Number(e.target.value))}>{steps.map((s, i) => <option key={s} value={i}>{shortTime(s)}</option>)}</select>
              </label>
            </div>
            {total > MAX_POINTS && <div className="muted">{total} date nell'intervallo: ne vengono lette {times.length}, equidistanti.</div>}
            {!point && <div className="empty">Clicca sulla mappa nel punto da analizzare.</div>}
            {point && <div className="muted">{point.lat.toFixed(5)}°N {point.lng.toFixed(5)}°E · {times.length} richieste a GeoServer</div>}
            {progress && <div className="empty" role="status">Lettura in corso… {progress[0]} / {progress[1]}</div>}
            {data && data.points.length > 0 && (
              <>
                {data.fields.length > 1 && (
                  <select value={shown} aria-label="Valore" onChange={(e) => setField(e.target.value)}>
                    {data.fields.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                )}
                {shown && <SeriesChart points={data.points} field={shown} />}
                {data.failed > 0 && <div className="error">{data.failed} date su {data.points.length} non lette: {data.points.find((p) => p.error)?.error}</div>}
                <div className="btn-row"><button className="btn-sm" disabled={!shown} onClick={download}>Scarica CSV</button></div>
              </>
            )}
            {data && data.points.length > 0 && data.fields.length === 0 && data.failed === 0 && (
              <div className="empty">Nessun dato in questo punto: fuori dalla copertura del layer o su un valore NoData.</div>
            )}
            {data && data.points.length === 0 && !data.aborted && <div className="error">Serie non disponibile: GeoServer non ha risposto.</div>}
          </>
        )}
      </div>
    </div>
  );
}
