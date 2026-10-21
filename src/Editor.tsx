import { useCallback, useEffect, useRef, useState } from "react";
import type * as maplibregl from "maplibre-gl";
import type Keycloak from "keycloak-js";
import {
  describeLayer, getFeatureInfo, getWfsFeatureById, wfsTransaction, type Feature, type LayerParams, type Schema,
} from "./api";
import {
  buildDelete, buildGeometry, buildInsert, buildUpdate, kindFor, minPoints, type Geom, type Kind,
} from "./edit";
import { attachVertexEditor, renderDraft, renderEdit } from "./vertexEditor";
import type { AccessConfig } from "./config";
import { loadEditForm } from "./configStore";
import { newValues, resolveForm, validateValues, type FormDef } from "./editForm";
import EditFields from "./EditFields";
import type { LngLat } from "./geo";
import { IconClose } from "./icons";

type Stage = "idle" | "pick" | "draw" | "form";

interface Session {
  id?: string;                       // assente = nuovo oggetto
  values: Record<string, string>;
  original: Record<string, string>;
  geomDirty: boolean;
}

const str = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
const label = (f: Feature) => {
  const first = Object.values(f.properties ?? {}).find((v) => typeof v === "string" && v);
  return `${f.id ?? "oggetto"}${first ? ` — ${String(first).slice(0, 40)}` : ""}`;
};

/**
 * Editor di un layer vettoriale via WFS-T: seleziona un oggetto, modifica attributi e vertici,
 * crea un nuovo oggetto, elimina. I permessi veri li applica GeoServer: qui si mostra solo l'esito.
 */
export default function Editor({
  map, gsUrl, kc, layer, title, params, initial, access, onClose, onSaved,
}: {
  map: maplibregl.Map;
  gsUrl: string;
  kc: Keycloak | null;
  layer: string;
  title: string;
  params: LayerParams;               // filtro/tempo attivi del layer, usati per scegliere gli oggetti sulla mappa
  initial?: Feature;                 // oggetto da aprire subito (da Feature Info o dalla tabella)
  access?: AccessConfig;             // con il controllo accessi: modulo configurato del layer (tabella edit_forms)
  onClose: () => void;
  onSaved: () => void;               // chiamata dopo ogni scrittura riuscita (ricarica tile/tabella)
}) {
  const [schema, setSchema] = useState<Schema | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [kind, setKind] = useState<Kind | null>(null);
  const [pts, setPts] = useState<LngLat[]>([]);
  const [candidates, setCandidates] = useState<Feature[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [form, setForm] = useState<FormDef | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const geomRef = useRef<Geom | null>(null);
  const schemaRef = useRef<Schema | null>(null); schemaRef.current = schema;
  const formRef = useRef<FormDef | null>(null); formRef.current = form;
  const paramsRef = useRef(params); paramsRef.current = params;
  const initialRef = useRef(initial);

  const highlightOff = () => (map.getSource("highlight") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] } as any);

  const reset = useCallback(() => {
    geomRef.current = null;
    setSession(null); setStage("idle"); setPts([]); setCandidates([]); setKind(null);
    renderEdit(map, null);
  }, [map]);

  // oggetto esistente -> sessione di modifica (si rilegge da WFS per avere geometria e valori completi)
  const openFeature = useCallback(async (f: Feature) => {
    setBusy(true); setMsg(null);
    try {
      const full = f.id ? await getWfsFeatureById(gsUrl, kc, layer, f.id) : null;
      const src = full ?? f;
      if (!src.geometry) throw new Error("l'oggetto non ha geometria");
      const values: Record<string, string> = {};
      for (const [k, v] of Object.entries(src.properties ?? {})) values[k] = str(v);
      geomRef.current = JSON.parse(JSON.stringify(src.geometry));
      highlightOff();
      renderEdit(map, geomRef.current);
      setSession({ id: src.id ?? f.id, values, original: { ...values }, geomDirty: false });
      setErrors({});
      setCandidates([]); setStage("form");
    } catch (e: any) {
      setMsg({ ok: false, text: `Impossibile aprire l'oggetto: ${e.message}` });
    } finally {
      setBusy(false);
    }
  }, [gsUrl, kc, layer, map]);

  // schema del layer (fallisce per i raster) e modulo configurato (se non si legge: campi predefiniti)
  useEffect(() => {
    let cancelled = false;
    const formP = access
      ? loadEditForm(gsUrl, kc, access, layer).catch((e) => { console.warn("[mapp] modulo di modifica non disponibile:", e?.message ?? e); return null; })
      : Promise.resolve(null);
    Promise.all([describeLayer(gsUrl, kc, layer), formP])
      .then(([s, f]) => {
        if (cancelled) return;
        setForm(f);
        setSchema(s);
        setKind(kindFor(s.geomType));
        if (initialRef.current) void openFeature(initialRef.current);
      })
      .catch((e) => !cancelled && setMsg({ ok: false, text: `Questo layer non è modificabile: ${e.message}` }));
    return () => { cancelled = true; };
  }, [gsUrl, kc, layer, openFeature, access]);

  // clic sulla mappa: scelta dell'oggetto (pick) o nuovo vertice (draw)
  useEffect(() => {
    if (stage !== "pick" && stage !== "draw") return;
    map.getCanvas().style.cursor = "crosshair";
    map.doubleClickZoom.disable();
    const onClick = async (e: maplibregl.MapMouseEvent) => {
      if (stage === "pick") {
        setBusy(true); setMsg(null);
        try {
          const found = (await getFeatureInfo(gsUrl, kc, layer, map, e.lngLat, paramsRef.current)).filter((f) => f.id);
          if (found.length === 0) setMsg({ ok: false, text: "Nessun oggetto in questo punto: riprova più vicino." });
          else if (found.length === 1) await openFeature(found[0]);
          else setCandidates(found);
        } catch (err: any) {
          setMsg({ ok: false, text: `Interrogazione fallita: ${err.message}` });
        } finally {
          setBusy(false);
        }
      } else if (kind) {
        setPts((p) => (kind === "point" ? [[e.lngLat.lng, e.lngLat.lat]] : [...p, [e.lngLat.lng, e.lngLat.lat]]));
      }
    };
    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
      map.getCanvas().style.cursor = "";
      map.doubleClickZoom.enable();
    };
  }, [stage, kind, map, gsUrl, kc, layer, openFeature]);

  // bozza del disegno
  useEffect(() => {
    if (stage === "draw" && kind) renderDraft(map, kind, pts);
  }, [stage, kind, pts, map]);

  // un punto si completa al primo clic
  useEffect(() => {
    if (stage === "draw" && kind === "point" && pts.length === 1) finishDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pts]);

  // modifica vertici mentre il modulo è aperto
  useEffect(() => {
    if (stage !== "form") return;
    map.getCanvas().style.cursor = "crosshair";
    map.doubleClickZoom.disable();
    const detach = attachVertexEditor(map, () => geomRef.current, () => setSession((s) => (s ? { ...s, geomDirty: true } : s)));
    return () => {
      detach();
      map.getCanvas().style.cursor = "";
      map.doubleClickZoom.enable();
    };
  }, [stage, map]);

  // pulizia alla chiusura
  useEffect(() => () => { renderEdit(map, null); }, [map]);

  const finishDraw = () => {
    const s = schemaRef.current;
    if (!s || !kind || pts.length < minPoints(kind)) return;
    const g = buildGeometry(kind, pts, s.geomType);
    geomRef.current = g;
    renderEdit(map, g);
    setSession({ values: newValues(resolveForm(s.fields, formRef.current)), original: {}, geomDirty: true });
    setErrors({});
    setStage("form");
  };

  const send = async (xml: string, okText: string) => {
    setBusy(true); setMsg(null);
    try {
      await wfsTransaction(gsUrl, kc, xml);
      onSaved();
      reset();
      setMsg({ ok: true, text: okText });
    } catch (e: any) {
      setMsg({ ok: false, text: `Scrittura non riuscita: ${e.message}` });
    } finally {
      setBusy(false);
    }
  };

  const fields = schema ? resolveForm(schema.fields, form) : [];
  const save = () => {
    if (!schema || !session || !geomRef.current) return;
    const errs = validateValues(fields, session.values, !session.id);
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      setMsg({ ok: false, text: `Controlla i campi evidenziati (${Object.keys(errs).length}).` });
      return;
    }
    if (!session.id) {
      const values = Object.fromEntries(Object.entries(session.values).filter(([, v]) => v !== ""));
      void send(buildInsert(schema, values, geomRef.current), "Nuovo oggetto creato.");
      return;
    }
    const changes: Record<string, string | null> = {};
    for (const f of fields) {
      if (f.readonly || f.hidden) continue; // non modificabili dall'utente: non si riscrivono
      const now = session.values[f.name] ?? "";
      if (now !== (session.original[f.name] ?? "")) changes[f.name] = now === "" ? null : now;
    }
    if (Object.keys(changes).length === 0 && !session.geomDirty) {
      setMsg({ ok: true, text: "Nessuna modifica da salvare." });
      return;
    }
    void send(buildUpdate(schema, session.id, changes, session.geomDirty ? geomRef.current : null), "Modifiche salvate.");
  };

  const remove = () => {
    if (!schema || !session?.id) return;
    if (!window.confirm("Eliminare definitivamente questo oggetto?")) return;
    void send(buildDelete(schema, session.id), "Oggetto eliminato.");
  };

  const kinds: { id: Kind; text: string }[] = [
    { id: "point", text: "Punto" }, { id: "line", text: "Linea" }, { id: "polygon", text: "Poligono" },
  ];
  const fixedKind = schema ? kindFor(schema.geomType) : null;

  return (
    <div className="float-panel editor">
      <div className="fp-head">
        <strong title={layer}>Modifica · {title}</strong>
        <button className="icon-btn" title="Chiudi editor" onClick={onClose}><IconClose /></button>
      </div>
      <div className="fp-body">
        {!schema && !msg && <div className="empty">Lettura dello schema…</div>}
        {msg && <div className={msg.ok ? "ok" : "error"}>{msg.text}</div>}
        {busy && <div className="muted">Operazione in corso…</div>}

        {schema && stage === "idle" && (
          <div className="ed-pad">
            <button className="btn-sm primary" onClick={() => { setMsg(null); setStage("pick"); }}>Seleziona oggetto da modificare</button>
            <div className="ed-row">
              <span className="muted">Nuovo oggetto:</span>
              {(fixedKind ? kinds.filter((k) => k.id === fixedKind) : kinds).map((k) => (
                <button key={k.id} className="btn-sm" onClick={() => { setMsg(null); setKind(k.id); setPts([]); setStage("draw"); }}>{k.text}</button>
              ))}
            </div>
            <div className="muted">Geometria del layer: {schema.geomType}. Le scritture usano i permessi dell'utente su GeoServer.</div>
          </div>
        )}

        {stage === "pick" && (
          <div className="ed-pad">
            <div className="muted">Clicca sulla mappa l'oggetto da modificare.</div>
            {candidates.length > 0 && (
              <>
                <div className="section-title ed-title">Più oggetti nel punto</div>
                <ul className="cand">
                  {candidates.map((f) => <li key={f.id}><button className="link" onClick={() => void openFeature(f)}>{label(f)}</button></li>)}
                </ul>
              </>
            )}
            <button className="btn-sm" onClick={reset}>Annulla</button>
          </div>
        )}

        {stage === "draw" && kind && (
          <div className="ed-pad">
            {!fixedKind && (
              <div className="ed-row">
                {kinds.map((k) => (
                  <button key={k.id} className={`btn-sm${kind === k.id ? " primary" : ""}`} onClick={() => { setKind(k.id); setPts([]); }}>{k.text}</button>
                ))}
              </div>
            )}
            <div className="muted">
              {kind === "point" ? "Clicca sulla mappa per posizionare il punto." : `Clicca per aggiungere vertici (${pts.length}, minimo ${minPoints(kind)}).`}
            </div>
            <div className="ed-row">
              {kind !== "point" && <button className="btn-sm primary" disabled={pts.length < minPoints(kind)} onClick={finishDraw}>Termina disegno</button>}
              {kind !== "point" && <button className="btn-sm" disabled={pts.length === 0} onClick={() => setPts((p) => p.slice(0, -1))}>Annulla punto</button>}
              <button className="btn-sm" onClick={reset}>Annulla</button>
            </div>
          </div>
        )}

        {stage === "form" && schema && session && (
          <>
            <div className="ed-pad muted">
              {session.id ? `Oggetto ${session.id}` : "Nuovo oggetto"} — trascina i vertici per spostarli, trascina i punti chiari per aggiungerne, tasto destro su un vertice per eliminarlo.
              {session.geomDirty && <strong> Geometria modificata.</strong>}
            </div>
            <EditFields
              fields={fields}
              values={session.values}
              errors={errors}
              isNew={!session.id}
              onChange={(name, val) => {
                setSession((x) => (x ? { ...x, values: { ...x.values, [name]: val } } : x));
                setMsg(null);
                setErrors((e) => { if (!(name in e)) return e; const { [name]: _drop, ...rest } = e; return rest; });
              }}
            />
            <div className="ed-pad ed-row">
              <button className="btn-sm primary" disabled={busy} onClick={save}>Salva</button>
              {session.id && <button className="btn-sm danger" disabled={busy} onClick={remove}>Elimina</button>}
              <button className="btn-sm" disabled={busy} onClick={reset}>Annulla</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
