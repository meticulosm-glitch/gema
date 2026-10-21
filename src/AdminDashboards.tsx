import { useEffect, useMemo, useState } from "react";
import type Keycloak from "keycloak-js";
import type { AccessConfig } from "./config";
import type { Product } from "./capabilities";
import { describeLayer, type Schema } from "./api";
import {
  dashId, deleteDashboard, deleteDashboardAndDraft, deleteDashboardDraft, importDashboards, publishDashboard, saveDashboard, saveDashboardDraft,
  type Agg, type DashboardDef, type DashboardDraft, type WidgetDef, type WidgetType,
} from "./configStore";
import { STATUS_LABEL, draftChanges, editorContent, itemStatus, itemTitle, mergeItems, previewNotes, sameContent } from "./dashDrafts";
import { DashboardBody, type MapStart } from "./DashboardPages";
import { startViewFor, type RoleView } from "./roleView";
import { duplicate, exportDashboards, exportName, missingLayers, parseImport, planImport, remapLayers, unknownRoles } from "./dashboardIO";
import { saveBlob } from "./download";
import { DATE_PRESETS, type DashFilters, type DatePreset } from "./dashFilters";
import { roleList } from "./AdminRoles";
import { computePermissions, type RoleRule } from "./roles";
import { WidgetCard, isDate, isNum } from "./Widgets";
import { AGGS, GRANULARITIES, TABLE_MAX_ROWS, WIDGET_TYPES, isDateField, usesAgg, usesField, usesLayer, widgetProblems } from "./widgetKinds";
import { navigate } from "./router";

const TYPES = WIDGET_TYPES;
const uid = () => Math.random().toString(36).slice(2, 9);
const blank = (): DashboardDef => ({ title: "", description: "", roles: [], widgets: [] });
const newWidget = (layer: string): WidgetDef => ({ id: uid(), type: "kpi", title: "", layer, agg: "count", w: 1 });

function WidgetForm({
  def, products, gs, kc, index, count, onChange, onMove, onRemove,
}: {
  def: WidgetDef; products: Product[]; gs: string; kc: Keycloak | null; index: number; count: number;
  onChange: (d: WidgetDef) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void;
}) {
  const [schema, setSchema] = useState<Schema | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let off = false; setSchema(null); setErr(null);
    if (!def.layer) return;
    describeLayer(gs, kc, def.layer).then((s) => !off && setSchema(s)).catch((e) => !off && setErr(`Il layer non è vettoriale: ${e.message}`));
    return () => { off = true; };
  }, [gs, kc, def.layer]);
  const fields = schema?.fields ?? [];
  const nums = fields.filter((f) => isNum(f.type));
  const groupable = def.type === "hist" ? nums : isDateField(def.type) ? fields.filter((f) => isDate(f.type)) : fields;
  const set = (p: Partial<WidgetDef>) => onChange({ ...def, ...p });
  const numIn = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));
  const t = def.type;

  return (
    <details className="widget-form" open>
      <summary>{def.title || TYPES.find((x) => x.id === t)?.label}</summary>
      <div className="form-grid">
        <label><span>Tipo</span><select value={t} onChange={(e) => {
          const nt = e.target.value as WidgetType;
          set({ type: nt, field: undefined, ...(nt === "hist" || nt === "table" || nt === "map" || nt === "text" ? { agg: "count" as Agg, valueField: undefined } : {}), ...(nt === "text" ? { layer: "" } : {}) });
        }}>
            {TYPES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </label>
        <label><span>Titolo</span><input className="search" value={def.title} onChange={(e) => set({ title: e.target.value })} /></label>
        {usesLayer(t) && (
          <label><span>Layer</span><select value={def.layer} onChange={(e) => set({ layer: e.target.value, field: undefined, valueField: undefined, columns: undefined, sortField: undefined })}>
              <option value="">— scegli —</option>
              {products.filter((p) => p.vector !== false || p.name === def.layer || t === "map").map((p) => <option key={p.name} value={p.name}>{p.title} ({p.name})</option>)}
            </select>
          </label>
        )}
        {usesField(t) && (
          <label><span>{isDateField(t) ? "Campo data" : t === "hist" ? "Campo numerico" : "Raggruppa per"}</span>
            <select value={def.field ?? ""} onChange={(e) => set({ field: e.target.value || undefined })}>
              <option value="">— scegli —</option>
              {groupable.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.type})</option>)}
            </select>
          </label>
        )}
        {t === "line" && (
          <label><span>Periodo</span><select value={def.granularity ?? "month"} onChange={(e) => set({ granularity: e.target.value as WidgetDef["granularity"] })}>
              {GRANULARITIES.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
            </select>
          </label>
        )}
        {usesAgg(t) && (
          <label><span>Valore</span><select value={def.agg} onChange={(e) => set({ agg: e.target.value as Agg })}>
              {AGGS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </label>
        )}
        {usesAgg(t) && def.agg !== "count" && (
          <label><span>Campo del valore</span><select value={def.valueField ?? ""} onChange={(e) => set({ valueField: e.target.value || undefined })}>
              <option value="">— scegli —</option>
              {nums.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
            </select>
          </label>
        )}
        {t === "gauge" && (
          <>
            <label><span>Soglia di attenzione</span><input className="search" inputMode="decimal" value={def.warn ?? ""} onChange={(e) => set({ warn: numIn(e.target.value) })} /></label>
            <label><span>Soglia critica</span><input className="search" inputMode="decimal" value={def.crit ?? ""} onChange={(e) => set({ crit: numIn(e.target.value) })} /></label>
            <label><span>Direzione</span><select value={def.higherIsWorse === false ? "low" : "high"} onChange={(e) => set({ higherIsWorse: e.target.value === "low" ? false : undefined })}>
                <option value="high">più alto = peggio</option><option value="low">più basso = peggio</option>
              </select>
            </label>
            <label><span>Scala: minimo (facoltativo)</span><input className="search" inputMode="decimal" value={def.min ?? ""} onChange={(e) => set({ min: numIn(e.target.value) })} /></label>
            <label><span>Scala: massimo (facoltativo)</span><input className="search" inputMode="decimal" value={def.max ?? ""} onChange={(e) => set({ max: numIn(e.target.value) })} /></label>
          </>
        )}
        {t === "table" && (
          <>
            <label><span>Ordina per</span><select value={def.sortField ?? ""} onChange={(e) => set({ sortField: e.target.value || undefined })}>
                <option value="">(ordine del layer)</option>
                {fields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
              </select>
            </label>
            <label><span>Verso</span><select value={def.sortDesc ? "desc" : "asc"} onChange={(e) => set({ sortDesc: e.target.value === "desc" || undefined })}>
                <option value="asc">crescente</option><option value="desc">decrescente</option>
              </select>
            </label>
            <label><span>Righe (massimo {TABLE_MAX_ROWS})</span><input className="search" type="number" min={1} max={TABLE_MAX_ROWS} value={def.limit ?? 10} onChange={(e) => set({ limit: Math.min(TABLE_MAX_ROWS, Math.max(1, Number(e.target.value) || 10)) })} /></label>
          </>
        )}
        {usesLayer(t) && (
          <label><span>Filtro CQL (facoltativo)</span><input className="search" placeholder="es. kind = 'A'" value={def.cql ?? ""} onChange={(e) => set({ cql: e.target.value || undefined })} /></label>
        )}
        <label><span>Larghezza</span><select value={def.w} onChange={(e) => set({ w: Number(e.target.value) as 1 | 2 | 3 })}>
            <option value={1}>1 colonna</option><option value={2}>2 colonne</option><option value={3}>3 colonne</option>
          </select>
        </label>
      </div>
      {t === "table" && (
        <div className="wf-columns">
          <div className="section-title">Colonne</div>
          <div className="check-row">
            {fields.map((f) => (
              <label key={f.name} className="check"><input type="checkbox" checked={!!def.columns?.includes(f.name)} onChange={(e) => set({ columns: e.target.checked ? [...(def.columns ?? []), f.name] : (def.columns ?? []).filter((c) => c !== f.name) })} /> {f.name}</label>
            ))}
            {fields.length === 0 && <span className="muted">Scegli un layer vettoriale.</span>}
          </div>
        </div>
      )}
      {t === "text" && (
        <label className="wf-text"><span>Testo</span>
          <textarea className="search" rows={5} value={def.text ?? ""} aria-label="Testo del widget" onChange={(e) => set({ text: e.target.value })}
            placeholder={"## Titolo\nUn paragrafo con **grassetto**, *corsivo* e un [link](https://example.org).\n- un punto\n- un altro punto"} />
          <small className="muted">Titoli con #, elenchi con - o 1., **grassetto**, *corsivo*, `codice`, [testo](https://indirizzo). Niente HTML.</small>
        </label>
      )}
      {err && <div className="error">{err}</div>}
      <div className="btn-row">
        <button className="btn-sm" disabled={index === 0} onClick={() => onMove(-1)}>Su</button>
        <button className="btn-sm" disabled={index === count - 1} onClick={() => onMove(1)}>Giù</button>
        <button className="btn-sm danger" onClick={onRemove}>Rimuovi widget</button>
      </div>
    </details>
  );
}

/** Anteprima di un'importazione: cosa entra, cosa sostituisce, layer da rimappare, ruoli sconosciuti. */
function ImportPanel({
  items, warnings, existing, products, knownRoles, busy, onCancel, onImport, onEdit,
}: {
  items: DashboardDef[]; warnings: string[]; existing: DashboardDef[]; products: Product[]; knownRoles: string[]; busy: boolean;
  onCancel: () => void; onImport: (plan: ReturnType<typeof planImport>) => void; onEdit: (d: DashboardDef) => void;
}) {
  const [map, setMap] = useState<Record<string, string>>({});
  const [replace, setReplace] = useState<Set<string>>(new Set());
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const published = new Set(products.map((p) => p.name));
  const missing = missingLayers(items, published);
  const stillMissing = missing.filter((l) => !map[l]);
  const roles = unknownRoles(items, new Set(knownRoles));
  const existsTitle = (t: string) => existing.some((d) => d.title.trim().toLowerCase() === t.trim().toLowerCase());
  const plan = planImport(remapLayers(items, map), existing, replace, skip);
  const n = plan.insert.length + plan.update.length;
  const toggle = (set: Set<string>, v: string, put: (x: Set<string>) => void) => { const x = new Set(set); if (x.has(v)) x.delete(v); else x.add(v); put(x); };
  return (
    <section className="role-card import-panel" aria-label="Importazione">
      <header className="role-head"><h3>Importa dashboard</h3><span className="muted">{items.length} nel file</span></header>
      {warnings.map((w) => <div key={w} className="notice">{w}</div>)}
      <table className="import-table">
        <thead><tr><th>Importa</th><th>Dashboard</th><th>Widget</th><th>In questo ambiente</th></tr></thead>
        <tbody>
          {items.map((d, i) => (
            <tr key={`${i}|${d.title}`} data-title={d.title}>
              <td><input type="checkbox" aria-label={`Importa ${d.title}`} checked={!skip.has(d.title)} onChange={() => toggle(skip, d.title, setSkip)} /></td>
              <td><strong>{d.title}</strong>{d.roles.length > 0 && <small className="muted"> · {d.roles.join(", ")}</small>}</td>
              <td>{d.widgets.length}</td>
              <td>
                {existsTitle(d.title)
                  ? <label className="check"><input type="checkbox" checked={replace.has(d.title)} onChange={() => toggle(replace, d.title, setReplace)} /> Esiste già: sostituiscila (altrimenti se ne aggiunge un'altra)</label>
                  : <span className="muted">nuova</span>}
                {items.length === 1 && <button className="btn-sm" onClick={() => onEdit(remapLayers([d], map)[0])}>Apri nell'editor</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {missing.length > 0 && (
        <div>
          <div className="section-title">Layer non pubblicati in questo ambiente</div>
          <p className="muted">Scegli con quale layer sostituirli (per esempio lo stesso dato in un altro workspace). I widget su layer mancanti mostrerebbero un errore.</p>
          {missing.map((l) => (
            <label key={l} className="remap-row"><code>{l}</code> →
              <select aria-label={`Sostituisci ${l}`} value={map[l] ?? ""} onChange={(e) => setMap((m) => ({ ...m, [l]: e.target.value }))}>
                <option value="">(lascia com'è)</option>
                {products.filter((p) => p.vector !== false).map((p) => <option key={p.name} value={p.name}>{p.title} ({p.name})</option>)}
              </select>
            </label>
          ))}
        </div>
      )}
      {roles.length > 0 && <div className="notice">Ruoli non ancora usati in questo ambiente: {roles.join(", ")}. Restano assegnati: controlla che esistano in Keycloak.</div>}
      <div className="btn-row">
        <button className="btn-sm primary" disabled={busy || n === 0} onClick={() => onImport(plan)}>
          {n === 0 ? "Niente da importare" : `Importa ${n} ${n === 1 ? "dashboard" : "dashboard"}${plan.update.length ? ` (${plan.update.length} sostituite)` : ""}`}
        </button>
        <button className="btn-sm" disabled={busy} onClick={onCancel}>Annulla</button>
        {stillMissing.length > 0 && <span className="muted">{stillMissing.length} layer ancora mancanti</span>}
      </div>
    </section>
  );
}

/** Filtri globali della dashboard: periodo (con il campo data di ogni layer) e area. */
function FiltersForm({ filters, widgets, gs, kc, onChange }: { filters?: DashFilters; widgets: WidgetDef[]; gs: string; kc: Keycloak | null; onChange: (f?: DashFilters) => void }) {
  const layers = Array.from(new Set(widgets.filter((w) => w.type !== "text" && w.layer).map((w) => w.layer)));
  const [dates, setDates] = useState<Record<string, string[]>>({});
  useEffect(() => {
    let off = false;
    void Promise.all(layers.map((l) => describeLayer(gs, kc, l).then((s) => [l, s.fields.filter((f) => isDate(f.type)).map((f) => f.name)] as const, () => [l, []] as const)))
      .then((pairs) => { if (!off) setDates(Object.fromEntries(pairs)); });
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gs, kc, layers.join("|")]);
  const set = (f: DashFilters) => onChange(f.date || f.area ? f : undefined);
  const date = filters?.date;
  const enableDate = (on: boolean) => {
    if (!on) { set({ ...filters, date: undefined }); return; }
    const fields = Object.fromEntries(layers.map((l) => [l, dates[l]?.[0]]).filter(([, f]) => f)) as Record<string, string>;
    set({ ...filters, date: { fields, preset: "all" } });
  };
  return (
    <div className="filters-form">
      <div className="section-title">Filtri globali</div>
      <div className="muted">Chi guarda la dashboard li cambia in alto; valgono per tutti i widget (testo escluso).</div>
      <label className="check"><input type="checkbox" checked={!!date} onChange={(e) => enableDate(e.target.checked)} /> Periodo (date)</label>
      {date && (
        <div className="ff-date">
          <label><span>Periodo iniziale</span>
            <select value={date.preset ?? "all"} onChange={(e) => set({ ...filters, date: { ...date, preset: e.target.value as DatePreset } })}>
              {DATE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          {layers.map((l) => (
            <label key={l}><span>Campo data di <code>{l}</code></span>
              <select aria-label={`Campo data di ${l}`} value={date.fields[l] ?? ""} onChange={(e) => {
                const fields = { ...date.fields };
                if (e.target.value) fields[l] = e.target.value; else delete fields[l];
                set({ ...filters, date: { ...date, fields } });
              }}>
                <option value="">(non filtrare per data)</option>
                {(dates[l] ?? []).map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
          ))}
          {layers.length === 0 && <span className="muted">Aggiungi prima dei widget.</span>}
        </div>
      )}
      <label className="check"><input type="checkbox" checked={!!filters?.area} onChange={(e) => set({ ...filters, area: e.target.checked || undefined })} /> Area (riquadro scelto sulla mappa)</label>
    </div>
  );
}

/** Anteprima della dashboard in modifica, come la vedrebbe un ruolo (o l'amministratore). */
function Preview({ d, gs, kc, acc, rules, roles, roleViews, mapStart }: {
  d: DashboardDef; gs: string; kc: Keycloak | null; acc: AccessConfig; rules: RoleRule[]; roles: string[]; roleViews: RoleView[]; mapStart?: MapStart;
}) {
  const [role, setRole] = useState("");
  const perms = useMemo(() => computePermissions(role ? [role] : [acc.adminRole], rules, acc), [role, rules, acc]);
  const roleBbox = role ? startViewFor([role], roleViews)?.bbox : undefined;
  const notes = role ? previewNotes(d, role, perms, roleBbox) : [];
  // la barra dei filtri riparte quando cambiano ruolo o filtri
  const key = `${role}|${JSON.stringify(d.filters ?? null)}`;
  return (
    <section className="dash-preview" aria-label="Anteprima">
      <div className="section-title">Anteprima</div>
      <div className="preview-head">
        <label><span>Come la vede</span>
          <select aria-label="Anteprima come ruolo" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">{acc.adminRole} (tutto)</option>
            {roles.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <span className="muted">Dati letti con le tue credenziali; gli avvisi e «La mia area» seguono il ruolo scelto. «Apri sulla mappa» è spento in anteprima.</span>
      </div>
      {notes.length > 0 && (
        <ul className="preview-notes">
          {notes.map((n) => <li key={n.text} className={`pn-${n.level}`}><span aria-hidden="true">{n.level === "ok" ? "✓" : "!"}</span> {n.text}</li>)}
        </ul>
      )}
      <DashboardBody key={key} d={d} gs={gs} kc={kc} perms={perms} roleBbox={roleBbox} mapStart={mapStart} preview />
    </section>
  );
}

const when = (iso?: string) => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) ? new Date(t).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" }) : ""; };

export default function AdminDashboards({
  gs, kc, acc, rules, dashboards, drafts, draftsError = null, roleViews = [], mapStart, products, storeError, onChanged,
}: {
  gs: string; kc: Keycloak; acc: AccessConfig; rules: RoleRule[]; dashboards: DashboardDef[];
  /** undefined = bozze non disponibili (tabella mancante): si salva e si pubblica in un colpo solo, come prima */
  drafts?: DashboardDraft[]; draftsError?: string | null; roleViews?: RoleView[]; mapStart?: MapStart;
  products: Product[]; storeError: string | null; onChanged: () => Promise<void>;
}) {
  const useDrafts = !!drafts && !draftsError;
  const items = useMemo(() => mergeItems(dashboards, useDrafts ? drafts! : []), [dashboards, drafts, useDrafts]);
  const [sel, setSel] = useState<string>("new");   // chiave dell'elemento (fid della pubblicata o della bozza) oppure "new"
  const [form, setForm] = useState<DashboardDef>(blank());
  const [base, setBase] = useState<DashboardDef>(blank()); // contenuto all'apertura o all'ultimo salvataggio
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [importing, setImporting] = useState<{ items: DashboardDef[]; warnings: string[] } | null>(null);
  const roles = useMemo(() => roleList(acc, rules, dashboards, form.roles), [acc, rules, dashboards, form.roles]);
  const item = items.find((i) => i.key === sel);
  const published = item?.published;
  const draftRow = item?.draft;
  const dirty = !sameContent(form, base);

  const open = (content: DashboardDef, key: string) => { setSel(key); setForm(content); setBase(structuredClone(content)); };
  const pick = (key: string, keepMsg = false) => {
    if (!keepMsg) setMsg(null);
    const it = items.find((i) => i.key === key);
    open(it ? editorContent(it) : blank(), it ? key : "new");
  };
  const patch = (p: Partial<DashboardDef>) => setForm((d) => ({ ...d, ...p }));
  const setWidget = (i: number, w: WidgetDef) => patch({ widgets: form.widgets.map((x, k) => (k === i ? w : x)) });
  const move = (i: number, dir: -1 | 1) => { const a = [...form.widgets]; [a[i], a[i + dir]] = [a[i + dir], a[i]]; patch({ widgets: a }); };

  const problems = [
    !form.title.trim() && "Manca il titolo.",
    form.filters?.date && Object.keys(form.filters.date.fields).length === 0 && "Filtro per periodo: indica il campo data di almeno un layer.",
    form.widgets.length === 0 && "Aggiungi almeno un widget.",
    ...form.widgets.flatMap(widgetProblems),
  ].filter(Boolean) as string[];

  const run = async (fn: () => Promise<void>, ok: string, after?: () => void) => {
    setBusy(true); setMsg(null);
    try { await fn(); await onChanged(); setMsg({ ok: true, text: ok }); after?.(); } catch (e) { setMsg({ ok: false, text: `Operazione non riuscita: ${(e as Error).message}` }); } finally { setBusy(false); }
  };

  const saveDraft = () => {
    const content = structuredClone(form);
    let key = sel;
    void run(async () => {
      const fid = await saveDashboardDraft(gs, kc, acc, { fid: draftRow?.fid, dashboardId: dashId(published?.fid), def: content });
      if (!published) key = fid;
    }, published ? "Bozza salvata: chi usa la dashboard vede ancora la versione pubblicata." : "Bozza salvata: nessuno la vede finché non la pubblichi.", () => open(content, key || "new"));
  };
  const publish = () => {
    const content = structuredClone(form);
    let fid = published?.fid;
    const who = content.roles.length ? `la vedono ${content.roles.join(", ")}` : "nessun ruolo la vede ancora (solo gli amministratori)";
    void run(async () => {
      fid = await publishDashboard(gs, kc, acc, { ...content, fid: published?.fid }, draftRow?.fid);
    }, `Dashboard pubblicata: ${who}.`, () => open({ ...content, ...(fid ? { fid } : {}) }, fid || "new"));
  };
  const saveDirect = () => void run(() => saveDashboard(gs, kc, acc, form), "Dashboard salvata.", () => { if (sel === "new") pick("new", true); else setBase(structuredClone(form)); });
  const discard = () => {
    if (!draftRow || !published) return;
    const pub = editorContent({ key: published.fid!, published });
    void run(() => deleteDashboardDraft(gs, kc, acc, draftRow.fid), "Bozza scartata: torna la versione pubblicata.", () => open(pub, published.fid!));
  };
  const remove = () => {
    const what = published ? `la dashboard "${form.title}"${draftRow ? " e la sua bozza" : ""}` : `la bozza "${form.title}"`;
    if (!window.confirm(`Eliminare ${what}?`)) return;
    void run(() => (useDrafts ? deleteDashboardAndDraft(gs, kc, acc, published?.fid, draftRow?.fid) : deleteDashboard(gs, kc, acc, published!.fid!)),
      published ? "Dashboard eliminata." : "Bozza eliminata.", () => pick("new", true));
  };

  const exportList = (list: DashboardDef[]) =>
    saveBlob(new Blob([JSON.stringify(exportDashboards(list, window.location.host), null, 2)], { type: "application/json" }), exportName(list));
  const readFile = async (file: File) => {
    setMsg(null);
    try { setImporting(parseImport(await file.text(), uid)); }
    catch (e) { setImporting(null); setMsg({ ok: false, text: `Importazione non possibile: ${(e as Error).message}` }); }
  };
  const changes = published && draftRow ? draftChanges(published, draftRow.def) : [];

  return (
    <div className="page-inner wide">
      <h1>Dashboard per ruolo</h1>
      {storeError && <div className="error">{storeError}</div>}
      {draftsError && <div className="notice">{draftsError}</div>}
      <div className="btn-row dash-io">
        <button className="btn-sm" disabled={dashboards.length === 0} onClick={() => exportList(dashboards)}>Esporta tutte (JSON)</button>
        <label className="btn-sm file-btn">Importa da file…
          <input type="file" accept="application/json,.json" aria-label="Importa dashboard da un file JSON" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void readFile(f); }} />
        </label>
        <span className="muted">Per portare le dashboard da un ambiente all'altro (DEV, UAT, PROD). Si esportano e si importano le versioni pubblicate.</span>
      </div>
      {importing && (
        <ImportPanel
          items={importing.items} warnings={importing.warnings} existing={dashboards} products={products} knownRoles={roleList(acc, rules, dashboards)} busy={busy}
          onCancel={() => setImporting(null)}
          onEdit={(d) => { setImporting(null); setSel("new"); setForm({ ...d, fid: undefined }); setBase(blank()); setMsg({ ok: true, text: "Dashboard caricata nell'editor: controllala e salvala." }); }}
          onImport={(plan) => void run(async () => { await importDashboards(gs, kc, acc, plan); }, `Importate ${plan.insert.length + plan.update.length} dashboard.`, () => setImporting(null))}
        />
      )}
      <div className="dash-admin">
        <aside className="dash-list">
          <button className={`btn-sm${sel === "new" ? " primary" : ""}`} onClick={() => pick("new")}>+ Nuova dashboard</button>
          <ul className="plain">
            {items.map((it) => {
              const st = itemStatus(it);
              const d = it.draft?.def ?? it.published!;
              return (
                <li key={it.key}>
                  <button className={`dash-item${sel === it.key ? " on" : ""}`} onClick={() => pick(it.key)}>
                    <strong>{itemTitle(it) || "(senza titolo)"}</strong>
                    {useDrafts && <span className={`status-tag st-${st}`}>{STATUS_LABEL[st]}</span>}
                    <span className="muted">{d.roles.length ? d.roles.join(", ") : "nessun ruolo"}</span>
                  </button>
                </li>
              );
            })}
            {items.length === 0 && <li className="muted">Nessuna dashboard ancora.</li>}
          </ul>
        </aside>

        <div className="dash-editor">
          {useDrafts && item && (
            <div className={`draft-state st-${itemStatus(item)}`} role="note">
              {itemStatus(item) === "published" && <>Pubblicata{published?.updatedBy ? ` da ${published.updatedBy}` : ""}{published?.updatedAt ? ` il ${when(published.updatedAt)}` : ""}. Le modifiche si salvano in una bozza: chi usa la dashboard continua a vedere questa versione finché non pubblichi.</>}
              {itemStatus(item) === "changed" && <>Stai modificando la bozza{draftRow?.updatedBy ? ` di ${draftRow.updatedBy}` : ""}{draftRow?.updatedAt ? ` (${when(draftRow.updatedAt)})` : ""}. Chi usa la dashboard vede ancora la versione pubblicata.{changes.length > 0 && <> Differenze: {changes.join("; ")}.</>}</>}
              {itemStatus(item) === "draft" && <>Bozza mai pubblicata: la vedono solo gli amministratori.</>}
            </div>
          )}
          <div className="form-grid">
            <label><span>Titolo</span><input className="search" value={form.title} onChange={(e) => patch({ title: e.target.value })} /></label>
            <label><span>Descrizione</span><input className="search" value={form.description} onChange={(e) => patch({ description: e.target.value })} /></label>
          </div>
          <div className="section-title">Ruoli che la vedono</div>
          <div className="check-row">
            {roles.map((r) => (
              <label key={r} className="check"><input type="checkbox" checked={form.roles.includes(r)} onChange={() => patch({ roles: form.roles.includes(r) ? form.roles.filter((x) => x !== r) : [...form.roles, r] })} /> {r}</label>
            ))}
          </div>
          <div className="muted">{acc.adminRole} le vede tutte. Altri ruoli si aggiungono dalla pagina Ruoli e permessi.</div>

          <div className="section-title">Widget</div>
          {form.widgets.map((w, i) => (
            <WidgetForm key={w.id} def={w} products={products} gs={gs} kc={kc} index={i} count={form.widgets.length} onChange={(d) => setWidget(i, d)} onMove={(dir) => move(i, dir)} onRemove={() => patch({ widgets: form.widgets.filter((_, k) => k !== i) })} />
          ))}
          <div className="btn-row"><button className="btn-sm" onClick={() => patch({ widgets: [...form.widgets, newWidget(products.find((p) => p.vector !== false)?.name ?? "")] })}>+ Aggiungi widget</button></div>
          <FiltersForm filters={form.filters} widgets={form.widgets} gs={gs} kc={kc} onChange={(filters) => setForm((d) => { const { filters: _old, ...rest } = d; return filters ? { ...rest, filters } : rest; })} />

          {msg && <div className={msg.ok ? "ok" : "error"} role="status">{msg.text}</div>}
          {problems.length > 0 && <ul className="problems">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          {useDrafts && problems.length > 0 && form.title.trim() && <div className="muted">Puoi salvare la bozza anche incompleta; per pubblicarla risolvi i punti qui sopra.</div>}
          <div className="btn-row">
            {useDrafts ? (
              <>
                <button className="btn-sm" disabled={busy || !form.title.trim() || (!dirty && !!item)} onClick={saveDraft}>Salva bozza</button>
                <button className="btn-sm primary" disabled={busy || problems.length > 0 || (!dirty && itemStatus(item ?? { key: "" }) === "published")} onClick={publish}>Pubblica</button>
                {draftRow && published && <button className="btn-sm" disabled={busy} onClick={discard}>Scarta bozza</button>}
              </>
            ) : (
              <button className="btn-sm primary" disabled={busy || problems.length > 0} onClick={saveDirect}>Salva dashboard</button>
            )}
            {dirty && <span className="dirty-note" role="status">Modifiche non salvate</span>}
            {published && <button className="btn-sm" onClick={() => navigate(`/d/${dashId(published.fid)}`)}>{draftRow ? "Apri la versione pubblicata" : "Apri"}</button>}
            {item && <button className="btn-sm" disabled={busy} onClick={() => { setSel("new"); const c = duplicate(form, uid); setForm(c); setBase(blank()); setMsg({ ok: true, text: "Copia pronta: modificala e salvala." }); }}>Duplica</button>}
            {item && <button className="btn-sm" onClick={() => exportList([form])}>Esporta (JSON)</button>}
            {item && <button className="btn-sm danger" disabled={busy} onClick={remove}>Elimina</button>}
          </div>

          {form.widgets.length > 0 && <Preview d={form} gs={gs} kc={kc} acc={acc} rules={rules} roles={roles} roleViews={roleViews} mapStart={mapStart} />}
        </div>
      </div>
    </div>
  );
}
