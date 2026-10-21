/** Stato di una vista della mappa: è quello che finisce nel link (#s=…) e nelle viste salvate. */
/** `render` = "v": disegno vettoriale (vector tiles); assente = immagine WMS (anche nei link delle versioni precedenti). */
export type ViewLayer = [name: string, opacity: number, cql: string, time: string, style: string, render?: "v"];

export interface ViewState {
  v?: number[];      // [lon, lat, zoom, pitch, bearing]
  l: ViewLayer[];    // layer attivi, nell'ordine di accensione
  b?: string;        // id dello sfondo
}

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Rende sicuro un oggetto letto da un link o da una vista salvata (può essere scritto a mano o da una versione precedente). */
export function sanitizeViewState(o: any): ViewState {
  if (!o || typeof o !== "object") return { l: [] };
  const v = Array.isArray(o.v) && o.v.length >= 3 && o.v.every(isNum) ? (o.v as number[]) : undefined;
  const l: ViewLayer[] = Array.isArray(o.l)
    ? o.l
        .filter((x: unknown) => Array.isArray(x) && typeof x[0] === "string" && x[0] !== "")
        .map((x: any[]) => [x[0], Number(x[1]) || 1, String(x[2] ?? ""), String(x[3] ?? ""), String(x[4] ?? ""), ...(x[5] === "v" ? ["v"] : [])] as ViewLayer)
    : [];
  const b = typeof o.b === "string" && /^[\w-]{1,40}$/.test(o.b) ? o.b : undefined;
  return { v, l, ...(b ? { b } : {}) };
}

/** Legge `#s=<json>`; un link non valido dà una vista vuota. */
export function parseHash(hash: string): ViewState {
  try {
    const m = hash.match(/^#s=(.+)$/);
    return m ? sanitizeViewState(JSON.parse(decodeURIComponent(m[1]))) : { l: [] };
  } catch {
    return { l: [] };
  }
}

export const encodeHash = (s: ViewState) => `#s=${encodeURIComponent(JSON.stringify(s))}`;

/** Stato dalla mappa corrente. */
export function captureView(
  map: { getCenter(): { lng: number; lat: number }; getZoom(): number; getPitch(): number; getBearing(): number },
  active: string[],
  layers: Record<string, { opacity?: number; cql?: string; time?: string; style?: string; vt?: boolean } | undefined>,
  basemap?: string,
): ViewState {
  const c = map.getCenter();
  const r5 = (n: number) => Math.round(n * 1e5) / 1e5;
  return {
    v: [r5(c.lng), r5(c.lat), Math.round(map.getZoom() * 100) / 100, Math.round(map.getPitch()), Math.round(map.getBearing())],
    l: active.map((n) => [n, layers[n]?.opacity ?? 1, layers[n]?.cql ?? "", layers[n]?.time ?? "", layers[n]?.style ?? "", ...(layers[n]?.vt ? ["v"] : [])] as ViewLayer),
    ...(basemap ? { b: basemap } : {}),
  };
}
