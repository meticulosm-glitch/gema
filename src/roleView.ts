/**
 * Vista iniziale per ruolo: area di interesse, sfondo e layer accesi quando la mappa si apre senza un link
 * o una vista salvata. Una riga per ruolo nella tabella role_views; i campi vuoti lasciano il comportamento globale
 * (MAP_BBOX / MAP_CENTER_* per l'area, primo sfondo, layer accesi del catalogo).
 */
export type Bbox = [number, number, number, number]; // ovest, sud, est, nord (gradi)

export interface RoleView {
  fid?: string;
  role: string;
  bbox?: Bbox;
  basemap: string;   // "" = sfondo predefinito
  layers: string[];  // vuoto = layer accesi del catalogo
  updatedBy?: string;
  updatedAt?: string;
}

/** Riquadro valido: quattro numeri finiti, dentro i limiti del globo, con ovest < est e sud < nord. */
export function validBbox(b: unknown): b is Bbox {
  return Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    b[0] >= -180 && b[2] <= 180 && b[1] >= -90 && b[3] <= 90 && b[0] < b[2] && b[1] < b[3];
}

/** "ovest,sud,est,nord" -> riquadro; testo vuoto o non valido -> undefined. */
export function parseBbox(s: unknown): Bbox | undefined {
  if (typeof s !== "string" || !s.trim()) return undefined;
  const parts = s.split(",").map((x) => x.trim());
  if (parts.length !== 4 || parts.some((x) => !/^-?\d+(\.\d+)?$/.test(x))) return undefined;
  const b = parts.map(Number);
  return validBbox(b) ? (b as Bbox) : undefined;
}

/** Riquadro -> testo per la tabella (6 decimali: circa 10 cm). */
export const formatBbox = (b?: Bbox) => (b ? b.map((n) => String(Math.round(n * 1e6) / 1e6)).join(",") : "");

/** Una vista senza area, sfondo né layer non serve: la riga si può eliminare. */
export const isEmptyView = (v: Pick<RoleView, "bbox" | "basemap" | "layers">) => !v.bbox && !v.basemap.trim() && v.layers.length === 0;

export interface StartView {
  bbox?: Bbox;
  basemap?: string;
  layers?: string[];  // undefined = nessun ruolo li stabilisce (valgono quelli del catalogo)
  roles: string[];    // ruoli da cui arriva la vista (per i messaggi)
}

/**
 * Vista iniziale di un utente con più ruoli:
 *  - area: il riquadro che contiene le aree di tutti i suoi ruoli;
 *  - layer: l'unione, senza doppioni;
 *  - sfondo: quello del primo ruolo, in ordine alfabetico, che ne indica uno.
 * Senza viste per i suoi ruoli: null (resta il comportamento globale).
 */
export function startViewFor(userRoles: string[], views: RoleView[]): StartView | null {
  const mine = views.filter((v) => userRoles.includes(v.role) && !isEmptyView(v)).sort((a, b) => a.role.localeCompare(b.role));
  if (mine.length === 0) return null;
  const boxes = mine.map((v) => v.bbox).filter((b): b is Bbox => !!b);
  const bbox: Bbox | undefined = boxes.length
    ? [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))]
    : undefined;
  const withLayers = mine.filter((v) => v.layers.length > 0);
  const basemap = mine.find((v) => v.basemap.trim())?.basemap.trim();
  return {
    ...(bbox ? { bbox } : {}),
    ...(basemap ? { basemap } : {}),
    ...(withLayers.length ? { layers: Array.from(new Set(withLayers.flatMap((v) => v.layers))) } : {}),
    roles: mine.map((v) => v.role),
  };
}
