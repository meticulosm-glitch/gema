import { useCallback, useEffect, useMemo, useState } from "react";
import type Keycloak from "keycloak-js";
import type { AccessConfig } from "./config";
import type { Product } from "./capabilities";
import { describeLayer, getWfsFeatures, type Schema } from "./api";
import { isMissingTable, loadEditForms, saveEditForm } from "./configStore";
import {
  distinctValues, formatOptions, isDefaultRule, newValues, parseOptions, resolveForm, validateValues, type FieldRule, type FormDef,
} from "./editForm";
import EditFields from "./EditFields";
import { IconDown, IconUp } from "./icons";

/** Regole del modulo nell'ordine dei campi dello schema (quelli configurati prima, nel loro ordine). */
function draftFor(schema: Schema, def?: FormDef): FieldRule[] {
  const rules = new Map((def?.fields ?? []).map((r) => [r.name, r]));
  return resolveForm(schema.fields, def).map((f) => rules.get(f.name) ?? { name: f.name });
}

/** Problemi che impediscono il salvataggio e avvisi. */
function check(schema: Schema, rules: FieldRule[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fields = resolveForm(schema.fields, { fields: rules });
  // i valori predefiniti devono essere validi come se li scrivesse l'utente
  const withDefaults = fields.filter((f) => f.default).map((f) => ({ ...f, required: false, readonly: false, hidden: false }));
  for (const [name, msg] of Object.entries(validateValues(withDefaults, newValues(withDefaults), true))) errors.push(`Valore predefinito di «${name}»: ${msg.toLowerCase()}`);
  for (const r of rules) {
    if (r.required && r.readonly && !r.default) errors.push(`«${r.name}» è obbligatorio e in sola lettura senza un valore predefinito: nessun nuovo oggetto si potrebbe salvare.`);
    if (r.required && r.hidden) warnings.push(`«${r.name}» è nascosto: l'obbligo non si applica (i nuovi oggetti prendono il valore predefinito${r.default ? "" : ", che è vuoto"}).`);
  }
  return { errors, warnings };
}

function FieldCard({
  rule, type, index, count, onChange, onMove, onLoadValues,
}: {
  rule: FieldRule; type: string; index: number; count: number;
  onChange: (r: FieldRule) => void; onMove: (d: -1 | 1) => void; onLoadValues: () => Promise<string[]>;
}) {
  const [menuText, setMenuText] = useState(formatOptions(rule.options));
  const [menuOpen, setMenuOpen] = useState(!!rule.options?.length);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const set = (p: Partial<FieldRule>) => {
    const next: FieldRule = { ...rule, ...p };
    for (const k of Object.keys(next) as (keyof FieldRule)[]) if (next[k] === "" || next[k] === false || (Array.isArray(next[k]) && !(next[k] as unknown[]).length)) delete next[k];
    onChange({ ...next, name: rule.name });
  };
  const setMenu = (text: string) => { setMenuText(text); set({ options: parseOptions(text) }); };
  const loadValues = async () => {
    setLoading(true); setNote(null);
    try {
      const vals = await onLoadValues();
      const existing = parseOptions(menuText);
      const merged = [...existing, ...vals.filter((v) => !existing.some((o) => o.value === v)).map((v) => ({ value: v, label: v }))];
      setMenu(formatOptions(merged));
      setNote(vals.length ? `${vals.length} valori trovati nel layer.` : "Nessun valore nel layer.");
    } catch (e) {
      setNote(`Valori non letti: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className={`form-field-card${isDefaultRule(rule) ? "" : " configured"}`} data-field={rule.name}>
      <div className="ffc-head">
        <span className="ffc-moves">
          <button className="icon-btn" aria-label={`Sposta su ${rule.name}`} disabled={index === 0} onClick={() => onMove(-1)}><IconUp /></button>
          <button className="icon-btn" aria-label={`Sposta giù ${rule.name}`} disabled={index === count - 1} onClick={() => onMove(1)}><IconDown /></button>
        </span>
        <code>{rule.name}</code><span className="muted">{type}</span>
        <span className="spacer" />
        <label className="check"><input type="checkbox" checked={!!rule.required} onChange={(e) => set({ required: e.target.checked })} /> Obbligatorio</label>
        <label className="check"><input type="checkbox" checked={!!rule.readonly} onChange={(e) => set({ readonly: e.target.checked })} /> Sola lettura</label>
        <label className="check"><input type="checkbox" checked={!!rule.hidden} onChange={(e) => set({ hidden: e.target.checked })} /> Nascosto</label>
      </div>
      <div className="ffc-grid">
        <label><span>Etichetta</span><input className="search" value={rule.alias ?? ""} placeholder={rule.name} onChange={(e) => set({ alias: e.target.value })} /></label>
        <label><span>Valore predefinito (nuovi oggetti)</span><input className="search" value={rule.default ?? ""} onChange={(e) => set({ default: e.target.value })} /></label>
        <label className="ffc-wide"><span>Aiuto</span><input className="search" value={rule.help ?? ""} placeholder="Facoltativo: appare sotto il campo" onChange={(e) => set({ help: e.target.value })} /></label>
      </div>
      <div className="btn-row">
        <button className="btn-sm" onClick={() => setMenuOpen((o) => !o)} aria-expanded={menuOpen}>{menuOpen ? "Nascondi menu" : rule.options?.length ? `Menu a tendina (${rule.options.length})` : "Menu a tendina…"}</button>
        {menuOpen && <button className="btn-sm" disabled={loading} onClick={() => void loadValues()}>{loading ? "Lettura…" : "Aggiungi i valori presenti nel layer"}</button>}
        {menuOpen && rule.options?.length ? <button className="btn-sm" onClick={() => setMenu("")}>Togli il menu</button> : null}
        {note && <span className="muted">{note}</span>}
      </div>
      {menuOpen && (
        <label className="ffc-menu"><span>Voci del menu, una per riga: <code>valore</code> oppure <code>valore|etichetta</code></span>
          <textarea className="search" rows={4} value={menuText} aria-label={`Voci del menu di ${rule.name}`} onChange={(e) => setMenu(e.target.value)} />
        </label>
      )}
    </div>
  );
}

/** Pagina admin: moduli di modifica per layer (etichette, obbligatori, sola lettura, nascosti, menu, predefiniti). */
export default function AdminForms({ gs, kc, acc, products }: { gs: string; kc: Keycloak; acc: AccessConfig; products: Product[] }) {
  const vector = useMemo(() => products.filter((p) => p.vector !== false), [products]);
  const [forms, setForms] = useState<FormDef[]>([]);
  const [tableError, setTableError] = useState<string | null>(null);
  const [layer, setLayer] = useState<string>("");
  const [schema, setSchema] = useState<Schema | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [draft, setDraft] = useState<FieldRule[]>([]);
  const [base, setBase] = useState<string>("[]");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [previewEdits, setPreviewEdits] = useState<Record<string, string>>({}); // valori scritti nell'anteprima
  const [filter, setFilter] = useState("");
  const [rev, setRev] = useState(0); // cambia quando la bozza viene sostituita (carica, annulla): i campi si rimontano

  const reload = useCallback(async () => {
    try { setForms(await loadEditForms(gs, kc, acc)); setTableError(null); }
    catch (e) {
      setForms([]);
      setTableError(isMissingTable(e)
        ? `Tabella dei moduli non trovata: in GeoServer deve esistere il layer ${acc.workspace}:edit_forms (riesegui il Job di configurazione). Finché manca, l'editor usa i campi predefiniti.`
        : `Impossibile leggere i moduli: ${(e as Error).message}`);
    }
  }, [gs, kc, acc]);
  useEffect(() => { void reload(); }, [reload]);

  const current = forms.find((f) => f.layer === layer);
  // schema del layer scelto e bozza del suo modulo
  useEffect(() => {
    let off = false;
    setSchema(null); setSchemaError(null); setMsg(null);
    if (!layer) return;
    describeLayer(gs, kc, layer)
      .then((s) => { if (off) return; setSchema(s); })
      .catch((e) => !off && setSchemaError(`Schema non disponibile: ${e.message}`));
    return () => { off = true; };
  }, [gs, kc, layer]);
  useEffect(() => {
    if (!schema) return;
    const d = draftFor(schema, current);
    setDraft(d); setBase(JSON.stringify(d)); setRev((r) => r + 1); setPreviewEdits({});
  }, [schema, current]);

  const dirty = JSON.stringify(draft) !== base;
  const verdict = schema ? check(schema, draft) : { errors: [], warnings: [] };
  const fields = schema ? resolveForm(schema.fields, { fields: draft }) : [];
  const unchangedOrder = schema ? draft.every((r, i) => r.name === schema.fields[i]?.name) : true;
  const isPlain = draft.every(isDefaultRule) && unchangedOrder;

  const update = (i: number, r: FieldRule) => { setDraft((d) => d.map((x, j) => (j === i ? r : x))); setMsg(null); };
  const move = (i: number, dlt: number) => setDraft((d) => { const n = [...d]; const j = i + dlt; if (j < 0 || j >= n.length) return d; [n[i], n[j]] = [n[j], n[i]]; return n; });

  const save = async (reset = false) => {
    if (!layer) return;
    setBusy(true); setMsg(null);
    try {
      await saveEditForm(gs, kc, acc, { fid: current?.fid, layer, fields: reset || isPlain ? [] : draft });
      await reload();
      setMsg({ ok: true, text: reset || isPlain ? "Modulo predefinito ripristinato." : "Modulo salvato: vale dalla prossima apertura dell'editor." });
    } catch (e) {
      setMsg({ ok: false, text: `Salvataggio non riuscito: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const shown = vector.filter((p) => !filter || `${p.title} ${p.name}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="page-inner wide">
      <h1>Moduli di modifica</h1>
      <p className="muted">
        Come appaiono gli attributi nell'editor dei layer vettoriali: etichette, ordine, campi obbligatori, in sola lettura o nascosti,
        menu a tendina e valori predefiniti dei nuovi oggetti. Sono regole dell'interfaccia: i vincoli veri restano quelli del database.
      </p>
      {tableError && <div className="error">{tableError}</div>}
      <div className="dash-admin forms-admin">
        <div className="dash-list">
          <input className="search" placeholder="Cerca un layer…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Cerca un layer" />
          {shown.map((p) => {
            const configured = forms.some((f) => f.layer === p.name);
            return (
              <button key={p.name} className={`dash-item${layer === p.name ? " on" : ""}`} data-layer={p.name} onClick={() => setLayer(p.name)}>
                <strong>{p.title}</strong>
                <span className="muted">{p.name}{configured ? " · modulo configurato" : ""}</span>
              </button>
            );
          })}
          {shown.length === 0 && <div className="empty">Nessun layer vettoriale.</div>}
        </div>
        <div className="dash-editor">
          {!layer && <div className="empty">Scegli un layer vettoriale per configurarne il modulo.</div>}
          {schemaError && <div className="error">{schemaError}</div>}
          {layer && !schema && !schemaError && <div className="empty">Lettura dello schema…</div>}
          {schema && (
            <>
              <div className="btn-row">
                <h2 className="forms-title">{vector.find((p) => p.name === layer)?.title ?? layer}</h2>
                <span className="spacer" />
                {current?.updatedBy && <span className="muted">modificato da {current.updatedBy}</span>}
                <button className="btn-sm" disabled={busy || !dirty} onClick={() => { setDraft(JSON.parse(base)); setRev((r) => r + 1); setMsg(null); }}>Annulla modifiche</button>
                {current && <button className="btn-sm danger" disabled={busy || !!tableError} onClick={() => void save(true)}>Ripristina predefinito</button>}
                <button className="btn-sm primary" disabled={busy || !dirty || verdict.errors.length > 0 || !!tableError} onClick={() => void save()}>{busy ? "Salvataggio…" : "Salva modulo"}</button>
              </div>
              {msg && <div className={msg.ok ? "ok" : "error"} role="status">{msg.text}</div>}
              {verdict.errors.length > 0 && <div className="problems">{verdict.errors.map((e) => <div key={e} className="error">{e}</div>)}</div>}
              {verdict.warnings.map((w) => <div key={w} className="notice">{w}</div>)}
              <div className="forms-grid">
                <div className="forms-fields">
                  {draft.map((r, i) => (
                    <FieldCard
                      key={`${r.name}|${rev}`}
                      rule={r}
                      type={schema.fields.find((f) => f.name === r.name)?.type ?? ""}
                      index={i}
                      count={draft.length}
                      onChange={(x) => update(i, x)}
                      onMove={(d) => move(i, d)}
                      onLoadValues={async () => distinctValues((await getWfsFeatures(gs, kc, layer, "", 5000, [r.name])).map((f) => f.properties ?? {}), r.name)}
                    />
                  ))}
                </div>
                <div className="forms-preview">
                  <div className="section-title">Anteprima: nuovo oggetto</div>
                  <div className="float-panel editor static">
                    <EditFields fields={fields} values={{ ...newValues(fields), ...previewEdits }} isNew onChange={(n, v) => setPreviewEdits((p) => ({ ...p, [n]: v }))} />
                  </div>
                  <div className="muted">I campi nascosti non compaiono: i nuovi oggetti prendono il loro valore predefinito.</div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
