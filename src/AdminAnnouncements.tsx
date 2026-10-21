import { useState } from "react";
import type Keycloak from "keycloak-js";
import type { AccessConfig } from "./config";
import {
  LEVELS, blankAnnouncement, fromLocalInput, phaseOf, toLocalInput, validateAnnouncement, type Announcement, type Level, type Phase,
} from "./announcements";
import AnnouncementBar from "./AnnouncementBar";
import { deleteAnnouncement, saveAnnouncement } from "./configStore";

const PHASE: Record<Phase, string> = { off: "spento", scheduled: "programmato", live: "in corso", ended: "scaduto" };
const fmt = (iso: string) => (iso ? new Date(iso).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" }) : "");

/** Pagina admin: avvisi in testa all'applicazione, per periodo e per ruolo. */
export default function AdminAnnouncements({
  gs, kc, acc, items, tableError, knownRoles, onChanged,
}: {
  gs: string; kc: Keycloak; acc: AccessConfig; items: Announcement[]; tableError: string | null; knownRoles: string[]; onChanged: () => Promise<void>;
}) {
  const [draft, setDraftRaw] = useState<Announcement | null>(null);
  const [targeted, setTargeted] = useState(false); // solo per alcuni ruoli
  const setDraft = (d: Announcement | null) => { setDraftRaw(d); setTargeted(!!d && d.roles.length > 0); };
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const now = Date.now();
  const errors = draft ? [...validateAnnouncement(draft), ...(targeted && draft.roles.length === 0 ? ["Scegli almeno un ruolo, oppure «Tutti»."] : [])] : [];
  const set = (p: Partial<Announcement>) => setDraftRaw((d) => (d ? { ...d, ...p } : d));
  const roles = Array.from(new Set([acc.adminRole, ...knownRoles, ...(draft?.roles ?? [])])).sort((a, b) => a.localeCompare(b));

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); await onChanged(); setMsg({ ok: true, text: ok }); setDraft(null); }
    catch (e) { setMsg({ ok: false, text: `Operazione non riuscita: ${(e as Error).message}` }); }
    finally { setBusy(false); }
  };

  return (
    <div className="page-inner">
      <h1>Avvisi</h1>
      <p className="muted">
        Messaggi in testa all'applicazione per tutti o per alcuni ruoli, in un periodo: novità, problemi noti, manutenzioni programmate.
        Chi ha la pagina aperta li riceve entro 5 minuti. Gli avvisi di manutenzione non si possono chiudere.
      </p>
      {tableError && <div className="error">{tableError}</div>}
      {msg && <div className={msg.ok ? "ok" : "error"} role="status">{msg.text}</div>}
      <div className="btn-row">
        <button className="btn-sm primary" disabled={!!tableError || busy} onClick={() => { setDraft(blankAnnouncement()); setMsg(null); }}>Nuovo avviso</button>
      </div>

      {draft && (
        <section className="role-card ann-editor" aria-label={draft.fid ? "Modifica avviso" : "Nuovo avviso"}>
          <header className="role-head"><h3>{draft.fid ? "Modifica avviso" : "Nuovo avviso"}</h3></header>
          <label className="ann-field"><span>Testo</span>
            <textarea className="search" rows={3} maxLength={1000} value={draft.message} onChange={(e) => set({ message: e.target.value })} placeholder="Es. Giovedì dalle 18 alle 20 il servizio non sarà disponibile per manutenzione." />
          </label>
          <div className="ann-grid">
            <label className="ann-field"><span>Tipo</span>
              <select value={draft.level} onChange={(e) => set({ level: e.target.value as Level })}>
                {LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </label>
            <label className="ann-field"><span>Dal (vuoto = subito)</span>
              <input className="search" type="datetime-local" value={toLocalInput(draft.startsAt)} onChange={(e) => set({ startsAt: fromLocalInput(e.target.value) })} />
            </label>
            <label className="ann-field"><span>Al (vuoto = finché non lo spegni)</span>
              <input className="search" type="datetime-local" value={toLocalInput(draft.endsAt)} onChange={(e) => set({ endsAt: fromLocalInput(e.target.value) })} />
            </label>
          </div>
          <div>
            <div className="section-title">Per chi</div>
            <div className="check-row">
              <label className="check"><input type="checkbox" checked={!targeted} onChange={(e) => { setTargeted(!e.target.checked); set({ roles: e.target.checked ? [] : [acc.viewerRole] }); }} /> Tutti</label>
              {targeted && roles.map((r) => (
                <label key={r} className="check"><input type="checkbox" checked={draft.roles.includes(r)} onChange={(e) => set({ roles: e.target.checked ? [...draft.roles, r] : draft.roles.filter((x) => x !== r) })} /> {r}</label>
              ))}
            </div>
          </div>
          <div className="check-row">
            <label className="check"><input type="checkbox" checked={draft.active} onChange={(e) => set({ active: e.target.checked })} /> Attivo</label>
            <label className="check"><input type="checkbox" checked={draft.level !== "maintenance" && draft.dismissible} disabled={draft.level === "maintenance"} onChange={(e) => set({ dismissible: e.target.checked })} /> L'utente lo può chiudere</label>
          </div>
          {draft.message.trim() && (
            <div>
              <div className="section-title">Anteprima</div>
              <AnnouncementBar items={[{ ...draft, fid: "anteprima" }]} onDismiss={() => {}} />
            </div>
          )}
          {errors.map((e) => <div key={e} className="error">{e}</div>)}
          <div className="btn-row">
            <button className="btn-sm primary" disabled={busy || errors.length > 0}
              onClick={() => void run(() => saveAnnouncement(gs, kc, acc, draft), "Avviso salvato.")}>Salva avviso</button>
            <button className="btn-sm" disabled={busy} onClick={() => setDraft(null)}>Annulla</button>
          </div>
        </section>
      )}

      <div className="ann-list">
        {items.length === 0 && !tableError && <div className="empty">Nessun avviso.</div>}
        {items.map((a) => {
          const ph = phaseOf(a, now);
          return (
            <div key={a.fid} className={`ann-row phase-${ph}`} data-fid={a.fid}>
              <span className={`tag ${ph === "live" ? "on" : ph === "scheduled" ? "new" : ""}`}>{PHASE[ph]}</span>
              <span className={`tag lvl-${a.level}`}>{LEVELS.find((l) => l.id === a.level)?.label}</span>
              <span className="ann-row-text">
                {a.message}
                <small className="muted">
                  {a.startsAt || a.endsAt ? `${a.startsAt ? `dal ${fmt(a.startsAt)}` : "da subito"}${a.endsAt ? ` al ${fmt(a.endsAt)}` : ""}` : "senza scadenza"}
                  {" · "}{a.roles.length ? a.roles.join(", ") : "tutti"}
                  {a.updatedBy ? ` · ${a.updatedBy}` : ""}
                </small>
              </span>
              <button className="btn-sm" disabled={busy} onClick={() => { setDraft({ ...a }); setMsg(null); }}>Modifica</button>
              <button className="btn-sm" disabled={busy} onClick={() => void run(() => saveAnnouncement(gs, kc, acc, { ...a, active: !a.active }), a.active ? "Avviso spento." : "Avviso acceso.")}>{a.active ? "Spegni" : "Accendi"}</button>
              <button className="btn-sm danger" disabled={busy} onClick={() => { if (window.confirm("Eliminare l'avviso?")) void run(() => deleteAnnouncement(gs, kc, acc, a.fid!), "Avviso eliminato."); }}>Elimina</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
