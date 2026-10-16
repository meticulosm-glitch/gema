import { useMemo, useState } from "react";
import type Keycloak from "keycloak-js";
import type { AccessConfig } from "./config";
import type { Product } from "./capabilities";
import { deleteRule, saveRule, type DashboardDef } from "./configStore";
import { DEFAULT_VIEWER_TOOLS, TOOLS, type RoleRule, type ToolId } from "./roles";

export const roleList = (acc: AccessConfig, rules: RoleRule[], dashboards: DashboardDef[], extra: string[] = []) =>
  Array.from(new Set([acc.viewerRole, ...acc.knownRoles, ...rules.map((r) => r.role), ...dashboards.flatMap((d) => d.roles), ...extra]))
    .filter((r) => r && r !== acc.adminRole)
    .sort((a, b) => a.localeCompare(b));

function RuleRow({
  role, rule, products, dashboards, busy, onSave, onDelete,
}: {
  role: string; rule?: RoleRule; products: Product[]; dashboards: DashboardDef[]; busy: boolean;
  onSave: (r: RoleRule) => void; onDelete: (r: RoleRule) => void;
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

  return (
    <section className="role-card" data-role={role}>
      <header className="role-head">
        <h3>{role}</h3>
        {!rule && <span className="chip">non salvata</span>}
        {rule?.updatedBy && <span className="muted">modificata da {rule.updatedBy}</span>}
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
      <div className="btn-row">
        <button className="btn-sm primary" disabled={busy || (!all && layers.length === 0)} onClick={() => onSave({ ...(rule ?? { role }), role, layers: all ? ["*"] : layers, tools })}>Salva regola</button>
        {rule?.fid && <button className="btn-sm danger" disabled={busy} onClick={() => onDelete(rule)}>Elimina regola</button>}
        {!all && layers.length === 0 && <span className="muted">Scegli almeno un layer o "Tutti".</span>}
      </div>
    </section>
  );
}

export default function AdminRoles({
  gs, kc, acc, rules, dashboards, products, storeError, onChanged,
}: {
  gs: string; kc: Keycloak; acc: AccessConfig; rules: RoleRule[]; dashboards: DashboardDef[]; products: Product[]; storeError: string | null; onChanged: () => Promise<void>;
}) {
  const [extra, setExtra] = useState<string[]>([]);
  const [newRole, setNewRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const roles = useMemo(() => roleList(acc, rules, dashboards, extra), [acc, rules, dashboards, extra]);
  const byRole = new Map(rules.map((r) => [r.role, r]));

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
          key={r + JSON.stringify(byRole.get(r) ?? null)}
          role={r}
          rule={byRole.get(r)}
          products={products}
          dashboards={dashboards}
          busy={busy}
          onSave={(rule) => void run(() => saveRule(gs, kc, acc, rule), `Regola di ${r} salvata.`)}
          onDelete={(rule) => { if (window.confirm(`Eliminare la regola del ruolo ${r}? Il ruolo perderà l'accesso (se esistono altre regole).`)) void run(() => deleteRule(gs, kc, acc, rule.fid!), `Regola di ${r} eliminata.`); }}
        />
      ))}
    </div>
  );
}
