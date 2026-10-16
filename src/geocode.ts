/** Ricerca di indirizzi e luoghi con Nominatim o Photon (via proxy nginx /geocode, vedi 35-proxy-config.sh). */
export type GeocoderType = "nominatim" | "photon";
export interface GeocoderConfig { type: GeocoderType; url: string; country?: string; lang?: string }
export interface Place { label: string; sub?: string; lng: number; lat: number; bbox?: [number, number, number, number] }

const enc = encodeURIComponent;
export const MIN_QUERY = 3;

export function geocodeUrl(g: GeocoderConfig, q: string, bias?: { lng: number; lat: number }, limit = 6): string {
  const base = g.url.replace(/\/$/, "");
  const lang = g.lang || "it";
  if (g.type === "photon") {
    let u = `${base}/api?q=${enc(q)}&limit=${limit}&lang=${enc(lang)}`;
    if (bias) u += `&lat=${bias.lat.toFixed(4)}&lon=${bias.lng.toFixed(4)}`;
    return u;
  }
  let u = `${base}/search?q=${enc(q)}&format=jsonv2&limit=${limit}&accept-language=${enc(lang)}`;
  if (g.country) u += `&countrycodes=${enc(g.country.toLowerCase())}`;
  return u;
}

const num = (v: unknown) => (v === null || v === undefined || v === "" ? NaN : Number(v));
const compact = (parts: unknown[]) => parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").map((p) => p.trim());

export function parseNominatim(json: unknown): Place[] {
  if (!Array.isArray(json)) return [];
  const out: Place[] = [];
  for (const r of json as any[]) {
    const lat = num(r?.lat), lng = num(r?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const parts = String(r.display_name ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const label = (typeof r.name === "string" && r.name.trim()) || parts[0] || "(senza nome)";
    const sub = parts.filter((p) => p !== label).slice(0, 4).join(", ");
    // boundingbox di Nominatim: [sud, nord, ovest, est] (stringhe)
    const bb = Array.isArray(r.boundingbox) ? r.boundingbox.map(num) : [];
    const bbox = bb.length === 4 && bb.every(Number.isFinite) ? ([bb[2], bb[0], bb[3], bb[1]] as Place["bbox"]) : undefined;
    out.push({ label, ...(sub ? { sub } : {}), lng, lat, ...(bbox ? { bbox } : {}) });
  }
  return out;
}

export function parsePhoton(json: unknown): Place[] {
  const fs = (json as any)?.features;
  if (!Array.isArray(fs)) return [];
  const out: Place[] = [];
  for (const f of fs) {
    const c = f?.geometry?.coordinates;
    const lng = num(c?.[0]), lat = num(c?.[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const p = f.properties ?? {};
    const street = compact([p.street, p.housenumber]).join(" ");
    const label = compact([p.name])[0] || street || compact([p.city, p.state, p.country])[0] || "(senza nome)";
    const sub = compact([street && street !== label ? street : "", p.postcode, p.city !== label ? p.city : "", p.state, p.country]).join(", ");
    // extent di Photon: [ovest, nord, est, sud]
    const e = Array.isArray(p.extent) ? p.extent.map(num) : [];
    const bbox = e.length === 4 && e.every(Number.isFinite) ? ([e[0], e[3], e[2], e[1]] as Place["bbox"]) : undefined;
    out.push({ label, ...(sub ? { sub } : {}), lng, lat, ...(bbox ? { bbox } : {}) });
  }
  return out;
}

export async function searchPlaces(g: GeocoderConfig, q: string, signal?: AbortSignal, bias?: { lng: number; lat: number }): Promise<Place[]> {
  const term = q.trim();
  if (term.length < MIN_QUERY) return [];
  const r = await fetch(geocodeUrl(g, term, bias), { signal, headers: { Accept: "application/json" } });
  if (r.status === 429) throw new Error("troppe richieste al servizio di ricerca: riprova tra qualche secondo");
  if (!r.ok) throw new Error(`servizio di ricerca non disponibile (HTTP ${r.status})`);
  let json: unknown;
  try {
    json = await r.json();
  } catch {
    throw new Error("risposta del servizio di ricerca non valida");
  }
  return (g.type === "photon" ? parsePhoton(json) : parseNominatim(json));
}
