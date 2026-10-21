import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { basemapStyle, type BasemapDef } from "./basemaps";
import type { Bbox } from "./roleView";

/**
 * Mappa piccola per scegliere un'area: si inquadra la zona e "Usa questa inquadratura" ne prende il riquadro.
 * Il riquadro di partenza (se c'è) è disegnato in tratteggio.
 */
export default function BboxPicker({
  basemaps, basemap, initial, start, onPick, onCancel,
}: {
  basemaps: BasemapDef[]; basemap?: string; initial?: Bbox; start: { center: [number, number]; zoom: number; bounds?: number[] };
  onPick: (b: Bbox) => void; onCancel: () => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    const box = initial ?? (start.bounds?.length === 4 ? (start.bounds as Bbox) : undefined);
    const map = new maplibregl.Map({
      container: el.current!,
      style: basemapStyle(basemaps, basemap),
      center: start.center,
      zoom: start.zoom,
      ...(box ? { bounds: [[box[0], box[1]], [box[2], box[3]]] as [[number, number], [number, number]], fitBoundsOptions: { padding: 20 } } : {}),
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    if (initial) {
      map.once("load", () => {
        const [w, s, e, n] = initial;
        map.addSource("current", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } } });
        map.addLayer({ id: "current", type: "line", source: "current", paint: { "line-color": "#c2185b", "line-width": 2, "line-dasharray": [2, 2] } });
      });
    }
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
    // la mappa si crea una volta sola per apertura del selettore
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const use = () => {
    const b = mapRef.current?.getBounds();
    if (!b) return;
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    onPick([clamp(b.getWest(), -180, 180), clamp(b.getSouth(), -90, 90), clamp(b.getEast(), -180, 180), clamp(b.getNorth(), -90, 90)]);
  };

  return (
    <div className="bbox-picker">
      <div className="bbox-map" ref={el} />
      <div className="btn-row">
        <button type="button" className="btn-sm primary" onClick={use}>Usa questa inquadratura</button>
        <button type="button" className="btn-sm" onClick={onCancel}>Annulla</button>
        <span className="muted">Sposta e ingrandisci la mappa sull'area che il ruolo deve vedere all'apertura.</span>
      </div>
    </div>
  );
}
