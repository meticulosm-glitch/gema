import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import type Keycloak from "keycloak-js";
import type { AppConfig } from "./config";
import { describeLayer, fetchLegendBlob, getFeatureInfo, getWfsFeatures, wmsTileUrl, type Feature, type LayerParams } from "./api";
import { AoiControl, goToAoi } from "./aoiControl";
import { isConfigLayer } from "./configStore";
import { parseCapabilities, fetchVectorNames, markVector, type Product } from "./capabilities";
import { bboxOf, type LngLat } from "./geo";
import { exportMapPng, type LegendItem } from "./exportPng";
import AttributeTable from "./AttributeTable";
import Dashboard, { type DashSel } from "./Dashboard";
import Editor from "./Editor";
import FilterBox from "./FilterBox";
import { LegendPanel, type LegendEntry } from "./Legend";
import { CompareView, ComparePanel, type CompareState } from "./Compare";
import SeriesPanel, { type SeriesCandidate } from "./SeriesPanel";
import { shortTime, stepIndex, timeSteps } from "./timeline";
import { InfoPanel, MeasurePanel, type InfoState } from "./panels";
import SearchBox from "./SearchBox";
import BasemapSwitcher from "./BasemapSwitcher";
import LayerInfoPanel from "./LayerInfoPanel";
import ViewsPanel from "./ViewsPanel";
import { applyBasemap, basemapStyle, pickBasemap, resolveBasemaps } from "./basemaps";
import { captureView, encodeHash, parseHash, type ViewState } from "./viewState";
import type { Place } from "./geocode";
import type { AttrHit } from "./search";
import { addEditLayers } from "./vertexEditor";
import { Brand, PartnerLogos } from "./branding";
import { layerAllowed, type Permissions, type ToolId } from "./roles";
import {
  IconArea, IconBookmark, IconChart, IconClose, IconCompare, IconCube, IconDoc, IconEdit, IconInfo, IconLink, IconMenu, IconPan, IconPin, IconPrint, IconRuler, IconSeries, IconTable, IconZoom,
} from "./icons";

type Tool = "pan" | "info" | "series" | "coord" | "length" | "area";
interface LayerState { opacity: number; cql: string; time: string; style: string }
type Dock = { layer: string; tab: "table" | "dash" } | null;
// `n` cambia a ogni richiesta di apertura: l'editor si rimonta anche se layer e oggetto sono gli stessi
type Editing = { layer: string; initial?: Feature; n: number } | null;
type Selection = DashSel & { layer: string };

// MapLibre lavora meglio con URL assoluti (anche nei worker): "/geoserver" -> "https://host/geoserver"
const toAbsolute = (u: string) => new URL(u, window.location.origin).href.replace(/\/$/, "");
const EMPTY = { type: "FeatureCollection", features: [] } as any;
// un solo filtro resta com'è; più filtri vengono messi tra parentesi e legati con AND
const andJoin = (...parts: (string | undefined)[]) => {
  const ps = parts.filter((p): p is string => !!p && !!p.trim()).map((p) => p.trim());
  return ps.length === 1 ? ps[0] : ps.map((p) => `(${p})`).join(" AND ");
};

// ---------------------------------------------------------------- stato nel link (#s=…): vista, layer attivi e sfondo (vedi viewState.ts)
const readHash = () => parseHash(window.location.hash);

export default function App({ cfg, kc, perms = null, nav = null }: { cfg: AppConfig; kc: Keycloak | null; perms?: Permissions | null; nav?: ReactNode }) {
  // con il controllo accessi attivo, ogni strumento e layer dipende dai permessi del ruolo
  const allow = (id: ToolId) => !perms || perms.tools.has(id);
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const coordsEl = useRef<HTMLSpanElement>(null);
  const zoomEl = useRef<HTMLSpanElement>(null);
  const gsUrl = useMemo(() => toAbsolute(cfg.geoserverUrl), [cfg.geoserverUrl]);
  const initialHash = useRef(readHash());
  const basemaps = useMemo(() => resolveBasemaps(cfg), [cfg]);
  const [basemap, setBasemap] = useState(() => pickBasemap(basemaps, initialHash.current.b).id);
  const basemapRef = useRef(basemap); basemapRef.current = basemap;

  const [mapReady, setMapReady] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [products, setProducts] = useState<Product[]>([]);
  const [active, setActive] = useState<string[]>([]);                  // ordine di accensione
  const [layers, setLayers] = useState<Record<string, LayerState>>({}); // opacità, filtro CQL e data per layer
  const [layerErrors, setLayerErrors] = useState<Record<string, string>>({});
  const [restored, setRestored] = useState(false);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tool, setTool] = useState<Tool>("pan");
  const [pts, setPts] = useState<LngLat[]>([]);
  const [info, setInfo] = useState<InfoState | null>(null);
  const [dock, setDock] = useState<Dock>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [selection, setSelection] = useState<Selection | null>(null);   // filtro scelto cliccando un grafico
  const [rev, setRev] = useState<Record<string, number>>({});            // contatore di ricarica dei tile per layer
  const [is3D, setIs3D] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportTitle, setExportTitle] = useState("");
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [seriesPt, setSeriesPt] = useState<{ lng: number; lat: number } | null>(null);   // punto della serie storica
  const [compare, setCompare] = useState<CompareState | null>(null);                      // confronto con cursore
  const [viewsOpen, setViewsOpen] = useState(false);                                       // pannello delle viste salvate
  const [infoLayer, setInfoLayer] = useState<string | null>(null);                         // scheda informativa di un layer

  // l'editing è un'opzione di configurazione; con Keycloak può richiedere un ruolo. I permessi veri li applica GeoServer.
  const canEdit = !!cfg.editEnabled && allow("edit") && (!cfg.editRole || !kc || kc.hasRealmRole(cfg.editRole) || kc.hasResourceRole(cfg.editRole));

  // valori "freschi" per gli handler della mappa, registrati una sola volta
  const toolRef = useRef(tool); toolRef.current = tool;
  const activeRef = useRef(active); activeRef.current = active;
  const productsRef = useRef(new Map<string, Product>());
  const infoSeq = useRef(0);
  const editSeq = useRef(0);
  const tileUrls = useRef(new Map<string, string>());

  const paramsFor = (name: string): LayerParams => ({
    cql: andJoin(layers[name]?.cql, selection?.layer === name ? selection.cql : ""),
    time: layers[name]?.time ?? "",
    style: layers[name]?.style ?? "",
  });
  const paramsRef = useRef(paramsFor); paramsRef.current = paramsFor;

  const setLayerError = (name: string, msg: string | null) =>
    setLayerErrors((prev) => {
      if (msg === null) {
        if (!(name in prev)) return prev;
        const { [name]: _drop, ...rest } = prev;
        return rest;
      }
      return prev[name] === msg ? prev : { ...prev, [name]: msg };
    });

  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2200); };

  // --- evidenziazione sulla mappa (oggetti interrogati / selezionati in tabella) ---
  const setHighlight = (features: Feature[]) => {
    (mapRef.current?.getSource("highlight") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: features.filter((f) => f.geometry).map((f) => ({ type: "Feature", geometry: f.geometry, properties: {} })),
    } as any);
  };
  const zoomToFeatures = (features: Feature[]) => {
    const map = mapRef.current;
    const bb = bboxOf(features.map((f) => f.geometry).filter(Boolean));
    if (!map || !bb) return;
    const [w, s, e, n] = bb;
    if (w === e && s === n) map.easeTo({ center: [w, s], zoom: Math.max(map.getZoom(), 15) });
    else map.fitBounds([[w, s], [e, n]], { padding: 70, maxZoom: 17 });
  };

  // --- titolo e colore principale da configurazione ---
  useEffect(() => {
    document.title = cfg.title || "MApp Web";
  }, [cfg.title]);

  // --- mappa ---
  useEffect(() => {
    const v = initialHash.current.v;
    const map = new maplibregl.Map({
      container: mapEl.current!,
      center: v ? [v[0], v[1]] : cfg.mapCenter,
      zoom: v ? v[2] : cfg.mapZoom,
      pitch: v?.[3] ?? 0,
      bearing: v?.[4] ?? 0,
      style: basemapStyle(basemaps, basemapRef.current),
      // aggiunge il token Keycloak (se presente) alle richieste verso GeoServer
      transformRequest: (url) => (url.startsWith(gsUrl) && kc?.token ? { url, headers: { Authorization: `Bearer ${kc.token}` } } : { url }),
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.addControl(new AoiControl(() => goToAoi(map, cfg)), "top-right");
    map.addControl(new maplibregl.FullscreenControl(), "top-right");
    map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showAccuracyCircle: true }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

    // coordinate e zoom nella barra di stato (aggiornati via ref, senza re-render)
    map.on("mousemove", (e) => {
      if (coordsEl.current) coordsEl.current.textContent = `${e.lngLat.lat.toFixed(5)}°N  ${e.lngLat.lng.toFixed(5)}°E`;
    });
    const showZoom = () => { if (zoomEl.current) zoomEl.current.textContent = `Zoom ${map.getZoom().toFixed(1)}`; };
    map.on("zoom", showZoom);
    showZoom();

    // un tile che non si carica (filtro errato, data non valida, permessi) viene segnalato sul layer
    map.on("error", (e: any) => {
      const sid: string | undefined = e.sourceId;
      if (sid?.startsWith("wms-")) setLayerError(sid.slice(4), "Alcuni tile non si caricano: controlla filtro, data e permessi.");
    });

    // layer di servizio: evidenziazione, misure ed editing (sempre sopra ai layer WMS)
    map.once("load", () => {
      if (cfg.terrainTiles) map.addSource("dem", { type: "raster-dem", tiles: [cfg.terrainTiles], tileSize: 256, encoding: "terrarium", maxzoom: 14 });
      map.addSource("highlight", { type: "geojson", data: EMPTY });
      map.addLayer({ id: "hl-fill", type: "fill", source: "highlight", paint: { "fill-color": "#ff9800", "fill-opacity": 0.25 } });
      map.addLayer({ id: "hl-line", type: "line", source: "highlight", paint: { "line-color": "#ff9800", "line-width": 3 } });
      map.addLayer({
        id: "hl-pt", type: "circle", source: "highlight", filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 7, "circle-color": "#ff9800", "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
      });
      map.addSource("meas", { type: "geojson", data: EMPTY });
      map.addLayer({ id: "meas-fill", type: "fill", source: "meas", paint: { "fill-color": "#0a6cc4", "fill-opacity": 0.15 } });
      map.addLayer({ id: "meas-line", type: "line", source: "meas", paint: { "line-color": "#0a6cc4", "line-width": 2.5 } });
      map.addLayer({
        id: "meas-pt", type: "circle", source: "meas", filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 5, "circle-color": "#fff", "circle-stroke-color": "#0a6cc4", "circle-stroke-width": 2.5 },
      });
      addEditLayers(map, "#c2185b");
      setMapReady(true);
    });

    // interrogazione WMS GetFeatureInfo su tutti i layer attivi
    const runInfo = async (lngLat: { lng: number; lat: number }) => {
      const names = activeRef.current;
      const id = ++infoSeq.current;
      if (names.length === 0) {
        setInfo({ loading: false, results: [], message: "Nessun layer attivo da interrogare: accendi un layer dall'elenco." });
        return;
      }
      setInfo({ loading: true, results: [] });
      const results = await Promise.all(
        names.map(async (name) => {
          const title = productsRef.current.get(name)?.title ?? name;
          try {
            return { name, title, features: await getFeatureInfo(gsUrl, kc, name, map, lngLat, paramsRef.current(name)) };
          } catch (e: any) {
            return { name, title, features: [] as Feature[], error: e.message as string };
          }
        }),
      );
      if (id !== infoSeq.current) return; // clic più recente nel frattempo
      setInfo({ loading: false, results });
      setHighlight(results.flatMap((r) => r.features));
    };

    map.on("click", (e) => {
      const t = toolRef.current;
      const ll: LngLat = [e.lngLat.lng, e.lngLat.lat];
      if (t === "coord") setPts([ll]);
      else if (t === "length" || t === "area") setPts((p) => [...p, ll]);
      else if (t === "info") void runInfo(e.lngLat);
      else if (t === "series") {
        setSeriesPt({ lng: e.lngLat.lng, lat: e.lngLat.lat });
        setHighlight([{ geometry: { type: "Point", coordinates: ll }, properties: {} }]);
      }
    });

    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; setMapReady(false); };
  }, [cfg, kc, gsUrl]);

  // cursore e doppio-clic in base allo strumento (l'editor gestisce i propri)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || editing) return;
    map.getCanvas().style.cursor = tool === "pan" ? "" : "crosshair";
    if (tool === "length" || tool === "area") map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
  }, [tool, mapReady, editing]);

  // cambio di sfondo
  useEffect(() => {
    const m = mapRef.current;
    if (m && mapReady) applyBasemap(m, basemaps, basemap);
  }, [basemap, basemaps, mapReady]);

  // disegno delle misure
  useEffect(() => {
    const src = mapRef.current?.getSource("meas") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    const feats: any[] = [];
    if (tool === "length" && pts.length >= 2) feats.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts } });
    if (tool === "area") {
      if (pts.length >= 3) feats.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...pts, pts[0]]] } });
      else if (pts.length === 2) feats.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts } });
    }
    pts.forEach((p) => feats.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p } }));
    src.setData({ type: "FeatureCollection", features: feats } as any);
  }, [pts, tool, mapReady]);

  // dopo apertura/chiusura dei pannelli la mappa deve ricalcolare le dimensioni
  useEffect(() => {
    const t = setTimeout(() => mapRef.current?.resize(), 230);
    return () => clearTimeout(t);
  }, [sidebarOpen, dock]);

  // --- elenco di tutti i prodotti (= layer pubblicati su GeoServer) via WMS GetCapabilities ---
  useEffect(() => {
    const url = `${gsUrl}/ows?service=WMS&version=1.3.0&request=GetCapabilities`;
    console.info("[mapp] avvio", {
      origin: window.location.origin, geoserverUrl: cfg.geoserverUrl, gsUrl, auth: kc ? "keycloak" : "disabilitata", edit: canEdit,
    });
    const ctrl = new AbortController();
    fetch(url, { headers: kc?.token ? { Authorization: `Bearer ${kc.token}` } : {}, signal: ctrl.signal })
      .then((r) => {
        console.info("[mapp] GetCapabilities risposta", { url, status: r.status, contentType: r.headers.get("content-type"), redirected: r.redirected, finalUrl: r.url });
        return r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`));
      })
      .then(async (xml) => {
        let list: Product[];
        try {
          list = parseCapabilities(xml);
        } catch (e) {
          console.error("[mapp] risposta non XML (primi 300 caratteri):", xml.slice(0, 300));
          throw e;
        }
        // quali layer sono vettoriali (hanno un feature type WFS): tabella, dashboard, modifica e CQL hanno senso solo per quelli
        list = markVector(list, await fetchVectorNames(gsUrl, kc?.token, ctrl.signal));
        if (cfg.access?.enabled) list = list.filter((p) => !isConfigLayer(cfg.access!, p.name)); // tabelle di configurazione, mai in mappa
        if (perms) list = list.filter((p) => layerAllowed(perms, p.name));
        console.info(`[mapp] ${list.length} layer trovati`);
        productsRef.current = new Map(list.map((p) => [p.name, p]));
        setProducts(list);
      })
      .catch((e) => {
        if (e.name === "AbortError") return;
        console.error("[mapp] GetCapabilities fallita", { url, origin: window.location.origin, error: e });
        setError(`Elenco prodotti non disponibile: ${e.name}: ${e.message} | URL: ${url}`);
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg, gsUrl, kc]);

  // --- accendi/spegni un layer WMS ---
  const addLayer = (name: string, init?: Partial<LayerState>) => {
    const map = mapRef.current;
    if (!map || !map.getLayer("hl-fill")) return;
    const st: LayerState = { opacity: init?.opacity ?? 1, cql: init?.cql ?? "", time: init?.time ?? "", style: init?.style ?? "" };
    const id = `wms-${name}`;
    const url = wmsTileUrl(gsUrl, name, { cql: st.cql, time: st.time, style: st.style });
    if (!map.getSource(id)) map.addSource(id, { type: "raster", tiles: [url], tileSize: 256 });
    // i layer WMS stanno sotto a evidenziazione, misure ed editing
    if (!map.getLayer(id)) map.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": st.opacity } }, "hl-fill");
    tileUrls.current.set(name, url);
    setLayers((p) => ({ ...p, [name]: st }));
    setActive((p) => (p.includes(name) ? p : [...p, name]));
  };

  const removeLayer = (name: string) => {
    const map = mapRef.current;
    const id = `wms-${name}`;
    if (map?.getLayer(id)) map.removeLayer(id);
    if (map?.getSource(id)) map.removeSource(id);
    tileUrls.current.delete(name);
    setActive((p) => p.filter((n) => n !== name));
    setLayers((p) => { const { [name]: _drop, ...rest } = p; return rest; });
    setLayerError(name, null);
    setDock((d) => (d?.layer === name ? null : d));
    setEditing((e) => (e?.layer === name ? null : e));
    setSelection((s) => (s?.layer === name ? null : s));
    setCompare((c) => (c?.a === name ? null : c));
  };

  const toggle = (name: string) => {
    if (!mapReady) return;
    if (active.includes(name)) removeLayer(name); else addLayer(name);
  };

  const patchLayer = (name: string, patch: Partial<LayerState>) => setLayers((p) => ({ ...p, [name]: { ...p[name], ...patch } }));

  const changeOpacity = (name: string, v: number) => {
    mapRef.current?.setPaintProperty(`wms-${name}`, "raster-opacity", v);
    patchLayer(name, { opacity: v });
  };

  // un filtro CQL viene provato prima di essere applicato: se GeoServer lo rifiuta la mappa non si rompe
  const applyCql = async (name: string, cql: string) => {
    const c = cql.trim();
    if (c) {
      try {
        await describeLayer(gsUrl, kc, name);
      } catch {
        setLayerError(name, "Filtro CQL non applicabile: il layer non è vettoriale (o GeoServer non risponde).");
        return;
      }
      try {
        await getWfsFeatures(gsUrl, kc, name, c, 1);
      } catch (e: any) {
        setLayerError(name, `Filtro non valido: ${e.message}`);
        return;
      }
    }
    setLayerError(name, null);
    patchLayer(name, { cql: c });
  };

  // filtro, data, selezione dal grafico o scrittura riuscita -> nuovo URL dei tile
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    for (const name of active) {
      const url = wmsTileUrl(gsUrl, name, paramsFor(name), rev[name] ?? 0);
      if (tileUrls.current.get(name) !== url) {
        (map.getSource(`wms-${name}`) as maplibregl.RasterTileSource | undefined)?.setTiles([url]);
        tileUrls.current.set(name, url);
        setLayerError(name, null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, layers, selection, rev, mapReady, gsUrl]);

  // ripristino dei layer dal link, appena si conoscono i prodotti
  useEffect(() => {
    if (restored || !mapReady || products.length === 0) return;
    for (const [name, opacity, cql, time, style] of initialHash.current.l) {
      if (productsRef.current.has(name)) addLayer(name, { opacity, cql, time, style });
    }
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, products, restored]);

  // il link nella barra degli indirizzi segue vista e layer
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !restored) return;
    const sync = () => window.history.replaceState(null, "", encodeHash(captureView(map, active, layers, basemap)));
    map.on("moveend", sync);
    sync();
    return () => { map.off("moveend", sync); };
  }, [mapReady, restored, active, layers, basemap]);

  const copyLink = async () => {
    const map = mapRef.current;
    if (!map) return;
    const link = `${window.location.origin}${window.location.pathname}${encodeHash(captureView(map, active, layers, basemap))}`;
    try {
      await navigator.clipboard.writeText(link);
      flash("Link copiato");
    } catch {
      window.prompt("Copia il link", link);
    }
  };

  // --- ricerca: luoghi (geocoder) e oggetti dei layer attivi ---
  const goToPlace = (p: Place) => {
    const m = mapRef.current;
    if (!m) return;
    setHighlight([{ geometry: { type: "Point", coordinates: [p.lng, p.lat] }, properties: {} }]);
    if (p.bbox && (p.bbox[0] !== p.bbox[2] || p.bbox[1] !== p.bbox[3])) m.fitBounds([[p.bbox[0], p.bbox[1]], [p.bbox[2], p.bbox[3]]], { padding: 60, maxZoom: 17 });
    else m.easeTo({ center: [p.lng, p.lat], zoom: Math.max(m.getZoom(), 15) });
  };
  const goToHit = (h: AttrHit) => { setHighlight([h.feature]); zoomToFeatures([h.feature]); };

  // --- viste salvate: ripristina layer, filtri, date, stili, sfondo e inquadratura ---
  const captureNow = (): ViewState => captureView(mapRef.current!, active, layers, basemap);
  const applyView = (st: ViewState) => {
    const m = mapRef.current;
    if (!m || !mapReady) return;
    setCompare(null);
    setSelection(null);
    selectTool("pan");
    for (const n of [...activeRef.current]) removeLayer(n);
    let missing = 0;
    for (const [name, opacity, cql, time, style] of st.l) {
      if (productsRef.current.has(name)) addLayer(name, { opacity, cql, time, style });
      else missing++;
    }
    if (st.b && basemaps.some((b) => b.id === st.b)) setBasemap(st.b);
    if (st.v) m.easeTo({ center: [st.v[0], st.v[1]], zoom: st.v[2], pitch: st.v[3] ?? 0, bearing: st.v[4] ?? 0, duration: 600 });
    flash(missing > 0 ? `Vista aperta: ${missing} layer non più disponibili` : "Vista aperta");
  };

  const openViews = () => { setViewsOpen((o) => !o); setInfoLayer(null); setExportOpen(false); };
  const openLayerInfo = (name: string) => { setInfoLayer((c) => (c === name ? null : name)); setViewsOpen(false); setExportOpen(false); };
  const attrLayers = active.filter((n) => productsRef.current.get(n)?.vector !== false).map((n) => ({ name: n, title: productsRef.current.get(n)?.title ?? n }));

  // --- strumenti ---
  const selectTool = (t: Tool) => {
    setTool(t);
    setPts([]);
    if (t !== "series") setSeriesPt(null);
    setInfo(null);
    infoSeq.current++;
    setHighlight([]);
    if (t !== "pan") setEditing(null);
  };

  const openEditor = (layer: string, initial?: Feature) => {
    setTool("pan");
    setPts([]);
    setInfo(null);
    infoSeq.current++;
    setHighlight([]);
    setEditing({ layer, initial, n: ++editSeq.current });
  };

  const toggle3D = () => {
    const map = mapRef.current;
    const next = !is3D;
    setIs3D(next);
    map?.easeTo({ pitch: next ? 60 : 0, bearing: next ? -20 : 0, duration: 700 });
    if (cfg.terrainTiles && map?.getSource("dem")) map.setTerrain(next ? { source: "dem", exaggeration: 1.4 } : null);
  };

  const zoomToProduct = (p: Product) => {
    if (!p.bbox) return;
    const [w, s, e, n] = p.bbox;
    mapRef.current?.fitBounds([[w, s], [e, n]], { padding: 40, maxZoom: 14 });
  };

  const doExport = async () => {
    const map = mapRef.current;
    if (!map) return;
    setExporting(true);
    try {
      const legends: LegendItem[] = [];
      for (const name of [...active].reverse()) {
        try {
          const bitmap = await createImageBitmap(await fetchLegendBlob(gsUrl, kc, name, layers[name]?.style));
          legends.push({ title: productsRef.current.get(name)?.title ?? name, bitmap });
        } catch { /* legenda non disponibile: il layer viene omesso dalla legenda */ }
      }
      await exportMapPng(map, { title: exportTitle.trim(), legends });
      setExportOpen(false);
    } finally {
      setExporting(false);
    }
  };

  // --- dati derivati per la UI ---
  const byName = productsRef.current;
  const q = filter.trim().toLowerCase();
  const groups = useMemo(() => {
    const shown = q ? products.filter((p) => p.title.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)) : products;
    const m = new Map<string, Product[]>();
    for (const p of shown) m.set(p.workspace, [...(m.get(p.workspace) ?? []), p]);
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [products, q]);
  const shownCount = groups.reduce((n, [, items]) => n + items.length, 0);
  const map = mapRef.current;

  // istanti disponibili per i layer con TIME (slider, serie storica, confronto)
  const stepsCache = useMemo(() => new Map(products.filter((p) => p.time).map((p) => [p.name, timeSteps(p.time)] as const)), [products]);
  const stepsOf = (n: string) => stepsCache.get(n) ?? [];
  const seriesCandidates = useMemo<SeriesCandidate[]>(
    () => active.filter((n) => (stepsCache.get(n)?.length ?? 0) > 1).map((n) => ({ name: n, title: productsRef.current.get(n)?.title ?? n, steps: stepsCache.get(n)! })),
    [active, stepsCache],
  );

  // --- confronto con cursore ---
  const openCompare = () => {
    const a = active[active.length - 1];
    if (!a) return;
    const steps = stepsOf(a);
    let bTime = "";
    if (steps.length > 1) {
      // lato destro: la data precedente a quella mostrata (o la successiva, se si è già alla prima)
      const i = stepIndex(steps, layers[a]?.time ?? "", byName.get(a)?.time?.default);
      bTime = steps[i > 0 ? i - 1 : 1];
    }
    selectTool("pan");
    setEditing(null);
    setCompare({ a, b: a, bTime });
  };
  const titleOf = (n: string) => byName.get(n)?.title ?? n;
  const timeOf = (n: string, t: string) => {
    const steps = stepsOf(n);
    return steps.length > 1 ? ` · ${shortTime(t || byName.get(n)?.time?.default || steps[steps.length - 1])}` : "";
  };
  const sameLayer = !!compare && compare.a === compare.b;
  const bParams: LayerParams | null = compare ? (sameLayer ? { ...paramsFor(compare.a), time: compare.bTime } : { time: compare.bTime }) : null;
  const legendEntries: LegendEntry[] = compare && bParams
    ? sameLayer && (layers[compare.a]?.style ?? "") === (bParams.style ?? "")
      ? [{ key: `ab|${compare.a}|${bParams.style}`, layer: compare.a, title: titleOf(compare.a), style: bParams.style, tag: "A · B" }]
      : [
          { key: `a|${compare.a}|${layers[compare.a]?.style ?? ""}`, layer: compare.a, title: titleOf(compare.a), style: layers[compare.a]?.style, tag: "A" },
          { key: `b|${compare.b}|${bParams.style ?? ""}`, layer: compare.b, title: titleOf(compare.b), style: bParams.style, tag: "B" },
        ]
    : [...active].reverse().map((n) => ({ key: n, layer: n, title: titleOf(n), style: layers[n]?.style }));

  // durante il confronto la mappa principale mostra solo il layer A; gli altri tornano visibili all'uscita
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !mapReady) return;
    for (const name of active) {
      const id = `wms-${name}`;
      if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", compare && name !== compare.a ? "none" : "visible");
    }
  }, [compare, active, mapReady]);

  const tools: { id: Tool; title: string; icon: ReactNode }[] = [
    { id: "pan", title: "Navigazione", icon: <IconPan /> },
    { id: "info", title: "Interroga oggetti (Feature Info)", icon: <IconInfo /> },
    { id: "series", title: "Serie storica in un punto", icon: <IconSeries /> },
    { id: "coord", title: "Coordinate", icon: <IconPin /> },
    { id: "length", title: "Misura distanza", icon: <IconRuler /> },
    { id: "area", title: "Misura area", icon: <IconArea /> },
  ];

  return (
    <div className="app">
      <header className="header">
        <button className="icon-btn" title="Mostra/nascondi pannello" onClick={() => setSidebarOpen((o) => !o)}><IconMenu /></button>
        <Brand cfg={cfg} />
        {nav}
        {allow("search") && (
          <SearchBox
            geocoder={cfg.geocoder}
            attrLayers={attrLayers}
            gsUrl={gsUrl}
            kc={kc}
            getBias={() => { const c = mapRef.current?.getCenter(); return c ? { lng: c.lng, lat: c.lat } : undefined; }}
            onPlace={goToPlace}
            onHit={goToHit}
          />
        )}
        <div className="spacer" />
        <PartnerLogos cfg={cfg} />
        {toast && <span className="toast" role="status">{toast}</span>}
        <button className="icon-btn" title="Copia il link a questa vista" disabled={!mapReady} onClick={copyLink}><IconLink /></button>
        {kc && (
          <>
            <span className="user">{kc.tokenParsed?.preferred_username}</span>
            <button className="btn" onClick={() => kc.logout()}>Esci</button>
          </>
        )}
      </header>

      <div className="body">
        <aside className={`sidebar${sidebarOpen ? "" : " closed"}`}>
          <div className="panel-head">
            <h2>
              <span>Prodotti</span>
              {!loading && !error && <span>{q ? `${shownCount} / ${products.length}` : products.length}</span>}
            </h2>
            <input className="search" type="search" placeholder="Cerca un prodotto…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>

          <div className="scroll">
            {loading && <div className="empty">Caricamento…</div>}
            {error && <div className="error">{error}</div>}

            {active.length > 0 && (
              <>
                <div className="section-title">Layer attivi ({active.length})</div>
                {[...active].reverse().map((name) => {
                  const p = byName.get(name);
                  const st = layers[name] ?? { opacity: 1, cql: "", time: "", style: "" };
                  const isVec = p?.vector !== false; // raster e gruppi: niente tabella, dashboard, modifica, CQL
                  return (
                    <div className="active-card" key={name}>
                      <div className="row">
                        <span className="name" title={name}>{p?.title ?? name}</span>
                        <button className={`icon-btn${infoLayer === name ? " on" : ""}`} title="Scheda del layer" aria-label={`Scheda di ${p?.title ?? name}`} onClick={() => openLayerInfo(name)}><IconDoc /></button>
                        {isVec && allow("table") && <button className={`icon-btn${dock?.layer === name && dock.tab === "table" ? " on" : ""}`} title="Tabella attributi" onClick={() => setDock({ layer: name, tab: "table" })}><IconTable /></button>}
                        {isVec && allow("dashboard") && <button className={`icon-btn${dock?.layer === name && dock.tab === "dash" ? " on" : ""}`} title="Dashboard" onClick={() => setDock({ layer: name, tab: "dash" })}><IconChart /></button>}
                        {canEdit && isVec && (
                          <button className={`icon-btn${editing?.layer === name ? " on" : ""}`} title="Modifica oggetti" onClick={() => openEditor(name)}><IconEdit /></button>
                        )}
                        {p?.bbox && <button className="icon-btn" title="Zoom sul layer" onClick={() => zoomToProduct(p)}><IconZoom /></button>}
                        <button className="icon-btn" title="Rimuovi dalla mappa" onClick={() => removeLayer(name)}><IconClose /></button>
                      </div>
                      <label className="opacity">
                        Opacità
                        <input type="range" min={0} max={1} step={0.05} value={st.opacity} onChange={(e) => changeOpacity(name, Number(e.target.value))} />
                        {Math.round(st.opacity * 100)}%
                      </label>
                      <FilterBox
                        cql={st.cql}
                        noCql={!isVec}
                        time={st.time}
                        timeInfo={p?.time}
                        style={st.style}
                        styles={p?.styles}
                        error={layerErrors[name]}
                        selectionLabel={selection?.layer === name ? selection.label : undefined}
                        onApplyCql={(c) => { void applyCql(name, c); }}
                        onApplyTime={(t) => patchLayer(name, { time: t.trim() })}
                        onApplyStyle={(v) => patchLayer(name, { style: v })}
                        onClearSelection={() => setSelection(null)}
                      />
                    </div>
                  );
                })}
              </>
            )}

            {!loading && !error && (
              <>
                <div className="section-title">Disponibili</div>
                {groups.length === 0 && <div className="empty">Nessun prodotto trovato.</div>}
                {groups.map(([ws, items]) => (
                  <details className="group" key={ws} open={q !== "" || groups.length === 1}>
                    <summary>{ws}<span className="count">{items.length}</span></summary>
                    {items.map((p) => {
                      const on = active.includes(p.name);
                      return (
                        <label key={p.name} className={`item${on ? " on" : ""}${mapReady ? "" : " disabled"}`} title={p.name}>
                          <input type="checkbox" checked={on} disabled={!mapReady} onChange={() => toggle(p.name)} />
                          <span className="grow">{p.title}</span>
                          <button
                            className={`icon-btn item-info${infoLayer === p.name ? " on" : ""}`}
                            title="Scheda del layer"
                            aria-label={`Scheda di ${p.title}`}
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); openLayerInfo(p.name); }}
                          >
                            <IconDoc />
                          </button>
                        </label>
                      );
                    })}
                  </details>
                ))}
              </>
            )}
          </div>
        </aside>

        <div className="main">
          <div className="map-area">
            <div className="map-el" ref={mapEl} />

            <div className="toolbar">
              {tools.filter((t) => t.id === "pan" || allow(t.id === "info" ? "info" : t.id === "series" ? "series" : "measure")).map((t) => (
                <button key={t.id} className={`tool${tool === t.id ? " on" : ""}`} title={t.title} disabled={!mapReady || (!!compare && t.id !== "pan")} onClick={() => selectTool(t.id)}>
                  {t.icon}
                </button>
              ))}
              <div className="tool-sep" />
              {allow("compare") && (<button
                className={`tool${compare ? " on" : ""}`}
                title={compare ? "Esci dal confronto" : is3D ? "Confronto non disponibile in 3D" : "Confronto con cursore (swipe)"}
                disabled={!mapReady || is3D || (!compare && active.length === 0)}
                onClick={() => (compare ? setCompare(null) : openCompare())}
              >
                <IconCompare />
              </button>)}
              {allow("views") && (<button className={`tool${viewsOpen ? " on" : ""}`} title="Viste salvate" aria-pressed={viewsOpen} disabled={!mapReady} onClick={openViews}>
                <IconBookmark />
              </button>)}
              {allow("view3d") && (<button
                className={`tool${is3D ? " on" : ""}`}
                title={is3D ? "Torna alla vista 2D" : cfg.terrainTiles ? "Vista 3D con rilievo" : "Vista inclinata"}
                disabled={!mapReady || !!compare}
                onClick={toggle3D}
              >
                <IconCube />
              </button>)}
              {allow("export") && (<button className="tool" title={compare ? "Esporta non disponibile durante il confronto" : "Stampa / esporta mappa (PNG)"} disabled={!mapReady || !!compare} onClick={() => { setExportOpen((o) => !o); setViewsOpen(false); setInfoLayer(null); }}>
                <IconPrint />
              </button>)}
            </div>

            {exportOpen && (
              <div className="float-panel export">
                <div className="fp-head">
                  <strong>Esporta mappa</strong>
                  <button className="icon-btn" title="Chiudi" onClick={() => setExportOpen(false)}><IconClose /></button>
                </div>
                <div className="fp-body">
                  <input className="search" placeholder="Titolo della mappa" value={exportTitle} onChange={(e) => setExportTitle(e.target.value)} />
                  <div className="muted">PNG con titolo, scala indicativa, data e legende dei layer attivi.</div>
                  <button className="btn-sm primary" disabled={exporting} onClick={doExport}>{exporting ? "Generazione…" : "Scarica PNG"}</button>
                </div>
              </div>
            )}

            {viewsOpen && mapReady && map && (
              <ViewsPanel gsUrl={gsUrl} kc={kc} access={cfg.access} capture={captureNow} onApply={applyView} onClose={() => setViewsOpen(false)} />
            )}
            {infoLayer && byName.get(infoLayer) && (
              <LayerInfoPanel
                key={infoLayer}
                product={byName.get(infoLayer)!}
                gsUrl={gsUrl}
                kc={kc}
                active={active.includes(infoLayer)}
                onClose={() => setInfoLayer(null)}
                onZoom={zoomToProduct}
                onToggle={toggle}
              />
            )}

            {tool === "info" && info && (
              <InfoPanel
                state={info}
                canEdit={canEdit}
                onClose={() => { setInfo(null); infoSeq.current++; setHighlight([]); }}
                onZoom={(f) => zoomToFeatures([f])}
                onEdit={(layer, f) => openEditor(layer, f)}
              />
            )}
            {(tool === "coord" || tool === "length" || tool === "area") && (
              <MeasurePanel tool={tool} pts={pts} onUndo={() => setPts((p) => p.slice(0, -1))} onClear={() => setPts([])} onClose={() => selectTool("pan")} />
            )}
            {tool === "series" && mapReady && map && (
              <SeriesPanel map={map} gsUrl={gsUrl} kc={kc} candidates={seriesCandidates} point={seriesPt} paramsFor={paramsFor} onClose={() => selectTool("pan")} />
            )}
            {compare && bParams && mapReady && map && (
              <>
                <CompareView
                  map={map}
                  gsUrl={gsUrl}
                  kc={kc}
                  basemapTiles={pickBasemap(basemaps, basemap).tiles ?? ""}
                  layer={compare.b}
                  params={bParams}
                  opacity={layers[compare.a]?.opacity ?? 1}
                  labelA={`${titleOf(compare.a)}${timeOf(compare.a, layers[compare.a]?.time ?? "")}`}
                  labelB={`${titleOf(compare.b)}${timeOf(compare.b, compare.bTime)}`}
                />
                <ComparePanel
                  state={compare}
                  products={products}
                  activeNames={[...active].reverse()}
                  stepsOf={stepsOf}
                  aTime={layers[compare.a]?.time ?? ""}
                  aDefault={byName.get(compare.a)?.time?.default}
                  onState={setCompare}
                  onATime={(t) => patchLayer(compare.a, { time: t })}
                  onClose={() => setCompare(null)}
                />
              </>
            )}
            <BasemapSwitcher list={basemaps} value={pickBasemap(basemaps, basemap).id} onChange={setBasemap} />
            <LegendPanel gsUrl={gsUrl} kc={kc} entries={legendEntries} />
            {editing && mapReady && map && (
              <Editor
                key={`${editing.layer}|${editing.n}`}
                map={map}
                gsUrl={gsUrl}
                kc={kc}
                layer={editing.layer}
                title={byName.get(editing.layer)?.title ?? editing.layer}
                params={paramsFor(editing.layer)}
                initial={editing.initial}
                onClose={() => setEditing(null)}
                onSaved={() => setRev((r) => ({ ...r, [editing.layer]: (r[editing.layer] ?? 0) + 1 }))}
              />
            )}
          </div>

          {dock && (
            <div className="table-dock">
              <div className="dock-head">
                <strong title={dock.layer}>{byName.get(dock.layer)?.title ?? dock.layer}</strong>
                <div className="dock-tabs" role="tablist">
                  {allow("table") && <button role="tab" aria-selected={dock.tab === "table"} className={`dock-tab${dock.tab === "table" ? " on" : ""}`} onClick={() => setDock({ ...dock, tab: "table" })}>Tabella</button>}
                  {allow("dashboard") && <button role="tab" aria-selected={dock.tab === "dash"} className={`dock-tab${dock.tab === "dash" ? " on" : ""}`} onClick={() => setDock({ ...dock, tab: "dash" })}>Dashboard</button>}
                </div>
                <button className="icon-btn" title="Chiudi" onClick={() => { setDock(null); setHighlight([]); }}><IconClose /></button>
              </div>
              {dock.tab === "table" ? (
                <AttributeTable
                  gsUrl={gsUrl}
                  kc={kc}
                  layer={dock.layer}
                  baseCql={paramsFor(dock.layer).cql ?? ""}
                  refreshKey={rev[dock.layer] ?? 0}
                  canEdit={canEdit}
                  onEdit={(f) => openEditor(dock.layer, f)}
                  onSelect={(fs) => { setHighlight(fs); zoomToFeatures(fs); }}
                />
              ) : (
                mapReady && map && (
                  <Dashboard
                    map={map}
                    gsUrl={gsUrl}
                    kc={kc}
                    layer={dock.layer}
                    cql={layers[dock.layer]?.cql ?? ""}
                    refreshKey={rev[dock.layer] ?? 0}
                    selection={selection?.layer === dock.layer ? selection : null}
                    onSelect={(s) => setSelection(s ? { ...s, layer: dock.layer } : null)}
                  />
                )
              )}
            </div>
          )}
        </div>
      </div>

      <footer className="statusbar">
        <span ref={coordsEl}>—</span>
        <span ref={zoomEl} />
        <span className="spacer" />
        <span>{active.length} layer attivi</span>
      </footer>
    </div>
  );
}
