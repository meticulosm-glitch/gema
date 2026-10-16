import { useEffect, useRef, useState } from "react";
import type Keycloak from "keycloak-js";
import { MIN_QUERY, searchPlaces, type GeocoderConfig, type Place } from "./geocode";
import { searchLayers, type AttrHit } from "./search";
import { IconClose, IconSearch } from "./icons";

interface Results { term: string; places: Place[]; hits: AttrHit[]; skipped: string[]; errors: string[] }

/**
 * Ricerca nell'header: luoghi e indirizzi (geocoder) e testo negli attributi dei layer vettoriali attivi.
 * Photon regge la ricerca mentre si scrive; Nominatim pubblico la vieta (policy d'uso), quindi parte con Invio.
 */
export default function SearchBox({
  geocoder, attrLayers, gsUrl, kc, getBias, onPlace, onHit,
}: {
  geocoder?: GeocoderConfig;
  attrLayers: { name: string; title: string }[];  // layer vettoriali attivi in cui cercare
  gsUrl: string;
  kc: Keycloak | null;
  getBias?: () => { lng: number; lat: number } | undefined;
  onPlace: (p: Place) => void;
  onHit: (h: AttrHit) => void;
}) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [res, setRes] = useState<Results | null>(null);
  const seq = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const layersRef = useRef(attrLayers); layersRef.current = attrLayers;
  const auto = !geocoder || geocoder.type === "photon";   // ricerca mentre si scrive

  const run = async (termRaw: string) => {
    const term = termRaw.trim();
    const id = ++seq.current;
    if (term.length < MIN_QUERY) { setRes(null); setBusy(false); return; }
    setBusy(true);
    setOpen(true);
    const errors: string[] = [];
    const [places, attr] = await Promise.all([
      geocoder
        ? searchPlaces(geocoder, term, undefined, getBias?.()).catch((e: Error) => { errors.push(e.message); return [] as Place[]; })
        : Promise.resolve([] as Place[]),
      layersRef.current.length > 0 ? searchLayers(gsUrl, kc, layersRef.current, term) : Promise.resolve({ hits: [] as AttrHit[], skipped: [] as string[], errors: [] }),
    ]);
    if (id !== seq.current) return; // è partita una ricerca più recente
    for (const e of attr.errors) errors.push(`${e.layer}: ${e.message}`);
    setRes({ term, places, hits: attr.hits, skipped: attr.skipped, errors });
    setBusy(false);
  };

  // con ricerca automatica: pausa di 450 ms dopo l'ultimo tasto
  useEffect(() => {
    if (!auto) return;
    if (q.trim().length < MIN_QUERY) { seq.current++; setRes(null); setBusy(false); return; }
    const t = setTimeout(() => { void run(q); }, 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, auto]);

  // clic fuori: chiude l'elenco
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const clear = () => { seq.current++; setQ(""); setRes(null); setBusy(false); setOpen(false); };
  const placeholder = geocoder
    ? attrLayers.length > 0 ? "Cerca un luogo o un oggetto…" : "Cerca un luogo o un indirizzo…"
    : "Cerca negli attributi dei layer attivi…";
  const empty = !!res && res.places.length === 0 && res.hits.length === 0;

  return (
    <div className="hsearch" ref={box} role="search">
      <IconSearch />
      <input
        type="search"
        aria-label="Cerca luoghi e oggetti"
        placeholder={placeholder}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          // senza ricerca automatica (Nominatim) i risultati valgono per il testo cercato con Invio: se il testo cambia si tolgono,
          // altrimenti resterebbero in elenco luoghi che non c entrano più con quello che si sta scrivendo
          if (!auto) { seq.current++; setRes(null); setBusy(false); }
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void run(q); }
          else if (e.key === "Escape") setOpen(false);
          else if (e.key === "ArrowDown") { e.preventDefault(); box.current?.querySelector<HTMLElement>(".sr-item")?.focus(); }
        }}
      />
      {q && <button className="icon-btn" title="Cancella la ricerca" aria-label="Cancella la ricerca" onClick={clear}><IconClose /></button>}
      {open && (busy || res || q.trim().length > 0) && (
        <div className="search-results" role="listbox" aria-label="Risultati della ricerca"
          onKeyDown={(e) => {
            const items = Array.from(box.current?.querySelectorAll<HTMLElement>(".sr-item") ?? []);
            const i = items.indexOf(document.activeElement as HTMLElement);
            if (e.key === "ArrowDown" && i >= 0) { e.preventDefault(); items[Math.min(i + 1, items.length - 1)].focus(); }
            else if (e.key === "ArrowUp" && i >= 0) { e.preventDefault(); if (i === 0) box.current?.querySelector("input")?.focus(); else items[i - 1].focus(); }
            else if (e.key === "Escape") { setOpen(false); box.current?.querySelector("input")?.focus(); }
          }}>
          {busy && <div className="sr-note">Ricerca in corso…</div>}
          {!busy && !res && q.trim().length >= MIN_QUERY && !auto && <div className="sr-note">Premi Invio per cercare.</div>}
          {!busy && !res && q.trim().length < MIN_QUERY && <div className="sr-note">Scrivi almeno {MIN_QUERY} caratteri.</div>}
          {res && res.places.length > 0 && (
            <section>
              <div className="sr-title">Luoghi</div>
              {res.places.map((p, i) => (
                <button key={i} role="option" className="sr-item" onClick={() => { onPlace(p); setOpen(false); }}>
                  <span className="sr-main">{p.label}</span>
                  {p.sub && <span className="sr-sub">{p.sub}</span>}
                </button>
              ))}
            </section>
          )}
          {res && res.hits.length > 0 && (
            <section>
              <div className="sr-title">Oggetti nei layer attivi</div>
              {res.hits.map((h, i) => (
                <button key={`${h.layer}|${h.feature.id ?? i}`} role="option" className="sr-item" onClick={() => { onHit(h); setOpen(false); }}>
                  <span className="sr-main">{h.label}</span>
                  <span className="sr-sub">{h.title}{h.match ? ` · ${h.match}` : ""}</span>
                </button>
              ))}
            </section>
          )}
          {!busy && empty && res!.errors.length === 0 && <div className="sr-note">Nessun risultato per «{res!.term}».</div>}
          {!busy && res && res.errors.map((m, i) => <div key={i} className="error sr-err">{m}</div>)}
          {!busy && res && res.skipped.length > 0 && <div className="sr-note">Non cercato in: {res.skipped.join(", ")} (raster o senza attributi di testo).</div>}
          {!busy && !geocoder && attrLayers.length === 0 && <div className="sr-note">Accendi un layer vettoriale per cercare nei suoi attributi.</div>}
        </div>
      )}
    </div>
  );
}
