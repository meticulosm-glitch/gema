export interface TimeInfo { extent: string; default?: string; values?: string[] }

export interface StyleInfo { name: string; title: string }

export interface Product {
  name: string;       // es. "iride:ndvi_2026"
  title: string;
  workspace: string;
  bbox?: [number, number, number, number]; // west, south, east, north (EPSG:4326)
  time?: TimeInfo;    // dimensione TIME, se il layer ne ha una
  styles?: StyleInfo[]; // stili (SLD) associati al layer in GeoServer; il primo è quello predefinito
  abstract?: string;      // descrizione del layer (Abstract)
  keywords?: string[];    // parole chiave
  attribution?: { title?: string; url?: string }; // fonte dei dati, se dichiarata
  metadataUrl?: string;   // link ai metadati, se dichiarato
  vector?: boolean;   // true = ha un feature type WFS (tabella, dashboard, modifica); false = raster/gruppo; undefined = non verificato
}

const MAX_TIME_VALUES = 500;

/** Elenca i layer "foglia" di un WMS GetCapabilities 1.3.0 (nodi contenitore e gruppi esclusi). */
export function parseCapabilities(xml: string): Product[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) throw new Error("risposta non XML: /geoserver non instradato a GeoServer?");
  const child = (el: Element, tag: string) => Array.from(el.children).find((c) => c.localName === tag);
  const text = (el: Element, tag: string) => child(el, tag)?.textContent?.trim();

  const list: Product[] = [];
  for (const l of Array.from(doc.getElementsByTagName("Layer"))) {
    if (l.getElementsByTagName("Layer").length > 0) continue;
    const name = text(l, "Name");
    if (!name) continue;

    let bbox: Product["bbox"];
    const bb = child(l, "EX_GeographicBoundingBox");
    if (bb) {
      const v = ["westBoundLongitude", "southBoundLatitude", "eastBoundLongitude", "northBoundLatitude"].map((t) => parseFloat(text(bb, t) ?? ""));
      if (v.every(Number.isFinite)) bbox = v as Product["bbox"];
    }

    let time: TimeInfo | undefined;
    const dim = Array.from(l.children).find((c) => c.localName === "Dimension" && c.getAttribute("name")?.toLowerCase() === "time");
    if (dim) {
      const extent = (dim.textContent ?? "").trim();
      const parts = extent.split(",").map((s) => s.trim()).filter(Boolean);
      const hasRange = parts.some((p) => p.includes("/"));
      time = {
        extent,
        default: dim.getAttribute("default") ?? undefined,
        // elenco di date discrete -> menu (le più recenti per prime); intervalli o elenchi enormi -> testo libero
        values: !hasRange && parts.length > 0 && parts.length <= MAX_TIME_VALUES ? parts.slice().reverse() : undefined,
      };
    }

    const styles: StyleInfo[] = [];
    for (const st of Array.from(l.children).filter((c) => c.localName === "Style")) {
      const sn = text(st, "Name");
      if (sn && !styles.some((x) => x.name === sn)) styles.push({ name: sn, title: text(st, "Title") || sn });
    }

    const abstract = text(l, "Abstract");
    const kwList = child(l, "KeywordList");
    const keywords = kwList
      ? Array.from(new Set(Array.from(kwList.children).filter((c) => c.localName === "Keyword").map((c) => c.textContent?.trim() ?? "").filter(Boolean)))
      : [];
    const href = (el: Element | undefined) => {
      const o = el && Array.from(el.children).find((c) => c.localName === "OnlineResource");
      return o?.getAttribute("xlink:href") || o?.getAttribute("href") || undefined;
    };
    const attrEl = child(l, "Attribution");
    const attribution = attrEl ? { title: text(attrEl, "Title"), url: href(attrEl) } : undefined;
    const metadataUrl = href(child(l, "MetadataURL"));

    list.push({
      name,
      title: text(l, "Title") || name,
      ...(abstract ? { abstract } : {}),
      ...(keywords.length > 0 ? { keywords } : {}),
      ...(attribution && (attribution.title || attribution.url) ? { attribution } : {}),
      ...(metadataUrl ? { metadataUrl } : {}),
      workspace: name.includes(":") ? name.slice(0, name.indexOf(":")) : "(default)",
      bbox,
      time,
      styles: styles.length > 0 ? styles : undefined,
    });
  }
  list.sort((a, b) => a.title.localeCompare(b.title));
  return list;
}

/** Nomi dei feature type pubblicati in WFS (= i layer vettoriali) da un WFS GetCapabilities. */
export function parseWfsTypes(xml: string): Set<string> {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) throw new Error("risposta WFS non XML");
  const names = new Set<string>();
  for (const ft of Array.from(doc.getElementsByTagName("*")).filter((e) => e.localName === "FeatureType")) {
    const n = Array.from(ft.children).find((c) => c.localName === "Name")?.textContent?.trim();
    if (n) names.add(n);
  }
  return names;
}

/** Layer vettoriali secondo il WFS; null se il WFS non risponde (allora non si nasconde nulla). */
export async function fetchVectorNames(gsUrl: string, token?: string, signal?: AbortSignal): Promise<Set<string> | null> {
  try {
    const r = await fetch(`${gsUrl}/ows?service=WFS&version=2.0.0&request=GetCapabilities`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal });
    if (!r.ok) return null;
    const names = parseWfsTypes(await r.text());
    return names.size > 0 ? names : null;
  } catch {
    return null;
  }
}

/** Marca ogni prodotto come vettoriale (presente in WFS) o raster. */
export function markVector(list: Product[], vec: Set<string> | null): Product[] {
  return vec ? list.map((p) => ({ ...p, vector: vec.has(p.name) })) : list;
}

/** Scarica e interpreta il GetCapabilities di GeoServer. */
export async function fetchProducts(gsUrl: string, token?: string): Promise<Product[]> {
  const r = await fetch(`${gsUrl}/ows?service=WMS&version=1.3.0&request=GetCapabilities`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return markVector(parseCapabilities(await r.text()), await fetchVectorNames(gsUrl, token));
}
