import type { StyleSpecification } from "maplibre-gl";

/** Sfondo selezionabile. Senza `tiles` è lo sfondo vuoto ("nessuno"). */
export interface BasemapDef { id: string; label: string; tiles?: string; attribution?: string; maxzoom?: number }

export const NO_BASEMAP_COLOR = "#eef1f5";

/** Elenco di default: lo sfondo configurato (BASEMAP_TILES) più satellite, scuro e nessuno. */
export function defaultBasemaps(osmTiles: string): BasemapDef[] {
  return [
    { id: "osm", label: "Mappa", tiles: osmTiles, attribution: "© OpenStreetMap" },
    {
      id: "sat", label: "Satellite", maxzoom: 19,
      tiles: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
    },
    { id: "dark", label: "Scuro", tiles: "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", attribution: "© OpenStreetMap © CARTO" },
    { id: "none", label: "Nessuno" },
  ];
}

const validTiles = (t: unknown): t is string => typeof t === "string" && /^(https?:\/\/|\/)/.test(t) && /\{z\}/.test(t) && /\{x\}/.test(t) && /\{y\}/.test(t);

/** Tiene solo le voci valide (id univoco, tile con {z}/{x}/{y}); utile per l'elenco letto da BASEMAPS. */
export function sanitizeBasemaps(raw: unknown): BasemapDef[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: BasemapDef[] = [];
  for (const x of raw as any[]) {
    if (!x || typeof x !== "object" || typeof x.id !== "string" || !/^[\w-]{1,40}$/.test(x.id) || seen.has(x.id)) continue;
    if (x.tiles !== undefined && x.tiles !== "" && !validTiles(x.tiles)) continue;
    seen.add(x.id);
    out.push({
      id: x.id,
      label: typeof x.label === "string" && x.label.trim() ? x.label.trim() : x.id,
      ...(x.tiles ? { tiles: x.tiles as string } : {}),
      ...(typeof x.attribution === "string" && x.attribution ? { attribution: x.attribution } : {}),
      ...(Number.isFinite(x.maxzoom) ? { maxzoom: Number(x.maxzoom) } : {}),
    });
  }
  return out;
}

/** Elenco effettivo: quello configurato se valido, altrimenti il predefinito. */
export function resolveBasemaps(cfg: { basemapTiles: string; basemaps?: unknown }): BasemapDef[] {
  const custom = sanitizeBasemaps(cfg.basemaps);
  return custom.length > 0 ? custom : defaultBasemaps(cfg.basemapTiles);
}

/** Lo sfondo scelto se esiste, altrimenti il primo dell'elenco. */
export const pickBasemap = (list: BasemapDef[], id?: string): BasemapDef => list.find((b) => b.id === id) ?? list[0];

/**
 * Stile di base: un layer di sfondo e un layer raster per ogni sfondo con tile. Solo quello scelto è visibile,
 * così gli altri non scaricano nulla e l'attribuzione mostrata è quella dello sfondo in uso.
 */
export function basemapStyle(list: BasemapDef[], activeId?: string): StyleSpecification {
  const active = pickBasemap(list, activeId);
  const sources: StyleSpecification["sources"] = {};
  const layers: StyleSpecification["layers"] = [{ id: "bg", type: "background", paint: { "background-color": NO_BASEMAP_COLOR } }];
  for (const b of list) {
    if (!b.tiles) continue;
    sources[`bm-${b.id}`] = { type: "raster", tiles: [b.tiles], tileSize: 256, ...(b.attribution ? { attribution: b.attribution } : {}), ...(b.maxzoom ? { maxzoom: b.maxzoom } : {}) };
    layers.push({ id: `bm-${b.id}`, type: "raster", source: `bm-${b.id}`, layout: { visibility: b.id === active.id ? "visible" : "none" } });
  }
  return { version: 8, sources, layers };
}

/** Cambia sfondo su una mappa già creata con basemapStyle. */
export function applyBasemap(
  map: { getLayer(id: string): unknown; setLayoutProperty(id: string, prop: string, v: string): unknown },
  list: BasemapDef[],
  id?: string,
): void {
  const active = pickBasemap(list, id);
  for (const b of list) if (b.tiles && map.getLayer(`bm-${b.id}`)) map.setLayoutProperty(`bm-${b.id}`, "visibility", b.id === active.id ? "visible" : "none");
}
