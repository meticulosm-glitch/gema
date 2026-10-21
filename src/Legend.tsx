import { useEffect, useState } from "react";
import type Keycloak from "keycloak-js";
import { fetchLegendBlob } from "./api";

export interface LegendEntry { key: string; layer: string; title: string; style?: string; tag?: string; swatch?: string } // swatch: colore del disegno vettoriale

/** Legenda di un layer nello stile scelto (GetLegendGraphic). Si ricarica quando cambia lo stile. */
export default function Legend({ gsUrl, kc, layer, style }: { gsUrl: string; kc: Keycloak | null; layer: string; style?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let url: string | undefined;
    let cancelled = false;
    setSrc(null);
    setErr(false);
    fetchLegendBlob(gsUrl, kc, layer, style)
      .then((b) => { if (!cancelled) { url = URL.createObjectURL(b); setSrc(url); } })
      .catch(() => { if (!cancelled) setErr(true); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [gsUrl, kc, layer, style]);

  if (err) return <div className="empty lg-empty">Legenda non disponibile.</div>;
  if (!src) return <div className="empty lg-empty">Caricamento…</div>;
  return <img src={src} alt={`Legenda ${layer}`} />;
}

/** Legende dei layer attivi, sempre visibili sulla mappa; si possono solo comprimere, mai nascondere del tutto. */
export function LegendPanel({ gsUrl, kc, entries }: { gsUrl: string; kc: Keycloak | null; entries: LegendEntry[] }) {
  const [open, setOpen] = useState(true);
  if (entries.length === 0) return null;
  return (
    <aside className={`legend-panel${open ? "" : " collapsed"}`} aria-label="Legenda">
      <button className="lp-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span> Legenda
      </button>
      {open && (
        <div className="lp-body">
          {entries.map((e) => (
            <section key={e.key} className="lp-item">
              <div className="lp-title" title={e.layer}>{e.tag && <span className="chip">{e.tag}</span>} {e.title}</div>
              {e.swatch
                ? <div className="lp-swatch"><span style={{ background: e.swatch }} aria-hidden="true" /> disegno vettoriale</div>
                : <Legend gsUrl={gsUrl} kc={kc} layer={e.layer} style={e.style} />}
            </section>
          ))}
        </div>
      )}
    </aside>
  );
}
