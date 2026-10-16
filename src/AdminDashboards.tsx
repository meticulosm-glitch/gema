import { useEffect, useMemo, useState } from "react";
import type Keycloak from "keycloak-js";
import type { AccessConfig } from "./config";
import type { Product } from "./capabilities";
import { describeLayer, type Schema } from "./api";
import { deleteDashboard, saveDashboard, type Agg, type DashboardDef, type WidgetDef, type WidgetType } from "./configStore";
import { roleList } from "./AdminRoles";
import type { RoleRule } from "./roles";
import { WidgetCard, isDate, isNum } from "./Widgets";
import { navigate } from "./router";

const TYPES: { id: WidgetType; label: string }[] = [
  { id: "kpi", label: "KPI (numero)" }, { id: "bar", label: "Barre per categoria" }, { id: "hist", label: "Istogramma (campo numerico)" }, { id: "time", label: "Serie per mese (campo data)" },
];
const AGGS: { id: Agg; label: string }[] = [
  { id: "count", label: "Numero di oggetti" }, { id: "sum", label: "Somma" }, { id: "avg", label: "Media" }, { id: "min", label: "Minimo" }, { id: "max", label: "Massimo" },
];
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
  const groupable = def.type === "hist" ? nums : def.type === "time" ? fields.filter((f) => isDate(f.type)) : fields;
  const set = (p: Partial<WidgetDef>) => onChange({ ...def, ...p });
  const needsField = def.type !== "kpi";
  const needsValue = def.agg !== "count";

  return (
    <details className="widget-form" open>
      <summary>{def.title || TYPES.find((t) => t.id === def.type)?.label}</summary>
      <div className="form-grid">
        <label><span>Tipo</span><select value={def.type} onChange={(e) => set({ type: e.target.value as WidgetType, field: undefined, ...(e.target.value === "hist" ? { agg: "count" as Agg, valueField: undefined } : {}) })}>
            {TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>
        <label><span>Titolo</span><input className="search" value={def.title} onChange={(e) => set({ title: e.target.value })} /></label>
        <label><span>Layer</span><select value={def.layer} onChange={(e) => set({ layer: e.target.value, field: undefined, valueField: undefined })}>
            <option value="">— scegli —</option>
            {products.filter((p) => p.vector !== false || p.name === def.layer).map((p) => <option key={p.name} value={p.name}>{p.title} ({p.name})</option>)}
          </select>
        </label>
        {needsField && (
          <label><span>{def.type === "time" ? "Campo data" : def.type === "hist" ? "Campo numerico" : "Raggruppa per"}</span>
            <select value={def.field ?? ""} onChange={(e) => set({ field: e.target.value || undefined })}>
              <option value="">— scegli —</option>
              {groupable.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.type})</option>)}
            </select>
          </label>
        )}
        {def.type !== "hist" && (
          <label><span>Valore</span><select value={def.agg} onChange={(e) => set({ agg: e.target.value as Agg })}>
              {AGGS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </label>
        )}
        {needsValue && def.type !== "hist" && (
          <label><span>Campo del valore</span><select value={def.valueField ?? ""} onChange={(e) => set({ valueField: e.target.value || undefined })}>
              <option value="">— scegli —</option>
              {nums.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
            </select>
          </label>
        )}
        <label><span>Filtro CQL (facoltativo)</span><input className="search" placeholder="es. kind = 'A'" value={def.cql ?? ""} onChange={(e) => set({ cql: e.target.value || undefined })} /></label>
        <label><span>Larghezza</span><select value={def.w} onChange={(e) => set({ w: Number(e.target.value) as 1 | 2 | 3 })}>
            <option value={1}>1 colonna</option><option value={2}>2 colonne</option><option value={3}>3 colonne</option>
          </select>
        </label>
      </div>
      {err && <div className="error">{err}</div>}
      <div className="btn-row">
        <button className="btn-sm" disabled={index === 0} onClick={() => onMove(-1)}>Su</button>
        <button className="btn-sm" disabled={index === count - 1} onClick={() => onMove(1)}>Giù</button>
        <button className="btn-sm danger" onClick={onRemove}>Rimuovi widget</button>
      </div>
    </details>
  );
}

export default function AdminDashboards({
  gs, kc, acc, rules, dashboards, products, storeError, onChanged,
}: {
  gs: string; kc: Keycloak; acc: AccessConfig; rules: RoleRule[]; dashboards: DashboardDef[]; products: Product[]; storeError: string | null; onChanged: () => Promise<void>;
}) {
  const [sel, setSel] = useState<string>("new");   // fid oppure "new"
  const [draft, setDraft] = useState<DashboardDef>(blank());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const roles = useMemo(() => roleList(acc, rules, dashboards, draft.roles), [acc, rules, dashboards, draft.roles]);

  const pick = (fid: string, keepMsg = false) => {
    setSel(fid); if (!keepMsg) setMsg(null);
    setDraft(fid === "new" ? blank() : structuredClone(dashboards.find((d) => d.fid === fid) ?? blank()));
  };
  const patch = (p: Partial<DashboardDef>) => setDraft((d) => ({ ...d, ...p }));
  const setWidget = (i: number, w: WidgetDef) => patch({ widgets: draft.widgets.map((x, k) => (k === i ? w : x)) });
  const move = (i: number, dir: -1 | 1) => { const a = [...draft.widgets]; [a[i], a[i + dir]] = [a[i + dir], a[i]]; patch({ widgets: a }); };

  const problems = [
    !draft.title.trim() && "Manca il titolo.",
    draft.widgets.length === 0 && "Aggiungi almeno un widget.",
    draft.widgets.some((w) => !w.layer) && "Ogni widget ha bisogno di un layer.",
    draft.widgets.some((w) => w.type !== "kpi" && !w.field) && "Barre, istogrammi e serie hanno bisogno di un campo.",
    draft.widgets.some((w) => w.type !== "hist" && w.agg !== "count" && !w.valueField) && "Somma, media, minimo e massimo hanno bisogno di un campo del valore.",
  ].filter(Boolean) as string[];

  const run = async (fn: () => Promise<void>, ok: string, after?: () => void) => {
    setBusy(true); setMsg(null);
    try { await fn(); await onChanged(); setMsg({ ok: true, text: ok }); after?.(); } catch (e) { setMsg({ ok: false, text: `Operazione non riuscita: ${(e as Error).message}` }); } finally { setBusy(false); }
  };

  return (
    <div className="page-inner wide">
      <h1>Dashboard per ruolo</h1>
      {storeError && <div className="error">{storeError}</div>}
      <div className="dash-admin">
        <aside className="dash-list">
          <button className={`btn-sm${sel === "new" ? " primary" : ""}`} onClick={() => pick("new")}>+ Nuova dashboard</button>
          <ul className="plain">
            {dashboards.map((d) => (
              <li key={d.fid}>
                <button className={`dash-item${sel === d.fid ? " on" : ""}`} onClick={() => pick(d.fid!)}>
                  <strong>{d.title}</strong>
                  <span className="muted">{d.roles.length ? d.roles.join(", ") : "nessun ruolo"}</span>
                </button>
              </li>
            ))}
            {dashboards.length === 0 && <li className="muted">Nessuna dashboard ancora.</li>}
          </ul>
        </aside>

        <div className="dash-editor">
          <div className="form-grid">
            <label><span>Titolo</span><input className="search" value={draft.title} onChange={(e) => patch({ title: e.target.value })} /></label>
            <label><span>Descrizione</span><input className="search" value={draft.description} onChange={(e) => patch({ description: e.target.value })} /></label>
          </div>
          <div className="section-title">Ruoli che la vedono</div>
          <div className="check-row">
            {roles.map((r) => (
              <label key={r} className="check"><input type="checkbox" checked={draft.roles.includes(r)} onChange={() => patch({ roles: draft.roles.includes(r) ? draft.roles.filter((x) => x !== r) : [...draft.roles, r] })} /> {r}</label>
            ))}
          </div>
          <div className="muted">{acc.adminRole} le vede tutte. Altri ruoli si aggiungono dalla pagina Ruoli e permessi.</div>

          <div className="section-title">Widget</div>
          {draft.widgets.map((w, i) => (
            <WidgetForm key={w.id} def={w} products={products} gs={gs} kc={kc} index={i} count={draft.widgets.length} onChange={(d) => setWidget(i, d)} onMove={(dir) => move(i, dir)} onRemove={() => patch({ widgets: draft.widgets.filter((_, k) => k !== i) })} />
          ))}
          <div className="btn-row"><button className="btn-sm" onClick={() => patch({ widgets: [...draft.widgets, newWidget(products.find((p) => p.vector !== false)?.name ?? "")] })}>+ Aggiungi widget</button></div>

          {msg && <div className={msg.ok ? "ok" : "error"} role="status">{msg.text}</div>}
          {problems.length > 0 && <ul className="problems">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          <div className="btn-row">
            <button className="btn-sm primary" disabled={busy || problems.length > 0} onClick={() => void run(() => saveDashboard(gs, kc, acc, draft), "Dashboard salvata.", () => { if (sel === "new") pick("new", true); })}>Salva dashboard</button>
            {draft.fid && <button className="btn-sm" onClick={() => navigate(`/d/${draft.fid!.split(".").pop()}`)}>Apri</button>}
            {draft.fid && <button className="btn-sm danger" disabled={busy} onClick={() => { if (window.confirm(`Eliminare la dashboard "${draft.title}"?`)) void run(() => deleteDashboard(gs, kc, acc, draft.fid!), "Dashboard eliminata.", () => pick("new")); }}>Elimina</button>}
          </div>

          {draft.widgets.length > 0 && (
            <>
              <div className="section-title">Anteprima</div>
              <div className="dash-grid">
                {draft.widgets.map((w) => <WidgetCard key={w.id} def={w} gs={gs} kc={kc} canOpen={false} onOpenMap={() => {}} />)}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
