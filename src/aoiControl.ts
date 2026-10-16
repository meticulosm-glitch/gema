import type * as maplibregl from "maplibre-gl";
import type { AppConfig } from "./config";

export type AoiView = { bounds: [[number, number], [number, number]] } | { center: [number, number]; zoom: number };

/** Area di interesse: il riquadro MAP_BBOX se configurato, altrimenti centro e zoom iniziali (MAP_CENTER_*, MAP_ZOOM). */
export function aoiView(cfg: Pick<AppConfig, "mapBounds" | "mapCenter" | "mapZoom">): AoiView {
  const b = cfg.mapBounds;
  if (b && b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3]) return { bounds: [[b[0], b[1]], [b[2], b[3]]] };
  return { center: cfg.mapCenter, zoom: cfg.mapZoom };
}

/** Porta la mappa sull'area di interesse; inclinazione e rotazione restano quelle correnti (vista 3D compresa). */
export function goToAoi(map: Pick<maplibregl.Map, "fitBounds" | "easeTo">, cfg: Pick<AppConfig, "mapBounds" | "mapCenter" | "mapZoom">) {
  const v = aoiView(cfg);
  if ("bounds" in v) map.fitBounds(v.bounds, { padding: 30, duration: 800 });
  else map.easeTo({ center: v.center, zoom: v.zoom, duration: 800 });
}

const ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#333" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/><circle cx="12" cy="12" r="2.5"/></svg>';

/** Pulsante tra i controlli della mappa (stesso stile di zoom e schermo intero). */
export class AoiControl implements maplibregl.IControl {
  private el?: HTMLDivElement;
  constructor(private readonly onClick: () => void, private readonly label = "Zoom sull'area di interesse") {}

  onAdd(): HTMLElement {
    const el = document.createElement("div");
    el.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "maplibregl-ctrl-icon aoi-ctrl";
    btn.title = this.label;
    btn.setAttribute("aria-label", this.label);
    btn.innerHTML = ICON;
    btn.addEventListener("click", this.onClick);
    el.appendChild(btn);
    this.el = el;
    return el;
  }

  onRemove(): void {
    this.el?.remove();
    this.el = undefined;
  }
}
