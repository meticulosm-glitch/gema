import type * as maplibregl from "maplibre-gl";
import {
  insertVertex, moveVertex, parsePath, removeVertex, segments, vertices,
  type Geom, type Kind,
} from "./edit";
import type { LngLat } from "./geo";

const EMPTY = { type: "FeatureCollection", features: [] } as any;

/** Layer di servizio per l'editing: geometria, vertici trascinabili, punti medi per inserire vertici. */
export function addEditLayers(map: maplibregl.Map, accent: string): void {
  map.addSource("edit-geom", { type: "geojson", data: EMPTY });
  map.addSource("edit-mid", { type: "geojson", data: EMPTY });
  map.addSource("edit-vtx", { type: "geojson", data: EMPTY });
  map.addLayer({ id: "edit-fill", type: "fill", source: "edit-geom", paint: { "fill-color": accent, "fill-opacity": 0.18 } });
  map.addLayer({ id: "edit-line", type: "line", source: "edit-geom", paint: { "line-color": accent, "line-width": 3, "line-dasharray": [2, 1] } });
  map.addLayer({
    id: "edit-mid", type: "circle", source: "edit-mid",
    paint: { "circle-radius": 4, "circle-color": "#ffffff", "circle-opacity": 0.85, "circle-stroke-color": accent, "circle-stroke-width": 1.5 },
  });
  map.addLayer({
    id: "edit-vtx", type: "circle", source: "edit-vtx",
    paint: { "circle-radius": 6.5, "circle-color": "#ffffff", "circle-stroke-color": accent, "circle-stroke-width": 2.5 },
  });
}

const setData = (map: maplibregl.Map, id: string, data: any) => {
  try {
    (map.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(data);
  } catch {
    /* mappa già distrutta (cambio di configurazione): niente da aggiornare */
  }
};

/** Disegna una geometria in modifica con i suoi vertici e punti medi. null = pulisce. */
export function renderEdit(map: maplibregl.Map, g: Geom | null): void {
  if (!g) {
    setData(map, "edit-geom", EMPTY); setData(map, "edit-vtx", EMPTY); setData(map, "edit-mid", EMPTY);
    return;
  }
  setData(map, "edit-geom", { type: "Feature", properties: {}, geometry: g });
  setData(map, "edit-vtx", {
    type: "FeatureCollection",
    features: vertices(g).map((v) => ({ type: "Feature", properties: { p: v.path.join(",") }, geometry: { type: "Point", coordinates: v.c } })),
  });
  setData(map, "edit-mid", {
    type: "FeatureCollection",
    features: segments(g).map((s) => ({
      type: "Feature", properties: { c: s.container.join(","), at: s.at }, geometry: { type: "Point", coordinates: s.mid },
    })),
  });
}

/** Bozza durante il disegno di un nuovo oggetto (vertici non trascinabili). */
export function renderDraft(map: maplibregl.Map, kind: Kind, pts: LngLat[]): void {
  const feats: any[] = [];
  if (kind === "polygon" && pts.length >= 3) feats.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...pts, pts[0]]] } });
  else if (kind !== "point" && pts.length >= 2) feats.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts } });
  setData(map, "edit-geom", { type: "FeatureCollection", features: feats });
  setData(map, "edit-mid", EMPTY);
  setData(map, "edit-vtx", {
    type: "FeatureCollection",
    features: pts.map((p) => ({ type: "Feature", properties: { p: "draft" }, geometry: { type: "Point", coordinates: p } })),
  });
}

/**
 * Abilita trascinamento dei vertici, inserimento dai punti medi e rimozione con il tasto destro.
 * `getGeom` restituisce la geometria corrente (mutata sul posto); `onChange` viene chiamata a fine gesto.
 */
export function attachVertexEditor(map: maplibregl.Map, getGeom: () => Geom | null, onChange: () => void): () => void {
  let drag: number[] | null = null;
  let moved = false;

  const startDrag = (path: number[]) => {
    drag = path;
    moved = false;
    map.dragPan.disable();
    map.getCanvas().style.cursor = "grabbing";
  };
  const endDrag = () => {
    if (drag === null) return;
    drag = null;
    map.dragPan.enable();
    map.getCanvas().style.cursor = "crosshair";
    if (moved) onChange();
  };

  const onVtxDown = (e: any) => {
    if (e.points && e.points.length > 1) return;
    const p = e.features?.[0]?.properties?.p;
    if (p === undefined || p === "draft") return;
    e.preventDefault();
    startDrag(parsePath(String(p)));
  };
  const onMidDown = (e: any) => {
    if (e.points && e.points.length > 1) return;
    const g = getGeom();
    const props = e.features?.[0]?.properties;
    if (!g || !props) return;
    const container = parsePath(String(props.c));
    const seg = segments(g).find((s) => s.container.join(",") === container.join(",") && s.at === Number(props.at));
    if (!seg) return;
    e.preventDefault();
    const path = insertVertex(g, seg, seg.mid);
    renderEdit(map, g);
    startDrag(path);
    moved = true; // l'inserimento stesso è una modifica
  };
  const onMove = (e: any) => {
    if (drag === null) return;
    const g = getGeom();
    if (!g) return;
    moveVertex(g, drag, [e.lngLat.lng, e.lngLat.lat]);
    moved = true;
    renderEdit(map, g);
  };
  const onRightClick = (e: any) => {
    const p = e.features?.[0]?.properties?.p;
    if (p === undefined || p === "draft") return;
    e.preventDefault();
    e.originalEvent?.preventDefault?.();
    const g = getGeom();
    if (g && removeVertex(g, parsePath(String(p)))) {
      renderEdit(map, g);
      onChange();
    }
  };
  const enter = () => { if (drag === null) map.getCanvas().style.cursor = "move"; };
  const leave = () => { if (drag === null) map.getCanvas().style.cursor = "crosshair"; };

  map.on("mousedown", "edit-vtx", onVtxDown);
  map.on("touchstart", "edit-vtx", onVtxDown);
  map.on("mousedown", "edit-mid", onMidDown);
  map.on("touchstart", "edit-mid", onMidDown);
  map.on("mousemove", onMove);
  map.on("touchmove", onMove);
  map.on("mouseup", endDrag);
  map.on("touchend", endDrag);
  map.on("contextmenu", "edit-vtx", onRightClick);
  map.on("mouseenter", "edit-vtx", enter);
  map.on("mouseleave", "edit-vtx", leave);
  map.on("mouseenter", "edit-mid", enter);
  map.on("mouseleave", "edit-mid", leave);
  window.addEventListener("mouseup", endDrag);

  return () => {
    endDrag();
    map.off("mousedown", "edit-vtx", onVtxDown);
    map.off("touchstart", "edit-vtx", onVtxDown);
    map.off("mousedown", "edit-mid", onMidDown);
    map.off("touchstart", "edit-mid", onMidDown);
    map.off("mousemove", onMove);
    map.off("touchmove", onMove);
    map.off("mouseup", endDrag);
    map.off("touchend", endDrag);
    map.off("contextmenu", "edit-vtx", onRightClick);
    map.off("mouseenter", "edit-vtx", enter);
    map.off("mouseleave", "edit-vtx", leave);
    map.off("mouseenter", "edit-mid", enter);
    map.off("mouseleave", "edit-mid", leave);
    window.removeEventListener("mouseup", endDrag);
  };
}
