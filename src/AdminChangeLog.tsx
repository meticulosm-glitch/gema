import { useCallback, useEffect, useRef, useState } from "react";
import type Keycloak from "keycloak-js";
import type { AccessConfig } from "./config";
import { isMissingTable } from "./configStore";
import {
  LOGGED_TABLES, OP_LABEL, TABLE_LABEL, changedFields, entryName, isCurrent, loadChangeLog, restoreVersion, type ChangeEntry, type LogQuery,
} from "./changeLog";

const day = (d: Date) => d.toISOString().slice(0, 10);
const defaultQuery = (now = new Date()): LogQuery => ({ from: day(new Date(now.getTime() - 29 * 86_400_000)), to: day(now) });
const when = (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "medium" }) : iso; };

/** Valore leggibile: i JSON (elenchi di layer, widget…) indentati, i testi lunghi interi ma in un riquadro che scorre. */
function Value({ v }: { v: unknown }) {
  if (v === undefined) return <span className="muted">—</span>;
  if (v === null || v === "") return <span className="muted">(vuoto)</span>;
  let text = typeof v === "object" ? JSON.stringify(v, null, 1) : String(v);
  if (typeof v === "string" && /^[[{]/.test(v.trim())) { try { text = JSON.stringify(JSON.parse(v), null, 1); } catch { /* non è JSON */ } }
  return <code className="cl-value">{text}</code>;
}

/** Admin → Registro modifiche: chi ha cambiato cosa nelle tabelle di configurazione, e ritorno a una versione. */
export default function AdminChangeLog({ gs, kc, acc, onChanged }: { gs: string; kc: Keycloak; acc: AccessConfig; onChanged: () => Promise<void> }) {
  const [query, setQuery] = useState<LogQuery>(() => defaultQuery());
  const [draft, setDraft] = useState<LogQuery>(query);
  const [entries, setEntries] = useState<ChangeEntry[]>([]);
  const [capped, setCapped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const gen = useRef(0);

  const load = useCallback(async (qr: LogQuery) => {
    const id = ++gen.current;
    setLoading(true);
    try {
      const r = await loadChangeLog(gs, kc, acc, qr);
      if (gen.current !== id) return;
      setEntries(r.entries); setCapped(r.capped); setError(null);
    } catch (e) {
      if (gen.current !== id) return;
      setEntries([]);
      setError(isMissingTable(e)
        ? `Registro non disponibile: in GeoServer deve esistere il layer ${acc.workspace}:change_log (riesegui il Job di configurazione, che crea anche i trigger).`
        : `Impossibile leggere il registro: ${(e as Error).message}`);
    } finally { if (gen.current === id) setLoading(false); }
  }, [gs, kc, acc]);
  useEffect(() => { void load(query); }, [load, query]);

  const apply = (qr: LogQuery) => { setDraft(qr); setQuery(qr); setMsg(null); };
  // "versione attuale" si può dire solo se l'elenco non nasconde modifiche più recenti della stessa riga
  const currentKnown = !query.user?.trim() && !query.text?.trim() && (!query.to || query.to >= day(new Date()));
  const history = (e: ChangeEntry) => apply({ table: e.table, rowId: e.rowId ?? undefined });
  const restore = async (e: ChangeEntry) => {
    const what = `${TABLE_LABEL[e.table] ?? e.table} · ${entryName(e)}`;
    const verb = e.op === "DELETE" ? "Ripristinare l'elemento eliminato" : "Riportare l'elemento a questa versione";
    if (!window.confirm(`${verb}?\n${what}\nversione del ${when(e.changedAt)}${e.changedBy ? ` (${e.changedBy})` : ""}`)) return;
    setBusy(true); setMsg(null);
    try {
      const how = await restoreVersion(gs, kc, acc, e);
      await onChanged();
      setMsg({ ok: true, text: how === "inserted" ? `Ripristinato: ${what} (ricreato come elemento nuovo).` : how === "unchanged" ? `${what}: è già com'era in questa versione, nulla da cambiare.` : `Riportato alla versione del ${when(e.changedAt)}: ${what}.` });
      await load(query);
    } catch (err) {
      setMsg({ ok: false, text: `Ripristino non riuscito: ${(err as Error).message}` });
    } finally { setBusy(false); }
  };

  return (
    <div className="page-inner wide">
      <h1>Registro modifiche</h1>
      <p className="muted">Ogni modifica a regole, dashboard, catalogo, viste iniziali, moduli e avvisi, registrata dal database. Le viste salvate dagli utenti e le bozze non sono incluse.</p>
      <form className="cl-filters" role="search" aria-label="Filtri del registro" onSubmit={(ev) => { ev.preventDefault(); apply({ ...draft }); }}>
        <label><span>Cosa</span>
          <select value={draft.table ?? ""} onChange={(e) => setDraft({ ...draft, table: e.target.value || undefined, rowId: undefined })}>
            <option value="">Tutto</option>
            {LOGGED_TABLES.map((t) => <option key={t} value={t}>{TABLE_LABEL[t]}</option>)}
          </select>
        </label>
        <label><span>Utente</span><input className="search" value={draft.user ?? ""} onChange={(e) => setDraft({ ...draft, user: e.target.value })} placeholder="nome utente" /></label>
        <label><span>Dal</span><input type="date" value={draft.from ?? ""} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></label>
        <label><span>Al</span><input type="date" value={draft.to ?? ""} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></label>
        <label className="cl-text"><span>Cerca</span><input className="search" value={draft.text ?? ""} onChange={(e) => setDraft({ ...draft, text: e.target.value })} placeholder="ruolo, titolo, layer, testo…" /></label>
        <div className="btn-row">
          <button className="btn-sm primary" type="submit">Cerca</button>
          <button className="btn-sm" type="button" onClick={() => apply(defaultQuery())}>Ultimi 30 giorni</button>
        </div>
      </form>
      {query.rowId != null && (
        <div className="notice cl-history">
          Cronologia di un solo elemento ({TABLE_LABEL[query.table ?? ""] ?? query.table} #{query.rowId}).{" "}
          <button className="btn-link" onClick={() => apply({ ...defaultQuery(), table: query.table })}>Mostra tutto</button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {msg && <div className={msg.ok ? "ok" : "error"} role="status">{msg.text}</div>}
      <div className="cl-count muted" aria-live="polite">
        {loading ? "Caricamento…" : error ? "" : entries.length === 0 ? "Nessuna modifica con questi filtri." : `${entries.length} modifiche${capped ? " (le più recenti: restringi i filtri per vedere le altre)" : ""}.`}
      </div>
      <ul className="cl-list">
        {entries.map((e) => {
          const fields = changedFields(e);
          const current = currentKnown && isCurrent(e, entries);
          return (
            <li key={e.fid} className={`cl-entry op-${e.op.toLowerCase()}`} data-fid={e.fid}>
              <details>
                <summary>
                  <span className="cl-when">{when(e.changedAt)}</span>
                  <span className="cl-op">{OP_LABEL[e.op]}</span>
                  <span className="cl-what"><span className="muted">{TABLE_LABEL[e.table] ?? e.table}</span> <strong>{entryName(e)}</strong></span>
                  <span className="cl-who">{e.changedBy || <span className="muted">(utente sconosciuto)</span>}</span>
                  {current && <span className="chip">versione attuale</span>}
                  {e.op === "UPDATE" && <span className="cl-fields muted">{fields.map((f) => f.field).join(", ")}</span>}
                </summary>
                <table className="cl-diff">
                  <thead><tr><th>Campo</th>{e.op !== "INSERT" && <th>Prima</th>}{e.op !== "DELETE" && <th>Dopo</th>}</tr></thead>
                  <tbody>
                    {fields.map((f) => (
                      <tr key={f.field}><th scope="row">{f.field}</th>{e.op !== "INSERT" && <td><Value v={f.before} /></td>}{e.op !== "DELETE" && <td><Value v={f.after} /></td>}</tr>
                    ))}
                  </tbody>
                </table>
                <div className="btn-row">
                  {e.op === "DELETE"
                    ? <button className="btn-sm" disabled={busy} onClick={() => void restore(e)}>Ripristina l'elemento eliminato</button>
                    : <button className="btn-sm" disabled={busy || current} title={current ? "È già la versione attuale" : undefined} onClick={() => void restore(e)}>Torna a questa versione</button>}
                  {e.rowId != null && query.rowId == null && <button className="btn-sm" onClick={() => history(e)}>Cronologia di questo elemento</button>}
                  {e.dbUser && <span className="muted">utente del database: {e.dbUser}</span>}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
