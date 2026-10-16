import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type Keycloak from "keycloak-js";
import { wmsTileUrl, type LayerParams } from "./api";
import type { Product } from "./capabilities";
import { IconClose } from "./icons";
import { NO_BASEMAP_COLOR } from "./basemaps";
import { shortTime } from "./timeline";

export interface CompareState {
  a: string;      // layer del lato sinistro (la mappa principale); la sua data è quella del layer attivo
  b: string;      // layer del lato destro (può essere lo stesso di A o uno non ancora acceso)
  bTime: string;  // data del lato destro; "" = predefinita
}

/**
 * Confronto con cursore (swipe). Il lato destro è una seconda mappa, sincronizzata con la principale,
 * sovrapposta ad essa e ritagliata a destra del cursore: vale sia per due layer sia per due date dello stesso layer.
 * La seconda mappa non riceve eventi (pointer-events: none): zoom, spostamento e controlli restano quelli della principale.
 */
export function CompareView({
  map, gsUrl, kc, basemapTiles, layer, params, opacity, labelA, labelB,
}: {
  map: maplibregl.Map;
  gsUrl: string;
  kc: Keycloak | null;
  basemapTiles: string;   // "" = sfondo vuoto
  layer: string;
  params: LayerParams;
  opacity: number;
  labelA: string;
  labelB: string;
}) {
  const [frac, setFrac] = useState(0.5);         // posizione del cursore, 0..1 della larghezza
  const [ready, setReady] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapB = useRef<maplibregl.Map | null>(null);
  const dragging = useRef(false);
  const initial = useRef({ layer, params, opacity, frac });   // valori alla creazione; poi si aggiorna con gli effetti sotto

  useEffect(() => {
    const host = document.createElement("div");
    host.className = "compare-host";
    map.getContainer().appendChild(host);
    hostRef.current = host;
    host.style.clipPath = `inset(0 0 0 ${initial.current.frac * 100}%)`;

    const i = initial.current;
    const mb = new maplibregl.Map({
      container: host,
      center: map.getCenter(),
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      style: {
        version: 8,
        sources: {
          ...(basemapTiles ? { base: { type: "raster" as const, tiles: [basemapTiles], tileSize: 256 } } : {}),
          "wms-b": { type: "raster", tiles: [wmsTileUrl(gsUrl, i.layer, i.params)], tileSize: 256 },
        },
        layers: [
          basemapTiles ? { id: "base", type: "raster" as const, source: "base" } : { id: "base", type: "background" as const, paint: { "background-color": NO_BASEMAP_COLOR } },
          { id: "wms-b", type: "raster", source: "wms-b", paint: { "raster-opacity": i.opacity } },
        ],
      },
      transformRequest: (url) => (url.startsWith(gsUrl) && kc?.token ? { url, headers: { Authorization: `Bearer ${kc.token}` } } : { url }),
    });
    mapB.current = mb;
    // lo stile è pronto (sorgenti e layer presenti) prima ancora del primo rendering completo: basta il primo dei due eventi
    mb.once("style.load", () => setReady(true));
    mb.once("load", () => setReady(true));

    // la mappa principale comanda: ogni movimento (anche animato) si riflette sulla seconda
    const sync = () => mb.jumpTo({ center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() });
    map.on("move", sync);
    const ro = new ResizeObserver(() => { mb.resize(); sync(); });
    ro.observe(host);

    return () => {
      map.off("move", sync);
      ro.disconnect();
      mb.remove();
      mapB.current = null;
      host.remove();
      hostRef.current = null;
      setReady(false);
    };
  }, [map, gsUrl, kc, basemapTiles]);

  // lato destro: layer, data, stile o filtro cambiati
  const url = wmsTileUrl(gsUrl, layer, params);
  useEffect(() => {
    if (!ready) return;
    (mapB.current?.getSource("wms-b") as maplibregl.RasterTileSource | undefined)?.setTiles([url]);
  }, [url, ready]);

  useEffect(() => {
    if (ready && mapB.current?.getLayer("wms-b")) mapB.current.setPaintProperty("wms-b", "raster-opacity", opacity);
  }, [opacity, ready]);

  // layout effect: il ritaglio si aggiorna nello stesso frame del cursore (con useEffect restava indietro di un frame)
  useLayoutEffect(() => {
    if (hostRef.current) hostRef.current.style.clipPath = `inset(0 0 0 ${frac * 100}%)`;
  }, [frac]);

  const moveTo = (clientX: number, el: HTMLElement) => {
    const r = (el.parentElement ?? el).getBoundingClientRect();
    if (r.width > 0) setFrac(Math.min(0.97, Math.max(0.03, (clientX - r.left) / r.width)));
  };

  return (
    <>
      <div className="compare-tag" style={{ right: `calc(${(1 - frac) * 100}% + 10px)` }} title={labelA}><b>A</b> {labelA}</div>
      <div className="compare-tag" style={{ left: `calc(${frac * 100}% + 10px)` }} title={labelB}><b>B</b> {labelB}</div>
      <div
        className="compare-handle"
        style={{ left: `${frac * 100}%` }}
        role="slider"
        tabIndex={0}
        aria-label="Cursore di confronto"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(frac * 100)}
        onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { if (dragging.current) moveTo(e.clientX, e.currentTarget); }}
        onPointerUp={(e) => { dragging.current = false; e.currentTarget.releasePointerCapture(e.pointerId); }}
        onPointerCancel={() => { dragging.current = false; }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.1 : 0.02;
          if (e.key === "ArrowLeft") { e.preventDefault(); setFrac((f) => Math.max(0.03, f - step)); }
          else if (e.key === "ArrowRight") { e.preventDefault(); setFrac((f) => Math.min(0.97, f + step)); }
          else if (e.key === "Home") { e.preventDefault(); setFrac(0.03); }
          else if (e.key === "End") { e.preventDefault(); setFrac(0.97); }
        }}
      >
        <span className="compare-grip" aria-hidden="true">⇆</span>
      </div>
    </>
  );
}

/** Scelte del confronto: layer e data per ciascun lato. */
export function ComparePanel({
  state, products, activeNames, stepsOf, aTime, aDefault, onState, onATime, onClose,
}: {
  state: CompareState;
  products: Product[];
  activeNames: string[];
  stepsOf: (name: string) => string[];
  aTime: string;
  aDefault?: string;
  onState: (s: CompareState) => void;
  onATime: (t: string) => void;
  onClose: () => void;
}) {
  const title = (n: string) => products.find((p) => p.name === n)?.title ?? n;
  const aSteps = stepsOf(state.a);
  const bSteps = stepsOf(state.b);
  const aValue = aTime || aDefault || aSteps[aSteps.length - 1] || "";
  const bValue = state.bTime || products.find((p) => p.name === state.b)?.time?.default || bSteps[bSteps.length - 1] || "";

  const dateSelect = (steps: string[], value: string, onPick: (t: string) => void, label: string) =>
    steps.length > 1 ? (
      <select value={steps.includes(value) ? value : ""} aria-label={label} onChange={(e) => onPick(e.target.value)}>
        {!steps.includes(value) && <option value="">{value ? shortTime(value) : "predefinita"}</option>}
        {steps.slice().reverse().map((s) => <option key={s} value={s}>{shortTime(s)}</option>)}
      </select>
    ) : null;

  return (
    <div className="float-panel compare">
      <div className="fp-head">
        <strong>Confronto con cursore</strong>
        <button className="icon-btn" title="Esci dal confronto" aria-label="Esci dal confronto" onClick={onClose}><IconClose /></button>
      </div>
      <div className="fp-body">
        <div className="cmp-side">
          <div className="section-title"><span className="chip">A</span> a sinistra</div>
          <select value={state.a} aria-label="Layer A" onChange={(e) => onState({ ...state, a: e.target.value })}>
            {activeNames.map((n) => <option key={n} value={n}>{title(n)}</option>)}
          </select>
          {dateSelect(aSteps, aValue, onATime, "Data A")}
        </div>
        <div className="cmp-side">
          <div className="section-title"><span className="chip">B</span> a destra</div>
          <select
            value={state.b}
            aria-label="Layer B"
            onChange={(e) => {
              const st = stepsOf(e.target.value);
              onState({ ...state, b: e.target.value, bTime: st.length > 1 ? st[st.length - 1] : "" });
            }}
          >
            {products.map((p) => <option key={p.name} value={p.name} title={p.name}>{p.title}</option>)}
          </select>
          {dateSelect(bSteps, bValue, (t) => onState({ ...state, bTime: t }), "Data B")}
        </div>
        <div className="muted">Trascina il cursore sulla mappa (o usa le frecce quando è selezionato). Per confrontare due date, scegli lo stesso layer a destra e a sinistra con date diverse.</div>
      </div>
    </div>
  );
}
