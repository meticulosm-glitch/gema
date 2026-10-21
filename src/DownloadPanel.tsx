import { useEffect, useMemo, useState } from "react";
import type Keycloak from "keycloak-js";
import type * as maplibregl from "maplibre-gl";
import { describeLayer, getWfsCount } from "./api";
import { fetchCoverageNames, type Product } from "./capabilities";
import {
  DEFAULT_MAX_FEATURES, downloadFilter, downloadName, fetchDownload, fmtBytes, intersect, saveBlob, singleInstant,
  vectorFormat, VECTOR_FORMATS, wcsDownloadUrl, wfsDownloadUrl, type Bounds, type VectorFormat,
} from "./download";
import { IconClose } from "./icons";
import { track } from "./usage";

const n = (v: number) => v.toLocaleString("it-IT");
const boundsOf = (map: Pick<maplibregl.Map, "getBounds">): Bounds => {
  const [[w, s], [e, nn]] = map.getBounds().toArray();
  return [w, s, e, nn];
};

/**
 * Scarico dei dati di un layer attivo, con il filtro e la data che ha sulla mappa:
 * vettoriali via WFS (CSV, GeoJSON, Shapefile; area visibile o tutto il layer; la data non si applica, come in tabella e dashboard),
 * raster via WCS (GeoTIFF dell'area visibile, alla data scelta se è un istante).
 */
export default function DownloadPanel({
  gsUrl, kc, product, cql, time, map, maxFeatures, onClose,
}: {
  gsUrl: string;
  kc: Keycloak | null;
  product: Product;
  cql: string;
  time: string;
  map: Pick<maplibregl.Map, "getBounds" | "on" | "off">;
  maxFeatures?: number;
  onClose: () => void;
}) {
  const layer = product.name;
  const vector = product.vector !== false;
  const max = maxFeatures && maxFeatures > 0 ? maxFeatures : DEFAULT_MAX_FEATURES;
  const [format, setFormat] = useState<VectorFormat>("geojson");
  const [area, setArea] = useState<"view" | "all">("view");
  const [bounds, setBounds] = useState<Bounds>(() => boundsOf(map));
  const [geomName, setGeomName] = useState<string | null>(null);
  const [count, setCount] = useState<number | null | undefined>(undefined); // undefined = in corso, null = non disponibile
  const [coverage, setCoverage] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // l'area segue la mappa mentre il pannello è aperto
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const onMove = () => { clearTimeout(t); t = setTimeout(() => setBounds(boundsOf(map)), 300); };
    map.on("moveend", onMove);
    return () => { clearTimeout(t); map.off("moveend", onMove); };
  }, [map]);

  // vettoriale: colonna geometrica (serve al filtro sull'area); raster: il layer è pubblicato in WCS?
  useEffect(() => {
    let off = false;
    setError(null);
    if (vector) {
      describeLayer(gsUrl, kc, layer)
        .then((s) => { if (!off) setGeomName(s.geomName); })
        .catch((e) => { if (!off) setError(`Struttura del layer non disponibile: ${e.message}`); });
    } else {
      fetchCoverageNames(gsUrl, kc?.token).then((s) => { if (!off) setCoverage(s.has(layer)); });
    }
    return () => { off = true; };
  }, [gsUrl, kc, layer, vector]);

  const filter = useMemo(
    () => (geomName === null ? null : downloadFilter(geomName, cql, area === "view" ? bounds : null)),
    [geomName, cql, area, bounds],
  );

  useEffect(() => {
    if (!vector || filter === null) return;
    let off = false;
    setCount(undefined);
    const t = setTimeout(() => {
      getWfsCount(gsUrl, kc, layer, filter)
        .then((c) => { if (!off) setCount(c); })
        .catch(() => { if (!off) setCount(null); });
    }, 250);
    return () => { off = true; clearTimeout(t); };
  }, [vector, filter, gsUrl, kc, layer]);

  const rasterArea = vector ? null : intersect(bounds, product.bbox);
  const instant = singleInstant(time);

  const download = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      let blob: Blob;
      let name: string;
      const now = boundsOf(map); // l'area di adesso, anche se la mappa si è appena spostata
      if (vector) {
        const f = vectorFormat(format);
        const fl = downloadFilter(geomName ?? "", cql, area === "view" ? now : null);
        // la data non va al WFS: GeoServer non garantisce di applicarla (come per tabella e dashboard)
        blob = await fetchDownload(wfsDownloadUrl(gsUrl, layer, format, { filter: fl, max }), kc, format === "geojson" ? "json" : format === "csv" ? "text" : "binary");
        name = downloadName(layer, f.ext);
      } else {
        const a = intersect(now, product.bbox);
        if (!a) throw new Error("l'area visibile non contiene dati di questo layer");
        blob = await fetchDownload(wcsDownloadUrl(gsUrl, layer, a, time), kc, "binary");
        name = downloadName(layer, "tif");
      }
      saveBlob(blob, name);
      track("download", layer, name.split(".").pop() ?? "");
      setDone(`Scaricato ${name} (${fmtBytes(blob.size)})`);
    } catch (e) {
      setError(`Scarico non riuscito: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const ready = vector ? filter !== null && count !== 0 : coverage === true && rasterArea !== null;

  return (
    <div className="float-panel download" role="dialog" aria-label="Scarica dati">
      <div className="fp-head">
        <strong>Scarica dati</strong>
        <button className="icon-btn" title="Chiudi" aria-label="Chiudi lo scarico" onClick={onClose}><IconClose /></button>
      </div>
      <div className="fp-body">
        <div className="dl-layer" title={layer}>{product.title}</div>

        {vector ? (
          <>
            <label className="dl-row">
              <span>Formato</span>
              <select aria-label="Formato" value={format} onChange={(e) => setFormat(e.target.value as VectorFormat)}>
                {VECTOR_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
            </label>
            <div className="dl-row" role="radiogroup" aria-label="Area">
              <span>Area</span>
              <label><input type="radio" name="dl-area" checked={area === "view"} onChange={() => setArea("view")} /> Area visibile</label>
              <label><input type="radio" name="dl-area" checked={area === "all"} onChange={() => setArea("all")} /> Tutto il layer</label>
            </div>
            {(cql.trim() || time.trim()) && (
              <div className="muted dl-filters">
                {cql.trim() && <div>Filtro: <code>{cql.trim()}</code></div>}
                {time.trim() && <div>La data della mappa ({time.trim()}) non si applica: si scaricano tutte le date.</div>}
              </div>
            )}
            <div className="dl-count" aria-live="polite">
              {count === undefined ? "Conteggio degli oggetti…" : count === null ? "Numero di oggetti non disponibile" : count === 0 ? "Nessun oggetto con questi criteri" : `${n(count)} oggetti`}
            </div>
            {count != null && count > max && (
              <div className="warn" role="status">
                Verranno scaricati solo i primi {n(max)} oggetti: restringi l'area o il filtro per averli tutti.
              </div>
            )}
            <div className="muted">Coordinate in gradi (EPSG:4326).</div>
          </>
        ) : (
          <>
            <div className="dl-row"><span>Formato</span><span>GeoTIFF dell'area visibile</span></div>
            {coverage === undefined && <div className="muted">Verifica della disponibilità…</div>}
            {coverage === false && <div className="warn" role="status">Questo layer non è pubblicato come copertura WCS: non si può scaricare.</div>}
            {coverage && !rasterArea && <div className="warn" role="status">L'area visibile non contiene dati di questo layer.</div>}
            {time.trim() && (
              <div className="muted">{instant ? `Data: ${instant}` : "Per un intervallo di date si scarica la data predefinita del layer."}</div>
            )}
          </>
        )}

        <div className="btn-row">
          <button className="btn-sm primary" disabled={busy || !ready} onClick={() => { void download(); }}>{busy ? "Preparazione…" : "Scarica"}</button>
        </div>
        {done && <div className="ok" role="status">{done}</div>}
        {error && <div className="error" role="alert">{error}</div>}
      </div>
    </div>
  );
}
