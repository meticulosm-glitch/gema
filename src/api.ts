import type Keycloak from "keycloak-js";
import type * as maplibregl from "maplibre-gl";

export interface Feature {
  id?: string;
  geometry: any | null;
  properties: Record<string, unknown> | null;
}

/** Filtro CQL, dimensione TIME e stile (SLD) attivi su un layer. */
export interface LayerParams { cql?: string; time?: string; style?: string }

export interface Field { name: string; type: string }
export interface Schema {
  prefix: string;     // prefisso del workspace (per le transazioni WFS-T)
  ns: string;         // namespace del workspace
  typeName: string;   // nome del layer senza workspace
  geomName: string;   // colonna geometrica
  geomType: string;   // Point, MultiPolygon, ... oppure Geometry (generica)
  fields: Field[];    // attributi non geometrici, con il tipo XSD locale (string, double, date, ...)
}

const enc = encodeURIComponent;
const hdr = (kc: Keycloak | null): Record<string, string> => (kc?.token ? { Authorization: `Bearer ${kc.token}` } : {});

/** Estrae il testo di una ServiceException/ExceptionReport di GeoServer, se presente. */
function exceptionText(body: string): string | null {
  const m = body.match(/<(?:\w+:)?ServiceException[^>]*>([\s\S]*?)<\/(?:\w+:)?ServiceException>/);
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/\s+/g, " ").trim().slice(0, 300) || "errore di GeoServer" : null;
}

async function getText(url: string, kc: Keycloak | null, signal?: AbortSignal): Promise<string> {
  const r = await fetch(url, signal ? { headers: hdr(kc), signal } : { headers: hdr(kc) });
  const body = await r.text();
  if (!r.ok) throw new Error(exceptionText(body) ?? `HTTP ${r.status}`);
  return body;
}

async function getJson(url: string, kc: Keycloak | null, signal?: AbortSignal): Promise<any> {
  const body = await getText(url, kc, signal);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(exceptionText(body) ?? "risposta non JSON");
  }
}

/** URL dei tile WMS di un layer, con filtro CQL, tempo e un contatore per forzare il ricaricamento. */
export function wmsTileUrl(gsUrl: string, layer: string, p: LayerParams = {}, rev = 0): string {
  let u =
    `${gsUrl}/wms?service=WMS&version=1.1.1&request=GetMap&layers=${enc(layer)}` +
    `&styles=${enc(p.style?.trim() ?? "")}&format=image/png&transparent=true&srs=EPSG:3857&width=256&height=256`;
  if (p.cql?.trim()) u += `&cql_filter=${enc(p.cql.trim())}`;
  if (p.time?.trim()) u += `&time=${enc(p.time.trim())}`;
  if (rev) u += `&_r=${rev}`;
  return `${u}&bbox={bbox-epsg-3857}`;
}

/** WMS GetFeatureInfo su un layer, nel punto cliccato. Le geometrie sono in lon/lat. */
export async function getFeatureInfo(
  gsUrl: string,
  kc: Keycloak | null,
  layer: string,
  map: maplibregl.Map,
  ll: { lng: number; lat: number },
  p: LayerParams = {},
  signal?: AbortSignal,
): Promise<Feature[]> {
  // finestra 101x101 px centrata sul clic, espressa in gradi con la risoluzione locale della mappa
  const pt = map.project([ll.lng, ll.lat]);
  const east = map.unproject([pt.x + 1, pt.y]);
  const south = map.unproject([pt.x, pt.y + 1]);
  const dx = Math.abs(east.lng - ll.lng) || 1e-6;
  const dy = Math.abs(ll.lat - south.lat) || 1e-6;
  const H = 50;
  const bbox = [ll.lng - H * dx, ll.lat - H * dy, ll.lng + H * dx, ll.lat + H * dy].join(",");
  let url =
    `${gsUrl}/wms?service=WMS&version=1.1.1&request=GetFeatureInfo&layers=${enc(layer)}&query_layers=${enc(layer)}` +
    `&styles=${enc(p.style?.trim() ?? "")}&srs=EPSG:4326&bbox=${bbox}&width=101&height=101&x=50&y=50` +
    `&info_format=application/json&feature_count=10&buffer=6`;
  if (p.cql?.trim()) url += `&cql_filter=${enc(p.cql.trim())}`;
  if (p.time?.trim()) url += `&time=${enc(p.time.trim())}`;
  return ((await getJson(url, kc, signal)).features ?? []) as Feature[];
}

/** WFS GetFeature (1.0.0: ordine lon/lat garantito) per tabella attributi e dashboard. */
export async function getWfsFeatures(
  gsUrl: string,
  kc: Keycloak | null,
  layer: string,
  cql?: string,
  max = 500,
  props?: string[],
): Promise<Feature[]> {
  let url =
    `${gsUrl}/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=${enc(layer)}` +
    `&outputFormat=application/json&maxFeatures=${max}&srsName=EPSG:4326`;
  if (cql?.trim()) url += `&cql_filter=${enc(cql.trim())}`;
  if (props?.length) url += `&propertyName=${enc(props.join(","))}`;
  return ((await getJson(url, kc)).features ?? []) as Feature[];
}

/** Numero di oggetti di un layer vettoriale (WFS resultType=hits, senza scaricarli); null se il server non lo dice. */
export async function getWfsCount(gsUrl: string, kc: Keycloak | null, layer: string, cql?: string): Promise<number | null> {
  let url = `${gsUrl}/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=${enc(layer)}&resultType=hits`;
  if (cql?.trim()) url += `&cql_filter=${enc(cql.trim())}`;
  const body = await getText(url, kc);
  const m = body.match(/numberMatched="(\d+)"/) ?? body.match(/numberOfFeatures="(\d+)"/);
  return m ? Number(m[1]) : null;
}

/** Un singolo oggetto per id, con la geometria completa (GetFeatureInfo può generalizzarla). */
export async function getWfsFeatureById(gsUrl: string, kc: Keycloak | null, layer: string, id: string): Promise<Feature | null> {
  const url =
    `${gsUrl}/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=${enc(layer)}` +
    `&outputFormat=application/json&srsName=EPSG:4326&featureId=${enc(id)}`;
  return ((await getJson(url, kc)).features?.[0] ?? null) as Feature | null;
}

// ---------------------------------------------------------------- schema di un layer vettoriale
const GEOM_TYPES: Record<string, string> = {
  PointPropertyType: "Point",
  LineStringPropertyType: "LineString",
  PolygonPropertyType: "Polygon",
  MultiPointPropertyType: "MultiPoint",
  MultiLineStringPropertyType: "MultiLineString",
  MultiPolygonPropertyType: "MultiPolygon",
  CurvePropertyType: "LineString",
  MultiCurvePropertyType: "MultiLineString",
  SurfacePropertyType: "Polygon",
  MultiSurfacePropertyType: "MultiPolygon",
  MultiGeometryPropertyType: "Geometry",
  GeometryPropertyType: "Geometry",
  GeometryCollectionPropertyType: "Geometry",
};

function parseSchema(xml: string, layer: string, allowNoGeom = false): Schema {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const root = doc.documentElement;
  if (!root || doc.querySelector("parsererror") || root.localName !== "schema") throw new Error(exceptionText(xml) ?? "schema non disponibile");
  const [prefix, typeName] = layer.includes(":") ? [layer.slice(0, layer.indexOf(":")), layer.slice(layer.indexOf(":") + 1)] : ["", layer];
  const fields: Field[] = [];
  let geomName = "";
  let geomType = "";
  for (const el of Array.from(doc.getElementsByTagName("*"))) {
    if (el.localName !== "element") continue;
    const parent = el.parentNode as Element | null;
    if (!parent || parent.localName === "schema") continue; // salta la dichiarazione dell'elemento radice
    const name = el.getAttribute("name");
    const type = el.getAttribute("type");
    if (!name || !type) continue;
    const local = type.includes(":") ? type.slice(type.indexOf(":") + 1) : type;
    if (GEOM_TYPES[local]) {
      if (!geomName) { geomName = name; geomType = GEOM_TYPES[local]; }
    } else fields.push({ name, type: local });
  }
  if (!geomName && !allowNoGeom) throw new Error("il layer non ha una colonna geometrica (layer raster o gruppo)");
  return { prefix: prefix || "ns", ns: root.getAttribute("targetNamespace") ?? "", typeName, geomName, geomType, fields };
}

const schemaCache = new Map<string, Promise<Schema>>();

/** Schema del layer via WFS DescribeFeatureType (in cache). Fallisce per i raster: serve anche a distinguerli. */
export function describeLayer(gsUrl: string, kc: Keycloak | null, layer: string): Promise<Schema> {
  const key = `${gsUrl}|${layer}`;
  let p = schemaCache.get(key);
  if (!p) {
    p = getText(`${gsUrl}/ows?service=WFS&version=1.0.0&request=DescribeFeatureType&typeName=${enc(layer)}`, kc).then((x) => parseSchema(x, layer));
    p.catch(() => schemaCache.delete(key));
    schemaCache.set(key, p);
  }
  return p;
}

/** Schema di una tabella (anche senza geometria), per le tabelle di configurazione. */
export function describeTable(gsUrl: string, kc: Keycloak | null, layer: string): Promise<Schema> {
  const key = `${gsUrl}|${layer}|table`;
  let p = schemaCache.get(key);
  if (!p) {
    p = getText(`${gsUrl}/ows?service=WFS&version=1.0.0&request=DescribeFeatureType&typeName=${enc(layer)}`, kc).then((x) => parseSchema(x, layer, true));
    p.catch(() => schemaCache.delete(key));
    schemaCache.set(key, p);
  }
  return p;
}

/** Invia una transazione WFS-T. Lancia con un messaggio comprensibile se GeoServer o il proxy la rifiutano. */
export async function wfsTransaction(gsUrl: string, kc: Keycloak | null, xml: string): Promise<void> {
  const r = await fetch(`${gsUrl}/wfs`, { method: "POST", headers: { "Content-Type": "text/xml", ...hdr(kc) }, body: xml });
  const body = await r.text();
  if (r.status === 401) throw new Error("non autorizzato (HTTP 401): credenziali di scrittura mancanti o errate");
  if (r.status === 403) throw new Error("scrittura negata (HTTP 403): il proxy è in sola lettura o l'utente non ha diritti di scrittura");
  const ex = exceptionText(body);
  if (ex) throw new Error(ex);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (/<(?:\w+:)?FAILED\s*\/?>/.test(body)) {
    const m = body.match(/<(?:\w+:)?Message>([\s\S]*?)<\/(?:\w+:)?Message>/);
    throw new Error(m?.[1]?.trim() || "transazione rifiutata da GeoServer");
  }
  if (!/<(?:\w+:)?SUCCESS/.test(body)) throw new Error("risposta inattesa da GeoServer");
}

/** Legenda di un layer (nello stile scelto). Per i raster con ColorMap GeoServer disegna la rampa con le etichette dei valori. */
export async function fetchLegendBlob(gsUrl: string, kc: Keycloak | null, layer: string, style?: string): Promise<Blob> {
  let url =
    `${gsUrl}/wms?service=WMS&version=1.1.0&request=GetLegendGraphic&format=image/png&layer=${enc(layer)}` +
    `&width=20&height=20&legend_options=fontAntiAliasing:true`;
  if (style?.trim()) url += `&style=${enc(style.trim())}`;
  const r = await fetch(url, { headers: hdr(kc) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const b = await r.blob();
  if (!b.type.startsWith("image/")) throw new Error("legenda non disponibile");
  return b;
}
