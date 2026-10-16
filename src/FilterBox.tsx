import { useEffect, useMemo, useState } from "react";
import type { StyleInfo, TimeInfo } from "./capabilities";
import TimeSlider from "./TimeSlider";
import { timeSteps } from "./timeline";

/** Filtro CQL e dimensione TIME di un layer attivo (applicati ai tile WMS e alle interrogazioni). */
export default function FilterBox({
  cql, noCql, time, timeInfo, style, styles, error, selectionLabel, onApplyCql, onApplyTime, onApplyStyle, onClearSelection,
}: {
  cql: string;
  noCql?: boolean; // layer raster: il filtro CQL non si applica
  time: string;
  timeInfo?: TimeInfo;
  style?: string;        // stile (SLD) scelto; "" = predefinito
  styles?: StyleInfo[];  // stili associati al layer in GeoServer
  error?: string;
  selectionLabel?: string;
  onApplyCql: (cql: string) => void;
  onApplyTime: (t: string) => void;
  onApplyStyle?: (s: string) => void;
  onClearSelection: () => void;
}) {
  const [c, setC] = useState(cql);
  const [t, setT] = useState(time);
  useEffect(() => setC(cql), [cql]);
  useEffect(() => setT(time), [time]);
  const steps = useMemo(() => timeSteps(timeInfo), [timeInfo]);

  return (
    <div className="filterbox">
      {!noCql && <div className="fb-row">
        <input
          className="search"
          placeholder="Filtro CQL, es. anno = 2026"
          value={c}
          onChange={(e) => setC(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onApplyCql(c); }}
        />
        <button className="btn-sm" onClick={() => onApplyCql(c)}>Applica</button>
        {cql && <button className="btn-sm" onClick={() => onApplyCql("")}>Togli</button>}
      </div>}
      {timeInfo && (
        <div className="fb-row">
          {timeInfo.values ? (
            <select value={t} aria-label="Data del layer" onChange={(e) => { setT(e.target.value); onApplyTime(e.target.value); }}>
              <option value="">Data: predefinita{timeInfo.default ? ` (${timeInfo.default})` : ""}</option>
              {timeInfo.values.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          ) : (
            <>
              <input
                className="search"
                placeholder={`Data o intervallo a/b${timeInfo.default ? ` (predef. ${timeInfo.default})` : ""}`}
                value={t}
                onChange={(e) => setT(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") onApplyTime(t); }}
              />
              <button className="btn-sm" onClick={() => onApplyTime(t)}>Applica</button>
              {time && <button className="btn-sm" onClick={() => onApplyTime("")}>Togli</button>}
            </>
          )}
        </div>
      )}
      {timeInfo && steps.length > 1 && (
        <TimeSlider steps={steps} value={time} defaultValue={timeInfo.default} onChange={(v) => { setT(v); onApplyTime(v); }} />
      )}
      {styles && styles.length > 1 && onApplyStyle && (
        <div className="fb-row">
          <select className="style-select" value={style ?? ""} aria-label="Stile" title="Stile (SLD)" onChange={(e) => onApplyStyle(e.target.value)}>
            <option value="">Stile: predefinito ({styles[0].title})</option>
            {styles.slice(1).map((st) => <option key={st.name} value={st.name}>{st.title}</option>)}
          </select>
        </div>
      )}
      {selectionLabel && (
        <div className="fb-row">
          <span className="chip">Dal grafico: {selectionLabel}<button className="icon-btn" title="Rimuovi" onClick={onClearSelection}>×</button></span>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
