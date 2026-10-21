import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type Keycloak from "keycloak-js";
import { getWfsFeatures, wmsTileUrl } from "./api";
import { basemapStyle, type BasemapDef } from "./basemaps";
import type { WidgetDef } from "./configStore";
import { bboxOf } from "./geo";

/** Mini-mappa di un widget: il layer (WMS, con il filtro del widget) sopra lo sfondo, inquadrato sugli oggetti. */
export default function WidgetMap({ def, gs, kc, basemaps, refresh }: { def: WidgetDef; gs: string; kc: Keycloak | null; basemaps: BasemapDef[]; refresh: number }) {
  const el = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!def.layer) return;
    const map = new maplibregl.Map({
      container: el.current!,
      style: basemapStyle(basemaps.length ? basemaps : [{ id: "none", label: "Nessuno" }], basemaps[0]?.id),
      center: [12.5, 42], zoom: 4,
      attributionControl: { compact: true },
      transformRequest: (url) => (url.startsWith(gs) && kc?.token ? { url, headers: { Authorization: `Bearer ${kc.token}` } } : { url }),
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    let off = false;
    map.once("load", () => {
      map.addSource("w", { type: "raster", tiles: [wmsTileUrl(gs, def.layer, { cql: def.cql }, refresh)], tileSize: 256 });
      map.addLayer({ id: "w", type: "raster", source: "w" });
    });
    // inquadratura: gli oggetti del layer (fino a 1000); un raster o un errore lasciano la vista generale
    getWfsFeatures(gs, kc, def.layer, def.cql, 1000)
      .then((fs) => {
        if (off) return;
        const bb = bboxOf(fs.map((f) => f.geometry).filter(Boolean));
        if (!bb) { setNote(fs.length ? null : "Nessun oggetto da mostrare."); return; }
        const [w, s, e, n] = bb;
        if (w === e && s === n) map.jumpTo({ center: [w, s], zoom: 14 });
        else map.fitBounds([[w, s], [e, n]], { padding: 16, maxZoom: 16, duration: 0 });
      })
      .catch(() => { /* layer raster: resta la vista generale */ });
    return () => { off = true; map.remove(); };
  }, [def.layer, def.cql, gs, kc, basemaps, refresh]);

  return (
    <div className="w-map-wrap">
      <div className="w-map" ref={el} role="img" aria-label={`Mappa del layer ${def.layer}`} />
      {note && <div className="muted">{note}</div>}
    </div>
  );
}
