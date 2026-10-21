// GeoServer finto per i test: WMS/WFS/WFS-T in memoria, con autenticazione Basic e log delle richieste.
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import zlib from "node:zlib";
const require = createRequire(import.meta.url);
const sharp = require("sharp");
const { DOMParser } = require("@xmldom/xmldom");
// vector tile come l'estensione "vectortiles" di GeoServer (librerie che arrivano con maplibre-gl)
const { geoJSONToTile } = await import("@maplibre/geojson-vt");
const { fromGeojsonVt } = await import("@maplibre/vt-pbf");
let mvtOff = false; // /__mvt?off=1: GeoServer senza l'estensione vectortiles

const PORT = Number(process.env.MOCK_PORT || 8600);
const READ = "Basic " + Buffer.from("reader:rpass").toString("base64");
const WRITE = "Basic " + Buffer.from("writer:wpass").toString("base64");

const sq = (x, y, w = 0.04, h = 0.035) => [[[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]]];
const KINDS = ["A", "A", "A", "B", "B", "C", "C"];
const initial = () => ({
  "iride:parcels": {
    title: "Particelle", abstract: "Particelle catastali di prova", keywords: ["catasto", "particelle"], attribution: ["Agenzia di prova", "https://example.org/fonte"], metadataUrl: "javascript:alert(1)", geomName: "geom", gtype: "MultiPolygonPropertyType", color: "#2e7d32",
    fields: [["name", "string"], ["kind", "string"], ["area", "double"], ["surveyed", "date"]],
    next: 8,
    features: KINDS.map((k, i) => ({
      id: `parcels.${i + 1}`,
      geometry: { type: "MultiPolygon", coordinates: sq(12.4 + i * 0.05, 41.85) },
      properties: { name: `Particella ${i + 1}`, kind: k, area: 100 * (i + 1), surveyed: `2026-0${(i % 3) + 1}-1${i}` },
    })),
  },
  "iride:sensors": {
    title: "Sensori", geomName: "the_geom", gtype: "PointPropertyType", color: "#d84315", timeProp: "obs",
    fields: [["code", "string"], ["temp", "double"], ["obs", "date"]],
    next: 6,
    features: [0, 1, 2, 3, 4].map((i) => ({
      id: `sensors.${i + 1}`,
      geometry: { type: "Point", coordinates: [12.45 + i * 0.06, 41.95] },
      properties: { code: `S${i + 1}`, temp: 10 + i, obs: ["2026-01-01", "2026-02-01", "2026-03-01"][i % 3] },
    })),
  },
  "demo:roads": {
    title: "Strade", geomName: "geom", gtype: "LineStringPropertyType", color: "#455a64",
    fields: [["road", "string"]], next: 4,
    features: [0, 1, 2].map((i) => ({
      id: `roads.${i + 1}`, geometry: { type: "LineString", coordinates: [[12.4, 41.8 + i * 0.05], [12.8, 41.82 + i * 0.05]] },
      properties: { road: `SS${i + 1}` },
    })),
  },
  "mapp:role_rules": { title: "role_rules", hidden: true, geomName: null, color: "#000", fields: [["role", "string"], ["layers", "string"], ["tools", "string"], ["updated_by", "string"], ["updated_at", "string"]], next: 1, features: [] },
  "mapp:dashboards": { title: "dashboards", hidden: true, geomName: null, color: "#000", fields: [["title", "string"], ["description", "string"], ["roles", "string"], ["definition", "string"], ["updated_by", "string"], ["updated_at", "string"]], next: 1, features: [] },
  "mapp:saved_views": { title: "saved_views", hidden: true, geomName: null, color: "#000", fields: [["owner", "string"], ["name", "string"], ["definition", "string"], ["created_at", "string"]], next: 1, features: [] },
  "mapp:announcements": { title: "announcements", hidden: true, geomName: null, color: "#000", fields: [["message", "string"], ["level", "string"], ["starts_at", "string"], ["ends_at", "string"], ["roles", "string"], ["dismissible", "boolean"], ["active", "boolean"], ["updated_by", "string"], ["updated_at", "string"]], next: 1, features: [] },
  "mapp:change_log": { title: "change_log", hidden: true, geomName: null, color: "#000", fields: [["table_name", "string"], ["row_id", "int"], ["op", "string"], ["old_data", "string"], ["new_data", "string"], ["changed_by", "string"], ["db_user", "string"], ["changed_at", "dateTime"]], next: 1, features: [] },
  "mapp:usage_events": { title: "usage_events", hidden: true, geomName: null, color: "#000", fields: [["at", "dateTime"], ["session", "string"], ["username", "string"], ["roles", "string"], ["kind", "string"], ["target", "string"], ["detail", "string"]], next: 1, features: [] },
  "mapp:usage_daily": { title: "usage_daily", hidden: true, view: "daily", geomName: null, color: "#000", fields: [["day", "date"], ["kind", "string"], ["target", "string"], ["events", "int"], ["sessions", "int"], ["users", "int"]], next: 1, features: [] },
  "mapp:usage_sessions": { title: "usage_sessions", hidden: true, view: "sessions", geomName: null, color: "#000", fields: [["day", "date"], ["events", "int"], ["sessions", "int"], ["users", "int"]], next: 1, features: [] },
  "mapp:usage_roles": { title: "usage_roles", hidden: true, view: "roles", geomName: null, color: "#000", fields: [["day", "date"], ["role", "string"], ["events", "int"], ["sessions", "int"]], next: 1, features: [] },
  "mapp:usage_users": { title: "usage_users", hidden: true, view: "users", geomName: null, color: "#000", fields: [["day", "date"], ["username", "string"], ["events", "int"], ["sessions", "int"]], next: 1, features: [] },
  "mapp:dashboard_drafts": { title: "dashboard_drafts", hidden: true, geomName: null, color: "#000", unique: "dashboard_id", fields: [["dashboard_id", "string"], ["title", "string"], ["description", "string"], ["roles", "string"], ["definition", "string"], ["updated_by", "string"], ["updated_at", "string"]], next: 1, features: [] },
  "mapp:edit_forms": { title: "edit_forms", hidden: true, geomName: null, color: "#000", unique: "layer", fields: [["layer", "string"], ["definition", "string"], ["updated_by", "string"], ["updated_at", "string"]], next: 1, features: [] },
  "mapp:role_views": { title: "role_views", hidden: true, geomName: null, color: "#000", unique: "role", fields: [["role", "string"], ["bbox", "string"], ["basemap", "string"], ["layers", "string"], ["updated_by", "string"], ["updated_at", "string"]], next: 1, features: [] },
  // catalogo prodotti: come in PostgreSQL, layer e folder_key unici e "nascosto" escluso da "acceso di default"
  "mapp:catalog_folders": { title: "catalog_folders", hidden: true, geomName: null, color: "#000", unique: "folder_key", fields: [["folder_key", "string"], ["parent_key", "string"], ["title", "string"], ["description", "string"], ["position", "int"], ["expanded", "boolean"], ["hidden", "boolean"], ["updated_by", "string"], ["updated_at", "string"]], next: 1, features: [] },
  "mapp:catalog_layers": { title: "catalog_layers", hidden: true, geomName: null, color: "#000", unique: "layer", fields: [["layer", "string"], ["folder_key", "string"], ["position", "int"], ["title", "string"], ["description", "string"], ["hidden", "boolean"], ["default_on", "boolean"], ["updated_by", "string"], ["updated_at", "string"]], next: 1, features: [] },
  "iride:ndvi": { title: "NDVI", raster: true, color: "#66bb6a", time: "2026-01-01/2026-12-31/P1D" },
});
let store = initial();
const log = [];
const geoLog = [];
let tile;

const NS = { iride: "http://iride.example/iride", demo: "http://iride.example/demo", mapp: "http://iride.example/mapp" };
let tablesOff = false;
let tablesOffOnly = null; // /__tables?off=1&only=mapp:role_views: solo quelle tabelle "non pubblicate"
const isOff = (name) => tablesOff && store[name]?.hidden && (!tablesOffOnly || tablesOffOnly.includes(name));
const BOX = { "iride:parcels": [12.4, 41.85, 12.8, 41.9], "iride:sensors": [12.4, 41.9, 12.8, 42.0], "demo:roads": [12.4, 41.8, 12.8, 41.95], "iride:ndvi": [12, 41, 13, 43] };

// ---------------------------------------------------------------- CQL (sottoinsieme)
function splitTop(s, sep) {
  const out = []; let depth = 0, q = false, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") q = !q;
    if (q) continue;
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (depth === 0 && s.slice(i, i + sep.length).toUpperCase() === sep) { out.push(s.slice(last, i)); last = i + sep.length; i += sep.length - 1; }
  }
  out.push(s.slice(last));
  return out;
}
function stripParens(s) {
  s = s.trim();
  while (s.startsWith("(") && s.endsWith(")")) {
    let d = 0, ok = true, q = false;
    for (let i = 0; i < s.length - 1; i++) { if (s[i] === "'") q = !q; if (q) continue; if (s[i] === "(") d++; if (s[i] === ")") d--; if (d === 0) { ok = false; break; } }
    if (!ok) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}
const lit = (v) => { v = v.trim(); if (v.startsWith("'")) return v.slice(1, -1).replace(/''/g, "'"); if (/^(true|false)$/i.test(v)) return v.toLowerCase(); return Number.isNaN(Number(v)) ? v : Number(v); };
const bboxOfGeom = (g) => { const pts = []; (function w(c) { if (typeof c[0] === "number") pts.push(c); else c.forEach(w); })(g.coordinates); const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
const inter = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

function matcher(cql) {
  if (!cql || !cql.trim()) return () => true;
  const ors = splitTop(stripParens(cql), " OR ");
  if (ors.length > 1) { const fns = ors.map((o) => matcher(o)); return (f) => fns.some((fn) => fn(f)); }
  const terms = splitTop(stripParens(cql), " AND ").map((t) => stripParens(t));
  const tests = terms.map((t) => {
    let m;
    if (splitTop(t, " AND ").length > 1 || splitTop(t, " OR ").length > 1) return matcher(t); // gruppo tra parentesi
    if ((m = t.match(/^BBOX\(\s*"?[\w]+"?\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)/i))) {
      const b = m.slice(1, 5).map(Number); return (f) => f.geometry && inter(bboxOfGeom(f.geometry), b);
    }
    if ((m = t.match(/^"?(\w+)"?\s+IS\s+NULL$/i))) return (f) => f.properties[m[1]] == null || f.properties[m[1]] === "";
    if ((m = t.match(/^"?(\w+)"?\s+I?LIKE\s+(.+)$/i))) { const re = new RegExp("^" + String(lit(m[2])).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", /ILIKE/i.test(t) ? "i" : ""); return (f) => re.test(String(f.properties[m[1]] ?? "")); }
    if ((m = t.match(/^"?(\w+)"?\s+DURING\s+(\S+)\/(\S+)$/i))) return (f) => { const v = String(f.properties[m[1]] ?? ""); return v >= m[2].slice(0, v.length) && v < m[3].slice(0, v.length); };
    if ((m = t.match(/^"?(\w+)"?\s*(<=|>=|<>|!=|=|<|>)\s*(.+)$/))) {
      const [, k, op, raw] = m; const val = lit(raw);
      return (f) => {
        let v = f.properties[k]; if (v == null) return false;
        if (typeof val === "number") v = Number(v); else v = String(v);
        const val2 = typeof val === "string" ? val : val;
        switch (op) { case "=": return v == val2; case "<>": case "!=": return v != val2; case "<": return v < val2; case ">": return v > val2; case "<=": return v <= val2; case ">=": return v >= val2; }
      };
    }
    throw new Error(`CQL non supportato: ${t}`);
  });
  return (f) => tests.every((fn) => fn(f));
}

// ---------------------------------------------------------------- helpers
const exception = (res, status, msg, type = "application/xml") => { res.writeHead(status, { "Content-Type": type }); res.end(`<?xml version="1.0"?><ServiceExceptionReport version="1.1.1"><ServiceException>${msg}</ServiceException></ServiceExceptionReport>`); };
const json = (res, obj) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const merc = ([x, y]) => [x * 20037508.34 / 180, Math.log(Math.tan((90 + y) * Math.PI / 360)) / (Math.PI / 180) * 20037508.34 / 180];

/** Le viste usage_* di mapp-config.sql, calcolate dagli eventi (come GROUP BY in PostgreSQL). */
function usageView(kind) {
  const ev = store["mapp:usage_events"].features.map((f) => f.properties);
  const groups = new Map();
  const add = (key, base, e) => {
    const g = groups.get(key) ?? { ...base, events: 0, s: new Set(), u: new Set() };
    g.events++; g.s.add(e.session); if (e.username) g.u.add(e.username); groups.set(key, g);
  };
  for (const e of ev) {
    const day = String(e.at).slice(0, 10);
    if (kind === "daily") add(`${day}|${e.kind}|${e.target}`, { day, kind: e.kind, target: e.target ?? "" }, e);
    else if (kind === "sessions") add(day, { day }, e);
    else if (kind === "users") { if (e.username) add(`${day}|${e.username}`, { day, username: e.username }, e); }
    else for (const role of JSON.parse(e.roles || "[]")) add(`${day}|${role}`, { day, role }, e);
  }
  return Array.from(groups.values()).map(({ s, u, ...g }, i) => ({ id: `usage_${kind}.fid-${i}`, geometry: null, properties: { ...g, sessions: s.size, ...(kind === "daily" || kind === "sessions" ? { users: u.size } : {}) } }));
}

function select(layer, q) {
  const L = store[layer]; if (!L || L.raster) return null;
  if (isOff(layer)) return null;
  const t = q.get("time");
  let list = (L.view ? usageView(L.view) : L.features).filter(matcher(q.get("cql_filter")));
  if (t && L.timeProp) list = list.filter((f) => String(f.properties[L.timeProp]).slice(0, 10) === t.slice(0, 10));
  return list;
}

// Come GeoServer: le eccezioni WMS arrivano con status 200 e corpo XML (la cache dei tile non deve conservarle).
const wmsException = (res, msg) => exception(res, 200, msg, "application/vnd.ogc.se_xml");
let getMapDelay = 0; // ms di attesa per ogni GetMap (/__slow?ms=…): rende misurabile il guadagno della cache

async function getMap(q, res) {
  if (getMapDelay) await new Promise((r) => setTimeout(r, getMapDelay));
  const layer = q.get("layers"); const L = store[layer]; if (!L) return wmsException(res, `layer ${layer} non trovato`);
  const [x0, y0, x1, y1] = q.get("bbox").split(",").map(Number);
  if ((q.get("format") || "").toLowerCase() === "application/vnd.mapbox-vector-tile") {
    if (mvtOff || L.raster) return wmsException(res, "Formato application/vnd.mapbox-vector-tile non supportato");
    let list; try { list = select(layer, q); } catch (e) { return wmsException(res, e.message); }
    // tile z/x/y dal riquadro EPSG:3857 (griglia a 256 px, come chiede MapLibre)
    const full = 20037508.342789244 * 2;
    const z = Math.round(Math.log2(full / (x1 - x0)));
    const n = 2 ** z;
    const tx = Math.round(((x0 + full / 2) / full) * n), ty = Math.round(((full / 2 - y1) / full) * n);
    const fc = { type: "FeatureCollection", features: list.filter((f) => f.geometry).map((f) => ({ type: "Feature", geometry: f.geometry, properties: Object.fromEntries(Object.entries(f.properties).filter(([, v]) => v != null)) })) };
    const tile = geoJSONToTile(fc, z, tx, ty, { extent: 4096, buffer: 64, clip: true });
    const buf = Buffer.from(fromGeojsonVt({ [layer.split(":")[1]]: tile }, { version: 2, extent: 4096 }));
    res.writeHead(200, { "Content-Type": "application/vnd.mapbox-vector-tile" }); return res.end(buf);
  }
  const W = Number(q.get("width") || 256), H = Number(q.get("height") || 256);
  const px = ([x, y]) => { const [mx, my] = merc([x, y]); return [((mx - x0) / (x1 - x0)) * W, ((y1 - my) / (y1 - y0)) * H]; };
  let shapes = "";
  if (L.raster) shapes = `<rect width="${W}" height="${H}" fill="${L.color}" fill-opacity="0.5"/>`;
  else {
    let q2 = q; let list;
    try { list = select(layer, q2); } catch (e) { return wmsException(res, e.message); }
    for (const f of list) {
      const g = f.geometry; if (!g) continue;
      if (g.type === "Point") { const [x, y] = px(g.coordinates); shapes += `<circle cx="${x}" cy="${y}" r="6" fill="${L.color}"/>`; }
      else if (g.type === "LineString") shapes += `<polyline fill="none" stroke="${L.color}" stroke-width="3" points="${g.coordinates.map((c) => px(c).join(",")).join(" ")}"/>`;
      else for (const poly of g.type === "Polygon" ? [g.coordinates] : g.coordinates) shapes += `<polygon fill="${L.color}" fill-opacity="0.6" stroke="${L.color}" points="${poly[0].map((c) => px(c).join(",")).join(" ")}"/>`;
    }
  }
  const png = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${shapes}</svg>`)).png().toBuffer();
  // intestazioni che un GeoServer può mandare (sessione, nessuna cache): il proxy deve ignorarle per i tile
  res.writeHead(200, { "Content-Type": "image/png", "Set-Cookie": "JSESSIONID=mock-reader-session; Path=/geoserver; HttpOnly", "Cache-Control": "no-cache" }); res.end(png);
}

function getFeatureInfo(q, res) {
  const layer = q.get("query_layers"); const [x0, y0, x1, y1] = q.get("bbox").split(",").map(Number);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, tol = ((x1 - x0) / 101) * 8, tolY = ((y1 - y0) / 101) * 8;
  let list; try { list = select(layer, q); } catch (e) { return exception(res, 400, e.message); }
  if (!list) return exception(res, 400, "layer non interrogabile");
  const hit = list.filter((f) => f.geometry && inter(bboxOfGeom(f.geometry), [cx - tol, cy - tolY, cx + tol, cy + tolY]));
  json(res, { type: "FeatureCollection", features: hit.map((f) => ({ type: "Feature", id: f.id, geometry: f.geometry, properties: f.properties })) });
}

function describe(q, res) {
  const layer = q.get("typeName"); const L = store[layer];
  if (!L || L.raster || isOff(layer)) return exception(res, 400, `Feature type ${layer} unknown`);
  const [p, n] = layer.split(":");
  const els = L.fields.map(([name, t]) => `<xsd:element maxOccurs="1" minOccurs="0" name="${name}" nillable="true" type="xsd:${t}"/>`).join("");
  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><xsd:schema xmlns:gml="http://www.opengis.net/gml" xmlns:${p}="${NS[p]}" xmlns:xsd="http://www.w3.org/2001/XMLSchema" elementFormDefault="qualified" targetNamespace="${NS[p]}"><xsd:import namespace="http://www.opengis.net/gml" schemaLocation="x"/><xsd:complexType name="${n}Type"><xsd:complexContent><xsd:extension base="gml:AbstractFeatureType"><xsd:sequence>${L.geomName ? `<xsd:element maxOccurs="1" minOccurs="0" name="${L.geomName}" nillable="true" type="gml:${L.gtype}"/>` : ""}${els}</xsd:sequence></xsd:extension></xsd:complexContent></xsd:complexType><xsd:element name="${n}" substitutionGroup="gml:_Feature" type="${p}:${n}Type"/></xsd:schema>`);
}

function getFeature(q, res) {
  const layer = q.get("typeName"); let list;
  try { list = select(layer, q); } catch (e) { return exception(res, 400, e.message); }
  if (!list) return exception(res, 400, `Feature type ${layer} unknown`);
  if (q.get("resulttype") === "hits") { res.writeHead(200, { "Content-Type": "text/xml" }); return res.end(`<?xml version="1.0"?><wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="${list.length}" numberReturned="0"/>`); }
  if (q.get("featureId")) list = list.filter((f) => f.id === q.get("featureId"));
  const sb = q.get("sortby"); // WFS 2.0: "campo DESC" (anche "campo D" / "campo+D")
  if (sb) {
    const [k, dir = "A"] = sb.split(",")[0].trim().split(/[\s+]+/);
    list = [...list].sort((a, b) => { const x = a.properties[k], y = b.properties[k]; return x == null ? 1 : y == null ? -1 : x < y ? -1 : x > y ? 1 : 0; });
    if (/^D/i.test(dir)) list.reverse();
  }
  list = list.slice(0, Number(q.get("maxFeatures") || q.get("count") || 1000));
  const props = q.get("propertyName")?.split(",");
  const fmt = (q.get("outputformat") || "").toLowerCase();
  if (fmt === "csv") return csv(res, store[layer], list);
  if (fmt === "shape-zip") return shapeZip(res, layer, list, q.get("format_options"));
  json(res, { type: "FeatureCollection", features: list.map((f) => ({ type: "Feature", id: f.id, geometry: f.geometry, properties: props ? Object.fromEntries(props.map((k) => [k, f.properties[k]])) : f.properties })) });
}

// ---------------------------------------------------------------- formati di scarico (come quelli di GeoServer, in piccolo)
const wkt = (g) => {
  const pt = (c) => c.join(" ");
  const ring = (r) => `(${r.map(pt).join(", ")})`;
  if (g.type === "Point") return `POINT (${pt(g.coordinates)})`;
  if (g.type === "LineString") return `LINESTRING (${g.coordinates.map(pt).join(", ")})`;
  if (g.type === "Polygon") return `POLYGON (${g.coordinates.map(ring).join(", ")})`;
  return `MULTIPOLYGON (${g.coordinates.map((p) => `(${p.map(ring).join(", ")})`).join(", ")})`;
};
const csvCell = (v) => { const t = v == null ? "" : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
function csv(res, L, list) {
  const head = ["FID", ...L.fields.map(([n]) => n), L.geomName];
  const rows = list.map((f) => [f.id, ...L.fields.map(([n]) => f.properties[n]), f.geometry ? wkt(f.geometry) : ""].map(csvCell).join(","));
  res.writeHead(200, { "Content-Type": "text/csv;charset=UTF-8", "Content-Disposition": "attachment; filename=layer.csv" });
  res.end([head.join(","), ...rows].join("\r\n") + "\r\n");
}
/** Zip "stored" (senza compressione): basta per verificare nomi dei file e contenuto. */
function zipStored(files) {
  const local = []; const central = []; let off = 0;
  for (const { name, data } of files) {
    const n = Buffer.from(name); const crc = zlib.crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    local.push(h, n, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, n);
    off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...local, cd, end]);
}
function shapeZip(res, layer, list, options) {
  const base = layer.split(":")[1];
  const charset = /CHARSET:([\w-]+)/i.exec(options || "")?.[1] || "ISO-8859-1";
  const files = [
    { name: `${base}.shp`, data: Buffer.from(`SHP finto: ${list.length} oggetti`) },
    { name: `${base}.shx`, data: Buffer.from("SHX finto") },
    { name: `${base}.dbf`, data: Buffer.from(list.map((f) => JSON.stringify(f.properties)).join("\n"), "utf8") },
    { name: `${base}.prj`, data: Buffer.from('GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]') },
    { name: `${base}.cst`, data: Buffer.from(charset) },
  ];
  res.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename=${base}.zip` });
  res.end(zipStored(files));
}

// ---------------------------------------------------------------- WCS 2.0 (solo i raster)
const owsException = (res, status, code, msg) => { res.writeHead(status, { "Content-Type": "application/xml" }); res.end(`<?xml version="1.0"?><ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/2.0" version="2.0.0"><ows:Exception exceptionCode="${code}"><ows:ExceptionText>${msg}</ows:ExceptionText></ows:Exception></ows:ExceptionReport>`); };
function wcsCapabilities(res) {
  const covs = Object.entries(store).filter(([, L]) => L.raster).map(([n]) => `<wcs:CoverageSummary><wcs:CoverageId>${n.replace(":", "__")}</wcs:CoverageId><wcs:CoverageSubtype>RectifiedGridCoverage</wcs:CoverageSubtype></wcs:CoverageSummary>`).join("");
  res.writeHead(200, { "Content-Type": "application/xml" });
  res.end(`<?xml version="1.0"?><wcs:Capabilities xmlns:wcs="http://www.opengis.net/wcs/2.0" version="2.0.1"><wcs:Contents>${covs}</wcs:Contents></wcs:Capabilities>`);
}
async function getCoverage(url, res) {
  const id = url.searchParams.get("coverageId") || url.searchParams.get("coverageid") || "";
  const L = store[id.replace("__", ":")];
  if (!L || !L.raster) return owsException(res, 404, "NoSuchCoverage", `Could not find coverage ${id}`);
  if ((url.searchParams.get("format") || "") !== "image/tiff") return owsException(res, 400, "InvalidParameterValue", "formato non supportato");
  const subsets = url.searchParams.getAll("subset");
  if (!subsets.some((x) => /^Long\(/.test(x)) || !subsets.some((x) => /^Lat\(/.test(x))) return owsException(res, 400, "InvalidSubsetting", "servono Long e Lat");
  const tif = await sharp({ create: { width: 64, height: 48, channels: 3, background: L.color } }).tiff().toBuffer();
  res.writeHead(200, { "Content-Type": "image/tiff", "Content-Disposition": `attachment; filename=${id}.tif` });
  res.end(tif);
}

function capabilities(res) {
  const layers = Object.entries(store).filter(([, L]) => !L.hidden).map(([name, L]) => {
    const [w, s, e, n] = BOX[name];
    const dim = L.timeProp
      ? `<Dimension name="time" default="2026-03-01" units="ISO8601">2026-01-01,2026-02-01,2026-03-01</Dimension>`
      : L.time ? `<Dimension name="time" default="2026-12-31" units="ISO8601">${L.time}</Dimension>` : "";
    const meta = (L.abstract ? `<Abstract>${L.abstract}</Abstract>` : "") + (L.keywords ? `<KeywordList>${L.keywords.map((k) => `<Keyword>${k}</Keyword>`).join("")}</KeywordList>` : "");
    const post = (L.attribution ? `<Attribution><Title>${L.attribution[0]}</Title><OnlineResource xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="${L.attribution[1]}"/></Attribution>` : "") + (L.metadataUrl ? `<MetadataURL type="TC211"><Format>text/xml</Format><OnlineResource xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="${L.metadataUrl}"/></MetadataURL>` : "");
    return `<Layer queryable="1"><Name>${name}</Name><Title>${L.title}</Title>${meta}<EX_GeographicBoundingBox><westBoundLongitude>${w}</westBoundLongitude><eastBoundLongitude>${e}</eastBoundLongitude><southBoundLatitude>${s}</southBoundLatitude><northBoundLatitude>${n}</northBoundLatitude></EX_GeographicBoundingBox>${post}${dim}</Layer>`;
  }).join("");
  res.writeHead(200, { "Content-Type": "text/xml" });
  const formats = ["image/png", "image/jpeg", ...(mvtOff ? [] : ["application/vnd.mapbox-vector-tile"])].map((f) => `<Format>${f}</Format>`).join("");
  res.end(`<?xml version="1.0"?><WMS_Capabilities version="1.3.0"><Service><Name>WMS</Name><Title>Mock</Title></Service><Capability><Request><GetMap>${formats}</GetMap></Request><Layer><Title>Mock GeoServer</Title>${layers}</Layer></Capability></WMS_Capabilities>`);
}

// ---------------------------------------------------------------- WFS-T
function gmlCoords(el) { return el.textContent.trim().split(/\s+/).map((p) => p.split(",").map(Number)); }
function gmlToGeoJson(el, target) {
  const tag = el.localName; const kids = (e, n) => Array.from(e.getElementsByTagName("*")).filter((x) => x.localName === n);
  let g;
  if (tag === "Point") g = { type: "Point", coordinates: gmlCoords(kids(el, "coordinates")[0])[0] };
  else if (tag === "LineString") g = { type: "LineString", coordinates: gmlCoords(kids(el, "coordinates")[0]) };
  else if (tag === "Polygon") g = { type: "Polygon", coordinates: [outerInner(el)].flat() };
  else if (tag === "MultiPolygon") g = { type: "MultiPolygon", coordinates: kids(el, "Polygon").map((p) => outerInner(p)) };
  else throw new Error(`GML ${tag} non gestito`);
  if (g.type === "Polygon" && target === "MultiPolygonPropertyType") g = { type: "MultiPolygon", coordinates: [g.coordinates] };
  return g;
  function outerInner(p) { return Array.from(p.getElementsByTagName("*")).filter((x) => x.localName === "LinearRing").map((r) => gmlCoords(r.getElementsByTagName("gml:coordinates")[0] ?? Array.from(r.getElementsByTagName("*")).find((x) => x.localName === "coordinates"))); }
}
/** Valore di un campo come lo restituirebbe GeoServer in JSON (numeri e booleani tipizzati). */
function typed(t, v) {
  if (t === "double" || t === "int") return Number(v);
  if (t === "boolean") return /^(true|1)$/i.test(String(v).trim());
  return v;
}
/** Vincoli delle tabelle (UNIQUE e CHECK), controllati a fine transazione come farebbe PostgreSQL. */
function constraints() {
  for (const [name, L] of Object.entries(store)) {
    if (L.unique) {
      const seen = new Set();
      for (const f of L.features) { const k = f.properties[L.unique]; if (k == null || k === "") continue; /* indice parziale: i vuoti non contano */ if (seen.has(k)) throw new Error(`duplicate key value violates unique constraint "${name.split(":")[1]}_${L.unique}_key"`); seen.add(k); }
    }
    const check = CHECKS[name];
    if (check) for (const f of L.features) if (!check(f.properties)) throw new Error(`new row for relation "${name.split(":")[1]}" violates check constraint`);
  }
}
const isArr = (v) => { try { return Array.isArray(JSON.parse(v)); } catch { return false; } };
const CHECKS = {
  "mapp:catalog_layers": (p) => !(p.hidden && p.default_on),
  "mapp:usage_events": (p) => ["page", "layer", "tool", "dashboard", "download", "search", "view"].includes(p.kind) && String(p.session ?? "").length >= 8 && String(p.session).length <= 64 && (p.roles == null || isArr(p.roles)),
};
/** Come il trigger gema_log di mapp-config.sql: riga prima/dopo, autore = updated_by, i soli timbri non contano. */
const LOGGED = ["role_rules", "dashboards", "catalog_folders", "catalog_layers", "role_views", "edit_forms", "announcements"].map((t) => `mapp:${t}`);
function logChanges(before, deletedRows = new Map()) {
  const L = store["mapp:change_log"]; const at = new Date().toISOString();
  const row = (f) => (f ? JSON.stringify({ id: Number(f.id.split(".").pop()), ...f.properties }) : null);
  const strip = (f) => { const { updated_by: _b, updated_at: _a, ...rest } = f.properties; return JSON.stringify(rest); };
  for (const name of LOGGED) {
    const oldById = new Map(before[name].features.map((f) => [f.id, f]));
    const newById = new Map(store[name].features.map((f) => [f.id, f]));
    const ids = Array.from(new Set([...oldById.keys(), ...newById.keys()])).sort((a, b) => Number(a.split(".").pop()) - Number(b.split(".").pop()));
    for (const id of ids) {
      const n = newById.get(id); const o = !n && deletedRows.has(id) ? deletedRows.get(id) : oldById.get(id); // la Delete vede la riga già timbrata
      const op = !o ? "INSERT" : !n ? "DELETE" : strip(o) !== strip(n) ? "UPDATE" : null;
      if (!op) continue;
      L.features.push({ id: `change_log.${L.next++}`, geometry: null, properties: {
        table_name: name.split(":")[1], row_id: Number(id.split(".").pop()), op, old_data: row(o), new_data: row(n),
        changed_by: (n ?? o).properties.updated_by ?? null, db_user: "gs_config", changed_at: at,
      } });
    }
  }
}
let txCount = 0;
let failNextTx = ""; // /__failtx?msg=…: la prossima transazione fallisce (dopo aver applicato le prime operazioni)
function transaction(body, res) {
  const doc = new DOMParser({ onError(level, m) { if (level !== "warning") throw new Error(m); } }).parseFromString(body, "text/xml");
  const root = doc.documentElement; let ins = 0, upd = 0, del = 0; const inserted = []; const deletedRows = new Map();
  const snapshot = structuredClone(store); // tutto o niente, come una transazione WFS-T su un datastore JDBC
  txCount++;
  const els = (e) => Array.from(e.childNodes).filter((n) => n.nodeType === 1);
  const fidOf = (op) => { const f = Array.from(op.getElementsByTagName("*")).find((x) => x.localName === "FeatureId"); return f?.getAttribute("fid"); };
  try {
    if (/mapp:change_log/.test(body)) throw new Error("permission denied for table change_log");
    if (/<wfs:(Update|Delete) typeName="mapp:usage_events"/.test(body)) throw new Error("permission denied for table usage_events");
    if (/mapp:usage_(daily|sessions|roles|users)/.test(body)) throw new Error("cannot change view");
    for (const op of els(root)) {
      if (op.localName === "Update") {
        const layer = op.getAttribute("typeName"); const L = store[layer];
        const eq = Array.from(op.getElementsByTagName("*")).find((x) => x.localName === "PropertyIsEqualTo");
        let targets;
        if (eq) { // filtro per attributo (come la prova di scrittura della diagnostica): zero righe è un successo
          const name = Array.from(eq.getElementsByTagName("*")).find((x) => x.localName === "PropertyName").textContent;
          const lit = Array.from(eq.getElementsByTagName("*")).find((x) => x.localName === "Literal").textContent;
          targets = L.features.filter((x) => String(x.properties[name] ?? "") === lit);
        } else {
          const f = L.features.find((x) => x.id === fidOf(op));
          if (!f) throw new Error(`oggetto ${fidOf(op)} non trovato`);
          targets = [f];
        }
        for (const f of targets) for (const p of els(op).filter((e) => e.localName === "Property")) {
          const name = els(p).find((e) => e.localName === "Name").textContent; const valEl = els(p).find((e) => e.localName === "Value");
          if (name === L.geomName) f.geometry = gmlToGeoJson(els(valEl)[0], L.gtype);
          else if (!L.fields.some(([n]) => n === name)) throw new Error(`campo ${name} sconosciuto`);
          else { const t = L.fields.find(([n]) => n === name)[1]; f.properties[name] = !valEl ? null : typed(t, valEl.textContent); }
        }
        upd++;
      } else if (op.localName === "Insert") {
        for (const fe of els(op)) {
          const layer = `${fe.prefix}:${fe.localName}`; const L = store[layer]; if (!L) throw new Error(`tipo ${layer} sconosciuto`);
          const f = { id: `${fe.localName}.${L.next++}`, geometry: null, properties: Object.fromEntries(L.fields.map(([n]) => [n, null])) };
          for (const c of els(fe)) {
            if (c.localName === L.geomName) f.geometry = gmlToGeoJson(els(c)[0], L.gtype);
            else { const t = L.fields.find(([n]) => n === c.localName)?.[1]; if (!t) throw new Error(`campo ${c.localName} sconosciuto`); f.properties[c.localName] = typed(t, c.textContent); }
          }
          L.features.push(f); ins++; inserted.push(f.id);
        }
      } else if (op.localName === "Delete") {
        const L = store[op.getAttribute("typeName")]; const id = fidOf(op); const n = L.features.length;
        const gone = L.features.find((f) => f.id === id); if (gone) deletedRows.set(id, structuredClone(gone)); // com'era al momento della Delete
        L.features = L.features.filter((f) => f.id !== id); if (L.features.length === n) throw new Error(`oggetto ${id} non trovato`); del++;
      }
    }
    constraints();
    if (failNextTx) { const m = failNextTx; failNextTx = ""; throw new Error(m); }
    logChanges(snapshot, deletedRows);
  } catch (e) {
    store = snapshot;
    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end(`<?xml version="1.0"?><wfs:WFS_TransactionResponse xmlns:wfs="http://www.opengis.net/wfs"><wfs:TransactionResult><wfs:Status><wfs:FAILED/></wfs:Status><wfs:Message>${e.message.replace(/</g, "")}</wfs:Message></wfs:TransactionResult></wfs:WFS_TransactionResponse>`);
  }
  res.writeHead(200, { "Content-Type": "text/xml" });
  const ir = `<wfs:InsertResult>${(inserted.length ? inserted : ["none"]).map((id) => `<ogc:FeatureId fid="${id}"/>`).join("")}</wfs:InsertResult>`;
  res.end(`<?xml version="1.0"?><wfs:WFS_TransactionResponse xmlns:wfs="http://www.opengis.net/wfs" xmlns:ogc="http://www.opengis.net/ogc">${ir}<wfs:TransactionResult><wfs:Status><wfs:SUCCESS/></wfs:Status></wfs:TransactionResult></wfs:WFS_TransactionResponse>`);
}

// ---------------------------------------------------------------- Keycloak finto (OIDC code + PKCE) per i test dei ruoli
const kcState = { user: "alice", roles: ["fss-etl-admin"], client: "mapp", cors: true };
const codes = new Map();
const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
const jwt = (payload) => `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.sig`;
const claims = (extra = {}) => { const now = Math.floor(Date.now() / 1000); return { exp: now + 3600, iat: now, iss: "http://127.0.0.1:8600/kc/realms/test", aud: kcState.client, sub: "u-" + kcState.user, azp: kcState.client, preferred_username: kcState.user, realm_access: { roles: [] }, resource_access: { [kcState.client]: { roles: kcState.roles } }, ...extra }; };
const bearerClaims = (auth) => { const m = auth.match(/^Bearer [^.]+\.([^.]+)\./); if (!m) return null; try { return JSON.parse(Buffer.from(m[1], "base64url").toString()); } catch { return null; } };
async function kcHandle(req, res, url, body) {
  const CORS = !kcState.cors && !url.pathname.endsWith("/auth") ? {} : { "Access-Control-Allow-Origin": req.headers.origin || "*", "Access-Control-Allow-Credentials": "true", "Access-Control-Allow-Headers": "content-type, authorization", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", Vary: "Origin" };
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  if (url.pathname.endsWith("/auth")) {
    const q = url.searchParams; const code = Math.random().toString(36).slice(2);
    codes.set(code, { nonce: q.get("nonce"), roles: [...kcState.roles], user: kcState.user });
    // come Keycloak con response_mode=fragment: se redirect_uri ha già un frammento (es. #s=… di un link), i parametri si accodano con &
    const back = q.get("redirect_uri");
    res.writeHead(302, { Location: `${back}${back.includes("#") ? "&" : "#"}state=${q.get("state")}&session_state=s1&iss=${encodeURIComponent("http://127.0.0.1:8600/kc/realms/test")}&code=${code}` });
    return res.end();
  }
  if (url.pathname.endsWith("/.well-known/openid-configuration")) {
    res.writeHead(200, { "Content-Type": "application/json", ...CORS });
    return res.end(JSON.stringify({ issuer: "http://127.0.0.1:8600/kc/realms/test", authorization_endpoint: "http://127.0.0.1:8600/kc/realms/test/protocol/openid-connect/auth" }));
  }
  if (url.pathname.endsWith("/token") && new URLSearchParams(body).get("grant_type") === "refresh_token") {
    const rt = bearerClaims("Bearer " + new URLSearchParams(body).get("refresh_token"));
    if (!rt) { res.writeHead(400, CORS); return res.end(JSON.stringify({ error: "invalid_grant" })); }
    const roles = rt.resource_access?.[kcState.client]?.roles ?? [];
    const save = { ...kcState }; kcState.user = rt.preferred_username; kcState.roles = roles;
    const out = { access_token: jwt(claims({ typ: "Bearer" })), refresh_token: jwt(claims({ typ: "Refresh", exp: Math.floor(Date.now() / 1000) + 7200 })), id_token: jwt(claims({ typ: "ID" })), token_type: "Bearer", expires_in: 3600, session_state: "s1" };
    Object.assign(kcState, save);
    res.writeHead(200, { "Content-Type": "application/json", ...CORS }); return res.end(JSON.stringify(out));
  }
  if (url.pathname.endsWith("/token")) {
    const f = new URLSearchParams(body); const c = codes.get(f.get("code"));
    if (!c) { res.writeHead(400, CORS); return res.end(JSON.stringify({ error: "invalid_grant" })); }
    const save = { ...kcState }; kcState.user = c.user; kcState.roles = c.roles;
    const out = { access_token: jwt(claims({ typ: "Bearer" })), refresh_token: jwt(claims({ typ: "Refresh", exp: Math.floor(Date.now() / 1000) + 7200 })), id_token: jwt(claims({ typ: "ID", nonce: c.nonce })), token_type: "Bearer", expires_in: 3600, session_state: "s1" };
    Object.assign(kcState, save);
    res.writeHead(200, { "Content-Type": "application/json", ...CORS }); return res.end(JSON.stringify(out));
  }
  res.writeHead(404, CORS); res.end("{}");
}

// ---------------------------------------------------------------- server
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString();
  const auth = req.headers.authorization || "";
  if (url.pathname.startsWith("/tiles/")) { tile ??= await sharp({ create: { width: 256, height: 256, channels: 3, background: "#dfe6ea" } }).png().toBuffer(); res.writeHead(200, { "Content-Type": "image/png", "Access-Control-Allow-Origin": "*" }); return res.end(tile); }
  if (url.pathname.startsWith("/nominatim/") || url.pathname.startsWith("/photon/")) {
    geoLog.push({ path: url.pathname, query: url.search.slice(1), auth: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null, ua: req.headers["user-agent"] ?? null, host: req.headers.host });
    const qq = (url.searchParams.get("q") || "").toLowerCase();
    const places = qq.includes("bari") ? [{ name: "Bari", lat: 41.1171, lon: 16.8719, box: [41.0, 41.2, 16.7, 17.0], sub: "Città metropolitana di Bari, Puglia, Italia" }, { name: "Bari Sardo", lat: 39.7, lon: 9.65, box: [39.6, 39.8, 9.55, 9.75], sub: "Sardegna, Italia" }] : [];
    res.writeHead(200, { "Content-Type": "application/json" });
    if (url.pathname.startsWith("/photon/")) return res.end(JSON.stringify({ type: "FeatureCollection", features: places.map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { name: p.name, state: "Puglia", country: "Italia", extent: [p.box[2], p.box[1], p.box[3], p.box[0]] } })) }));
    return res.end(JSON.stringify(places.map((p) => ({ display_name: `${p.name}, ${p.sub}`, name: p.name, lat: String(p.lat), lon: String(p.lon), boundingbox: p.box.map(String) }))));
  }
  if (url.pathname.startsWith("/kc/")) return kcHandle(req, res, url, body);
  if (url.pathname === "/__kc") { if (url.searchParams.has("cors")) kcState.cors = url.searchParams.get("cors") !== "0"; kcState.user = url.searchParams.get("user") || kcState.user; kcState.roles = (url.searchParams.get("roles") ?? kcState.roles.join(",")).split(",").filter(Boolean); return json(res, kcState); }
  if (url.pathname === "/__tables") { tablesOff = url.searchParams.get("off") === "1"; tablesOffOnly = url.searchParams.get("only")?.split(",") ?? null; return json(res, { tablesOff, tablesOffOnly }); }
  if (url.pathname === "/__state") return json(res, store);
  if (url.pathname === "/__log") return json(res, log);
  if (url.pathname === "/__geo") return json(res, geoLog);
  if (url.pathname === "/__failtx") { failNextTx = url.searchParams.get("msg") || "errore simulato"; return json(res, { failNextTx }); }
  if (url.pathname === "/__txcount") return json(res, { txCount });
  if (url.pathname === "/__seed") { const layer = url.searchParams.get("layer"); const L = store[layer]; const rows = JSON.parse(body || "[]"); for (const p of rows) L.features.push({ id: `${layer.split(":")[1]}.${L.next++}`, geometry: null, properties: Object.fromEntries(L.fields.map(([n, t]) => [n, p[n] == null ? null : typed(t, p[n])])) }); return json(res, { count: L.features.length }); }
  if (url.pathname === "/__mvt") { mvtOff = url.searchParams.get("off") === "1"; return json(res, { mvtOff }); }
  if (url.pathname === "/__slow") { getMapDelay = Number(url.searchParams.get("ms") || 0); return json(res, { getMapDelay }); }
  if (url.pathname === "/__reset") { store = initial(); log.length = 0; geoLog.length = 0; tablesOff = false; tablesOffOnly = null; getMapDelay = 0; mvtOff = false; txCount = 0; failNextTx = ""; kcState.cors = true; return json(res, { ok: true }); }
  log.push({ method: req.method, path: url.pathname, query: url.search.slice(1), auth: auth ? auth.slice(0, 6) + "…" : "", host: req.headers.host, body: body.slice(0, 600) });
  // scritture: utente di scrittura (Basic) oppure token Keycloak con il ruolo admin (come farebbero le regole dati di GeoServer)
  const bc = bearerClaims(auth);
  if (req.method === "POST") {
    // eccezioni come le regole dati del Job: usage_events e saved_views le scrivono tutti i ruoli applicativi
    const touched = Array.from(body.matchAll(/(?:typeName="|<)mapp:(\w+)/g)).map((m) => m[1]).filter((n) => store[`mapp:${n}`]);
    const appWritable = touched.length > 0 && touched.every((n) => n === "usage_events" || n === "saved_views");
    if (bc) { if (!(bc.resource_access?.mapp?.roles ?? []).includes("fss-etl-admin") && !appWritable) { res.writeHead(403); return res.end("forbidden: scrittura riservata a fss-etl-admin"); } }
    else if (auth !== WRITE) { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="mock"' }); return res.end("unauthorized"); }
  } else if (![READ, WRITE].includes(auth) && !bc) { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="mock"' }); return res.end("unauthorized"); }
  const q = new URLSearchParams(); for (const [k, v] of url.searchParams) q.set(k.toLowerCase() === "cql_filter" ? "cql_filter" : (k.toLowerCase() === "typename" || k.toLowerCase() === "typenames") ? "typeName" : k.toLowerCase() === "featureid" ? "featureId" : k.toLowerCase() === "maxfeatures" ? "maxFeatures" : k.toLowerCase() === "propertyname" ? "propertyName" : k.toLowerCase(), v);
  try {
    if (req.method === "POST") return transaction(body, res);
    const r = (q.get("request") || "").toLowerCase();
    if (r === "getcapabilities" && (q.get("service") || "").toUpperCase() === "WFS") {
      const fts = Object.entries(store).filter(([n, L]) => !L.raster && !isOff(n)).map(([n]) => `<FeatureType><Name>${n}</Name></FeatureType>`).join("");
      res.writeHead(200, { "Content-Type": "text/xml" }); return res.end(`<?xml version="1.0"?><wfs:WFS_Capabilities xmlns:wfs="http://www.opengis.net/wfs/2.0" version="2.0.0"><FeatureTypeList>${fts}</FeatureTypeList></wfs:WFS_Capabilities>`);
    }
    if (r === "getcapabilities" && (q.get("service") || "").toUpperCase() === "WCS") return wcsCapabilities(res);
    if (r === "getcoverage") return await getCoverage(url, res);
    if (r === "getcapabilities") return capabilities(res);
    if (r === "getmap") return await getMap(q, res);
    if (r === "getfeatureinfo") return getFeatureInfo(q, res);
    if (r === "describefeaturetype") return describe(q, res);
    if (r === "getfeature") return getFeature(q, res);
    if (r === "getlegendgraphic") { const L = store[q.get("layer")]; const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: L?.color || "#888" } }).png().toBuffer(); res.writeHead(200, { "Content-Type": "image/png" }); return res.end(png); }
    exception(res, 400, `richiesta non gestita: ${r}`);
  } catch (e) { exception(res, 500, e.message); }
}).listen(PORT, "127.0.0.1", () => console.log(`mock geoserver su ${PORT}`));
