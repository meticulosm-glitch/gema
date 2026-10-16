import type { Feature } from "./api";
import { IconClose } from "./icons";
import { dms, fmtArea, fmtLength, pathLength, ringArea, type LngLat } from "./geo";

export interface InfoResult { name: string; title: string; features: Feature[]; error?: string }
export interface InfoState { loading: boolean; results: InfoResult[]; message?: string }

export function InfoPanel({
  state, canEdit, onClose, onZoom, onEdit,
}: {
  state: InfoState;
  canEdit: boolean;
  onClose: () => void;
  onZoom: (f: Feature) => void;
  onEdit: (layer: string, f: Feature) => void;
}) {
  return (
    <div className="float-panel">
      <div className="fp-head">
        <strong>Interrogazione oggetti</strong>
        <button className="icon-btn" title="Chiudi" onClick={onClose}><IconClose /></button>
      </div>
      <div className="fp-body">
        {state.loading && <div className="empty">Interrogazione in corso…</div>}
        {state.message && <div className="empty">{state.message}</div>}
        {state.results.map((r) => (
          <section key={r.name}>
            <div className="section-title">{r.title}</div>
            {r.error && <div className="error">{r.error}</div>}
            {!r.error && r.features.length === 0 && <div className="empty">Nessun oggetto in questo punto.</div>}
            {r.features.map((f, i) => {
              const entries = Object.entries(f.properties ?? {}).filter(([, v]) => v !== null && v !== "");
              return (
                <div className="feat" key={f.id ?? i}>
                  <table>
                    <tbody>
                      {entries.length === 0 && <tr><td colSpan={2} className="muted">{f.id ?? "oggetto"}</td></tr>}
                      {entries.map(([k, v]) => (
                        <tr key={k}><th>{k}</th><td>{typeof v === "object" ? JSON.stringify(v) : String(v)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="feat-actions">
                    {f.geometry && <button className="btn-sm" onClick={() => onZoom(f)}>Zoom</button>}
                    {canEdit && f.id && <button className="btn-sm" onClick={() => onEdit(r.name, f)}>Modifica</button>}
                  </div>
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}

export function MeasurePanel({
  tool, pts, onUndo, onClear, onClose,
}: { tool: "coord" | "length" | "area"; pts: LngLat[]; onUndo: () => void; onClear: () => void; onClose: () => void }) {
  const last = pts[pts.length - 1];
  const title = tool === "coord" ? "Coordinate" : tool === "length" ? "Misura distanza" : "Misura area";
  return (
    <div className="float-panel small">
      <div className="fp-head">
        <strong>{title}</strong>
        <button className="icon-btn" title="Chiudi" onClick={onClose}><IconClose /></button>
      </div>
      <div className="fp-body">
        {pts.length === 0 && <div className="empty">Clicca sulla mappa{tool === "coord" ? "." : " per aggiungere punti."}</div>}
        {tool === "coord" && last && (
          <>
            <div className="big">{last[1].toFixed(6)}, {last[0].toFixed(6)}</div>
            <div className="muted">{dms(last[1], "lat")} · {dms(last[0], "lng")}</div>
            <div className="muted">EPSG:4326 (lat, lon)</div>
            <button className="btn-sm" onClick={() => navigator.clipboard?.writeText(`${last[1].toFixed(6)}, ${last[0].toFixed(6)}`)}>Copia</button>
          </>
        )}
        {tool === "length" && pts.length >= 2 && <div className="big">{fmtLength(pathLength(pts))}</div>}
        {tool === "area" && pts.length >= 3 && (
          <>
            <div className="big">{fmtArea(ringArea(pts))}</div>
            <div className="muted">Perimetro {fmtLength(pathLength([...pts, pts[0]]))}</div>
          </>
        )}
        {tool !== "coord" && pts.length > 0 && <div className="muted">{pts.length} vertici · misure geodetiche (sfera)</div>}
        {tool !== "coord" && pts.length > 0 && (
          <div className="btn-row">
            <button className="btn-sm" onClick={onUndo}>Annulla punto</button>
            <button className="btn-sm" onClick={onClear}>Cancella</button>
          </div>
        )}
      </div>
    </div>
  );
}
