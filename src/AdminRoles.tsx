import { lazy, Suspense, useMemo, useState } from "react";
import type Keycloak from "keycloak-js";
import type { AccessConfig } from "./config";
import type { Product } from "./capabilities";
import type { BasemapDef } from "./basemaps";
import { deleteRoleSettings, saveRoleSettings, type DashboardDef } from "./configStore";
import { DEFAULT_VIEWER_TOOLS, TOOLS, type RoleRule, type ToolId } from "./roles";
import { formatBbox, parseBbox, type Bbox, type RoleView } from "./roleView";

// la mini-mappa (maplibre) si carica solo quando serve
const BboxPicker = lazy(() => import("./BboxPicker"));
export interface MapStart { center: [number, number]; zoom: number; bounds?: number[] }

export const roleList = (acc: AccessConfig, rules: RoleRule[], dashboards: DashboardDef[], extra: string[] = []): string[] =>
  Array.from(new Set([acc.viewerRole, ...acc.knownRoles, ...rules.map((r) => r.role), ...dashboards.flatMap((d) => d.roles), ...extra]))
    .filter((r) => r && r !== acc.adminRole)
    .sort((a, b) => a.localeCompare(b));

const BBOX_LABELS = ["Ovest", "Sud", "Est", "Nord"];

/** Vista iniziale del ruolo: area di interesse (numeri o mini-mappa), sfondo e layer accesi all'apertura. */
function ViewEditor({
  bboxText, setBboxText, basemap, setBasemap, layers, setLayers, choices, basemaps, mapStart, disabled,
}: {
  bboxText: string[]; setBboxText: (b: string[]) => void; basemap: string; setBasemap: (b: string) => void;
  layers: string[]; setLayers: (l: string[]) => void; choices: Product[]; basemaps: BasemapDef[]; mapStart: MapStart; disabled: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState("");
  const current = parseBbox(bboxText.join(","));
  const shown = choices.filter((p) => !filter || `${p.title} ${p.name}`.toLowerCase().includes(filter.toLowerCase()));
  const toggle = (n: string) => setLayers(layers.includes(n) ? layers.filter((x) => x !== n) : [...layers, n]);
  return (
    <div className="role-view">
      <div className="section-title">Vista iniziale <small className="muted">quando la mappa si apre senza un link o una vista salvata; vuoto = impostazioni globali</small></div>
      <div className="role-view-grid">
        <div>
          <div className="rv-label">Area di interesse</div>
          <div className="bbox-inputs">
            {BBOX_LABELS.map((l, i) => (
              <label key={l}><span>{l}</span>
                <input className="search" inputMode="decimal" aria-label={`${l} (gradi)`} value={bboxText[i]} disabled={disabled}
                  onChange={(e) => { const b = [...bboxText]; b[i] = e.target.value.replace(",", "."); setBboxText(b); }} />
              </label>
            ))}
          </div>
          <div className="btn-row">
            <button type="button" className="btn-sm" disabled={disabled} onClick={() => setPicking((p) => !p)}>{picking ? "Chiudi la mappa" : "Scegli sulla mappa"}</button>
            {bboxText.some((x) => x.trim()) && <button type="button" className="btn-sm" disabled={disabled} onClick={() => setBboxText(["", "", "", ""])}>Togli l'area</button>}
          </div>
          {picking && (
            <Suspense fallback={<div className="muted">Caricamento della mappa…</div>}>
              <BboxPicker
                basemaps={basemaps} basemap={basemap || undefined} initial={current} start={mapStart}
                onPick={(b: Bbox) => { setBboxText(formatBbox(b).split(",")); setPicking(false); }}
                onCancel={() => setPicking(false)}
              />
            </Suspense>
          )}
        </div>
        <div>
          <div className="rv-label">Sfondo</div>
          <select className="rv-select" aria-label="Sfondo iniziale" value={basemap} disabled={disabled} onChange={(e) => setBasemap(e.target.value)}>
            <option value="">(predefinito)</option>
            {basemaps.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
            {basemap && !basemaps.some((b) => b.id === basemap) && <option value={basemap}>{basemap} (non più disponibile)</option>}
          </select>
        </div>
        <div>
          <div className="rv-label">Layer accesi {layers.length > 0 && <span className="count">{layers.length}</span>}</div>
          <input className="search" placeholder="Cerca un layer…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Cerca tra i layer da accendere" />
          <div className="check-list">
            {shown.map((p) => (
              <label key={p.name} className="check" title={p.name}>
                <input type="checkbox" checked={layers.includes(p.name)} disabled={disabled} onChange={() => toggle(p.name)} /> <span className="check-text">{p.title}<small className="muted">{p.name}</small></span>
              </label>
            ))}
            {shown.length === 0 && <div className="empty">Nessun layer visibile per questo ruolo.</div>}
          </div>
          {layers.length === 0 && <div className="muted">Nessuno scelto: si accendono quelli indicati nel catalogo.</div>}
        </div>
      </div>
    </div>
  );
}

function RuleRow({
  role, rule, view, products, dashboards, basemaps, mapStart, viewsDisabled, busy, onSave, onDelete, onViewAs,
}: {
  role: string; rule?: RoleRule; view?: RoleView; products: Product[]; dashboards: DashboardDef[]; basemaps: BasemapDef[]; mapStart: MapStart;
  viewsDisabled: boolean; busy: boolean;
  onSave: (r: RoleRule, v?: RoleView) => void; onDelete: (r?: RoleRule, v?: RoleView) => void; onViewAs?: () => void;
}) {
  const [all, setAll] = useState(rule?.layers.includes("*") ?? false);
  const [layers, setLayers] = useState<string[]>(rule?.layers.filter((l) => l !== "*") ?? []);
  const [tools, setTools] = useState<ToolId[]>(rule?.tools ?? DEFAULT_VIEWER_TOOLS);
  const [filter, setFilter] = useState("");
  const names = new Set(products.map((p) => p.name));
  const shown = products.filter((p) => !filter || p.title.toLowerCase().includes(filter.toLowerCase()) || p.name.toLowerCase().includes(filter.toLowerCase()));
  const stale = layers.filter((l) => !names.has(l)); // layer non più pubblicati
  const toggle = <T,>(list: T[], v: T, set: (x: T[]) => void) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const mine = dashboards.filter((d) => d.roles.includes(role));
  // vista iniziale
  const [bboxText, setBboxText] = useState<string[]>(() => (view?.bbox ? formatBbox(view.bbox).split(",") : ["", "", "", ""]));
  const [basemap, setBasemap] = useState(view?.basemap ?? "");
  const [viewLayers, setViewLayers] = useState<string[]>(view?.layers ?? []);
  const bboxFilled = bboxText.some((x) => x.trim());
  const bbox = parseBbox(bboxText.join(","));
  const bboxError = bboxFilled && !bbox ? "Area non valida: servono quattro numeri in gradi, con ovest < est e sud < nord." : null;
  const visibleToRole = all ? products : products.filter((p) => layers.includes(p.name));
  const hiddenStart = viewLayers.filter((n) => !visibleToRole.some((p) => p.name === n)); // layer da accendere che il ruolo non vede
  const nextView = (): RoleView | undefined =>
    viewsDisabled ? undefined : { ...(view ?? { role }), role, ...(bbox ? { bbox } : { bbox: undefined }), basemap, layers: viewLayers.filter((n) => !hiddenStart.includes(n)) };

  return (
    <section className="role-card" data-role={role}>
      <header className="role-head">
        <h3>{role}</h3>
        {!rule && <span className="chip">non salvata</span>}
        {rule?.updatedBy && <span className="muted">modificata da {rule.updatedBy}</span>}
        {onViewAs && <button className="btn-sm role-viewas" onClick={onViewAs} title="Usa l'applicazione con le regole salvate di questo ruolo">Visualizza come {role}</button>}
      </header>
      <div className="role-grid">
        <div>
          <div className="section-title">Layer visibili</div>
          <label className="check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Tutti i layer</label>
          {!all && (
            <>
              <input className="search" placeholder="Cerca un layer…" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <div className="check-list">
                {shown.map((p) => (
                  <label key={p.name} className="check" title={p.name}>
                    <input type="checkbox" checked={layers.includes(p.name)} onChange={() => toggle(layers, p.name, setLayers)} /> <span className="check-text">{p.title}<small className="muted">{p.name}</small></span>
                  </label>
                ))}
                {shown.length === 0 && <div className="empty">Nessun layer.</div>}
              </div>
              {stale.length > 0 && <div className="muted">Layer in regola ma non più pubblicati: {stale.join(", ")}</div>}
            </>
          )}
        </div>
        <div>
          <div className="section-title">Strumenti</div>
          {TOOLS.map((t) => (
            <label key={t.id} className="check">
              <input type="checkbox" checked={tools.includes(t.id)} onChange={() => toggle(tools, t.id, setTools)} /> <span className="check-text">{t.label}{t.hint && <small className="muted">{t.hint}</small>}</span>
            </label>
          ))}
        </div>
        <div>
          <div className="section-title">Dashboard assegnate</div>
          {mine.length === 0 ? <div className="muted">Nessuna. Si assegnano dalla pagina Dashboard.</div> : <ul className="plain">{mine.map((d) => <li key={d.fid}>{d.title}</li>)}</ul>}
        </div>
      </div>
      <ViewEditor
        bboxText={bboxText} setBboxText={setBboxText} basemap={basemap} setBasemap={setBasemap} layers={viewLayers} setLayers={setViewLayers}
        choices={visibleToRole} basemaps={basemaps} mapStart={mapStart} disabled={viewsDisabled}
      />
      {bboxError && <div className="error">{bboxError}</div>}
      {hiddenStart.length > 0 && <div className="muted">Non verranno accesi perché il ruolo non li vede: {hiddenStart.join(", ")}</div>}
      <div className="btn-row">
        <button className="btn-sm primary" disabled={busy || (!all && layers.length === 0) || !!bboxError} onClick={() => onSave({ ...(rule ?? { role }), role, layers: all ? ["*"] : layers, tools }, nextView())}>Salva regola</button>
        {(rule?.fid || view?.fid) && <button className="btn-sm danger" disabled={busy} onClick={() => onDelete(rule, view)}>Elimina regola</button>}
        {!all && layers.length === 0 && <span className="muted">Scegli almeno un layer o "Tutti".</span>}
      </div>
    </section>
  );
}

export default function AdminRoles({
  gs, kc, acc, rules, dashboards, products, storeError, onChanged, roleViews = [], roleViewsError = null, basemaps = [], mapStart = { center: [12.5, 42], zoom: 5 }, onViewAs,
}: {
  gs: string; kc: Keycloak; acc: AccessConfig; rules: RoleRule[]; dashboards: DashboardDef[]; products: Product[]; storeError: string | null; onChanged: () => Promise<void>;
  roleViews?: RoleView[]; roleViewsError?: string | null; basemaps?: BasemapDef[]; mapStart?: MapStart;
  /** «Visualizza come ruolo» (con le regole salvate) */
  onViewAs?: (role: string) => void;
}) {
  const [extra, setExtra] = useState<string[]>([]);
  const [newRole, setNewRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const roles = useMemo(() => roleList(acc, rules, dashboards, [...extra, ...roleViews.map((v) => v.role)]), [acc, rules, dashboards, extra, roleViews]);
  const byRole = new Map(rules.map((r) => [r.role, r]));
  const viewOf = new Map(roleViews.map((v) => [v.role, v]));

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); await onChanged(); setMsg({ ok: true, text: ok }); } catch (e) { setMsg({ ok: false, text: `Operazione non riuscita: ${(e as Error).message}` }); } finally { setBusy(false); }
  };

  return (
    <div className="page-inner">
      <h1>Ruoli e permessi</h1>
      <p className="muted">
        Per ogni ruolo Keycloak scegli quali layer e strumenti vede nella mappa. I ruoli vengono creati e assegnati agli utenti in Keycloak; qui li puoi solo mappare.
        Il ruolo <strong>{acc.adminRole}</strong> (admin) vede sempre tutto ed è definito dalla configurazione, non da questa pagina.
      </p>
      {storeError && <div className="error">{storeError}</div>}
      {!storeError && rules.length === 0 && (
        <div className="notice">Nessuna regola salvata: il ruolo <strong>{acc.viewerRole}</strong> vede tutti i layer in sola lettura. Appena salvi la prima regola, solo i ruoli che ne hanno una avranno accesso.</div>
      )}
      {roleViewsError && <div className="notice">{roleViewsError}</div>}
      {msg && <div className={msg.ok ? "ok" : "error"} role="status">{msg.text}</div>}

      <div className="btn-row add-role">
        <input className="search" list="known-roles" placeholder="Nome del ruolo Keycloak da aggiungere" value={newRole} onChange={(e) => setNewRole(e.target.value)} />
        <datalist id="known-roles">{acc.knownRoles.map((r) => <option key={r} value={r} />)}</datalist>
        <button className="btn-sm" disabled={!newRole.trim() || newRole.trim() === acc.adminRole} onClick={() => { setExtra((x) => [...x, newRole.trim()]); setNewRole(""); }}>Aggiungi ruolo</button>
      </div>

      <section className="role-card locked">
        <header className="role-head"><h3>{acc.adminRole}</h3><span className="chip">admin</span></header>
        <div className="muted">Accesso completo e pagine di amministrazione. Non modificabile da qui.</div>
      </section>

      {roles.map((r) => (
        <RuleRow
          key={r + JSON.stringify(byRole.get(r) ?? null) + JSON.stringify(viewOf.get(r) ?? null)}
          role={r}
          rule={byRole.get(r)}
          view={viewOf.get(r)}
          products={products}
          dashboards={dashboards}
          basemaps={basemaps}
          mapStart={mapStart}
          viewsDisabled={!!roleViewsError}
          busy={busy}
          onViewAs={onViewAs ? () => onViewAs(r) : undefined}
          onSave={(rule, view) => void run(() => saveRoleSettings(gs, kc, acc, rule, view), `Regola di ${r} salvata.`)}
          onDelete={(rule, view) => { if (window.confirm(`Eliminare la regola del ruolo ${r}? Il ruolo perderà l'accesso (se esistono altre regole).`)) void run(() => deleteRoleSettings(gs, kc, acc, rule?.fid, view?.fid), `Regola di ${r} eliminata.`); }}
        />
      ))}
    </div>
  );
}
