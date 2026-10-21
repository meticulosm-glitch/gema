import type * as maplibregl from "maplibre-gl";
import type { LayerParams } from "./api";

/**
 * Disegno vettoriale (vector tiles) dei layer pesanti: GeoServer manda i tile in formato Mapbox Vector Tile (estensione
 * "vectortiles"), il browser li disegna. Nessun limite sul numero di oggetti (arrivano a tile, come le immagini), linee
 * nitide a ogni zoom, e passando il mouse si vede l'oggetto senza chiedere nulla al server. I colori non sono quelli dello
 * stile SLD: ogni layer ha un colore della palette categorica, nell'ordine di accensione.
 */
export const MVT_FORMAT = "application/vnd.mapbox-vector-tile";

/** GeoServer offre il formato MVT nelle GetMap (dal GetCapabilities WMS). */
export function supportsMvt(capabilitiesXml: string): boolean {
  const getMap = capabilitiesXml.match(/<(?:\w+:)?GetMap>([\s\S]*?)<\/(?:\w+:)?GetMap>/)?.[1] ?? "";
  return /<(?:\w+:)?Format>\s*application\/(vnd\.mapbox-vector-tile|x-protobuf;type=mapbox-vector)\s*</.test(getMap);
}

const enc = encodeURIComponent;

/** URL dei vector tile di un layer (stessi filtro, data e contatore delle immagini). */
export function vtTileUrl(gsUrl: string, layer: string, p: LayerParams = {}, rev = 0): string {
  let u = `${gsUrl}/wms?service=WMS&version=1.1.1&request=GetMap&layers=${enc(layer)}&styles=&format=${enc(MVT_FORMAT)}&srs=EPSG:3857&width=256&height=256`;
  if (p.cql?.trim()) u += `&cql_filter=${enc(p.cql.trim())}`;
  if (p.time?.trim()) u += `&time=${enc(p.time.trim())}`;
  if (rev) u += `&_r=${rev}`;
  return `${u}&bbox={bbox-epsg-3857}`;
}

/** Nome del layer dentro il tile: GeoServer usa il nome senza workspace. */
export const sourceLayer = (layer: string) => layer.split(":").pop() ?? layer;

/** Palette categorica (validata, chiara e scura): un colore per layer, nell'ordine in cui si accendono. */
export const VT_COLORS = { light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"], dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"] };
export const vtColor = (index: number, dark = false) => (dark ? VT_COLORS.dark : VT_COLORS.light)[((index % 5) + 5) % 5];

export const vtSourceId = (name: string) => `vt-${name}`;
export const vtLayerIds = (name: string) => [`vt-${name}-fill`, `vt-${name}-line`, `vt-${name}-circle`];
/** Contorno dell'oggetto sotto il mouse: stessa sorgente, così il bordo è intero anche se l'oggetto sta su più tile. */
export const vtHoverId = (name: string) => `vt-${name}-hover`;
const NONE: maplibregl.FilterSpecification = ["==", ["get", "__gema_none__"], "__gema_none__"];

/** Filtro che individua un oggetto: per id se il tile lo porta, altrimenti per i suoi attributi semplici. */
export function identityFilter(id: string | number | undefined, props: Record<string, unknown>): maplibregl.FilterSpecification {
  if (id !== undefined && id !== null && id !== "") return ["==", ["id"], id as any];
  const simple = Object.entries(props).filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean").slice(0, 8);
  return simple.length ? (["all", ...simple.map(([k, v]) => ["==", ["get", k], v])] as any) : NONE;
}

type MapLike = Pick<maplibregl.Map, "addSource" | "addLayer" | "getSource" | "getLayer" | "removeLayer" | "removeSource" | "setPaintProperty" | "setLayoutProperty" | "setFilter">;

/** Aggiunge sorgente e stili (poligoni, linee, punti) sotto a evidenziazione e misure (`before`). */
export function addVectorLayer(map: MapLike, name: string, url: string, color: string, opacity: number, before?: string): void {
  const src = vtSourceId(name);
  if (!map.getSource(src)) map.addSource(src, { type: "vector", tiles: [url], minzoom: 0, maxzoom: 22 });
  const [fill, line, circle] = vtLayerIds(name);
  const sl = sourceLayer(name);
  const poly = ["==", ["geometry-type"], "Polygon"] as maplibregl.FilterSpecification;
  const point = ["==", ["geometry-type"], "Point"] as maplibregl.FilterSpecification;
  if (!map.getLayer(fill)) map.addLayer({ id: fill, type: "fill", source: src, "source-layer": sl, filter: poly, paint: { "fill-color": color, "fill-opacity": 0.3 * opacity } }, before);
  if (!map.getLayer(line)) map.addLayer({ id: line, type: "line", source: src, "source-layer": sl, filter: ["!=", ["geometry-type"], "Point"], paint: { "line-color": color, "line-width": 2, "line-opacity": opacity } }, before);
  if (!map.getLayer(circle)) map.addLayer({ id: circle, type: "circle", source: src, "source-layer": sl, filter: point, paint: { "circle-color": color, "circle-radius": 5, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2, "circle-opacity": opacity, "circle-stroke-opacity": opacity } }, before);
  const hover = vtHoverId(name);
  if (!map.getLayer(hover)) map.addLayer({ id: hover, type: "line", source: src, "source-layer": sl, filter: NONE, paint: { "line-color": "#1c1c1c", "line-width": 3 } }, before);
}

/** Evidenzia (o, con `null`, spegne) l'oggetto sotto il mouse. */
export function setVectorHover(map: MapLike, name: string, filter: maplibregl.FilterSpecification | null): void {
  if (map.getLayer(vtHoverId(name))) map.setFilter(vtHoverId(name), filter ?? NONE);
}

export function removeVectorLayer(map: MapLike, name: string): void {
  for (const id of [...vtLayerIds(name), vtHoverId(name)]) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(vtSourceId(name))) map.removeSource(vtSourceId(name));
}

export function setVectorOpacity(map: MapLike, name: string, opacity: number): void {
  const [fill, line, circle] = vtLayerIds(name);
  if (map.getLayer(fill)) map.setPaintProperty(fill, "fill-opacity", 0.3 * opacity);
  if (map.getLayer(line)) map.setPaintProperty(line, "line-opacity", opacity);
  if (map.getLayer(circle)) { map.setPaintProperty(circle, "circle-opacity", opacity); map.setPaintProperty(circle, "circle-stroke-opacity", opacity); }
}

export function setVectorVisible(map: MapLike, name: string, visible: boolean): void {
  for (const id of [...vtLayerIds(name), vtHoverId(name)]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
}

export function setVectorTiles(map: MapLike, name: string, url: string): void {
  (map.getSource(vtSourceId(name)) as maplibregl.VectorTileSource | undefined)?.setTiles?.([url]);
}

/** Etichetta breve di un oggetto per il riquadro al passaggio del mouse. */
export function hoverLabel(props: Record<string, unknown>): { title: string; rows: [string, string][] } {
  const entries = Object.entries(props).filter(([, v]) => v !== null && v !== undefined && v !== "");
  const named = entries.find(([k, v]) => /^(name|nome|titolo|title|label|code|codice)$/i.test(k) && typeof v !== "object");
  const firstText = entries.find(([, v]) => typeof v === "string");
  const title = String((named ?? firstText)?.[1] ?? "oggetto");
  return { title, rows: entries.filter(([k]) => k !== (named ?? firstText)?.[0]).slice(0, 5).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]) };
}
