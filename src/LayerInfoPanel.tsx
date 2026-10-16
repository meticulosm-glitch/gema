import { useEffect, useState } from "react";
import type Keycloak from "keycloak-js";
import { describeLayer, getWfsCount, type Schema } from "./api";
import type { Product } from "./capabilities";
import { shortTime, timeSteps } from "./timeline";
import { IconClose, IconZoom } from "./icons";

/** Solo http/https (i link arrivano dal GetCapabilities: niente javascript: e simili). */
export const safeHref = (u?: string) => (u && /^https?:\/\//i.test(u.trim()) ? u.trim() : undefined);

const fmt = (n: number) => n.toLocaleString("it-IT");
const deg = (n: number) => n.toFixed(4);

/** Scheda di un layer: quello che GeoServer dichiara nel GetCapabilities, più numero di oggetti e attributi per i vettoriali. */
export default function LayerInfoPanel({
  product, gsUrl, kc, active, onClose, onZoom, onToggle,
}: {
  product: Product;
  gsUrl: string;
  kc: Keycloak | null;
  active: boolean;
  onClose: () => void;
  onZoom: (p: Product) => void;
  onToggle: (name: string) => void;
}) {
  const [schema, setSchema] = useState<Schema | null>(null);
  const [count, setCount] = useState<number | null | "err">(null);
  const isVector = product.vector !== false;

  useEffect(() => {
    let cancelled = false;
    setSchema(null);
    setCount(null);
    if (!isVector) return;
    describeLayer(gsUrl, kc, product.name).then((s) => { if (!cancelled) setSchema(s); }).catch(() => {});
    getWfsCount(gsUrl, kc, product.name).then((n) => { if (!cancelled) setCount(n); }).catch(() => { if (!cancelled) setCount("err"); });
    return () => { cancelled = true; };
  }, [product.name, gsUrl, kc, isVector]);

  const steps = timeSteps(product.time);
  const attr = product.attribution;
  const attrHref = safeHref(attr?.url);
  const metaHref = safeHref(product.metadataUrl);
  const geom = schema?.geomType;

  return (
    <div className="float-panel layerinfo">
      <div className="fp-head">
        <strong title={product.name}>{product.title}</strong>
        <button className="icon-btn" title="Chiudi" aria-label="Chiudi la scheda" onClick={onClose}><IconClose /></button>
      </div>
      <div className="fp-body">
        <div className="li-badges">
          <span className="chip">{product.vector === true ? "Vettoriale" : product.vector === false ? "Raster / gruppo" : "Layer"}</span>
          {product.time && <span className="chip">Serie temporale</span>}
          <code className="li-name">{product.name}</code>
        </div>

        {product.abstract ? <p className="li-abstract">{product.abstract}</p> : <div className="muted">Nessuna descrizione in GeoServer.</div>}

        {product.keywords && product.keywords.length > 0 && (
          <div className="li-kw" aria-label="Parole chiave">{product.keywords.map((k) => <span key={k} className="chip">{k}</span>)}</div>
        )}

        <dl className="li-facts">
          {product.bbox && (
            <>
              <dt>Estensione</dt>
              <dd>
                O {deg(product.bbox[0])} · S {deg(product.bbox[1])}<br />E {deg(product.bbox[2])} · N {deg(product.bbox[3])}
                <button className="btn-sm" onClick={() => onZoom(product)}><IconZoom /> Zoom</button>
              </dd>
            </>
          )}
          {product.time && (
            <>
              <dt>Dati nel tempo</dt>
              <dd>
                {steps.length > 1
                  ? <>{fmt(steps.length)} date, dal {shortTime(steps[0])} al {shortTime(steps[steps.length - 1])}</>
                  : <>{product.time.extent || "intervallo non elencabile"}</>}
                <br /><span className="muted">Ultimo dato disponibile: {shortTime(product.time.default || steps[steps.length - 1] || "") || "—"}</span>
              </dd>
            </>
          )}
          {isVector && (
            <>
              <dt>Oggetti</dt>
              <dd>{count === null ? "…" : count === "err" || count === undefined ? "non disponibile" : fmt(count)}</dd>
              {geom && <><dt>Geometria</dt><dd>{geom}</dd></>}
              {schema && <><dt>Attributi</dt><dd>{schema.fields.length === 0 ? "nessuno" : schema.fields.map((f) => f.name).join(", ")}</dd></>}
            </>
          )}
          {product.styles && product.styles.length > 0 && (
            <><dt>Stili</dt><dd>{product.styles.map((s) => s.title).join(", ")}</dd></>
          )}
          {attr && (attr.title || attrHref) && (
            <><dt>Fonte</dt><dd>{attrHref ? <a href={attrHref} target="_blank" rel="noreferrer noopener">{attr.title || attrHref}</a> : attr.title}</dd></>
          )}
          {metaHref && <><dt>Metadati</dt><dd><a href={metaHref} target="_blank" rel="noreferrer noopener">Apri la scheda dei metadati</a></dd></>}
        </dl>
        <div className="muted">GeoServer non pubblica una data di aggiornamento per layer: per le serie temporali vale l'ultimo valore di TIME.</div>
        <button className="btn-sm primary" onClick={() => onToggle(product.name)}>{active ? "Rimuovi dalla mappa" : "Aggiungi alla mappa"}</button>
      </div>
    </div>
  );
}
