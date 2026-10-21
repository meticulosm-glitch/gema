import { useCallback, useEffect, useState } from "react";
import type Keycloak from "keycloak-js";
import type { AccessConfig } from "./config";
import type { Product } from "./capabilities";
import { saveBlob } from "./download";
import {
  SECTIONS, SECTION_IDS, applyRestore, backupName, collect, exportBackup, missingLayersIn, parseBackup, planRestore, planSize,
  type BackupFile, type Mode, type SectionId, type SectionPlan, type Snapshot,
} from "./backup";

const when = (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" }) : "?"; };
const names = (id: SectionId, rows: { fid?: string }[]) => rows.map((r) => SECTIONS[id].name(r)).join(", ");

function PlanTable({ plan }: { plan: SectionPlan[] }) {
  return (
    <table className="bk-plan">
      <thead><tr><th scope="col">Sezione</th><th scope="col" className="num">Nuovi</th><th scope="col" className="num">Modificati</th><th scope="col" className="num">Da eliminare</th><th scope="col" className="num">Uguali</th></tr></thead>
      <tbody>
        {plan.map((p) => (
          <tr key={p.id}>
            <th scope="row">{SECTIONS[p.id].label}</th>
            <td className="num" title={names(p.id, p.insert)}>{p.insert.length}</td>
            <td className="num" title={names(p.id, p.update.map((u) => u.row))}>{p.update.length}</td>
            <td className={`num${p.remove.length ? " bk-del" : ""}`} title={names(p.id, p.remove)}>{p.remove.length}</td>
            <td className="num">{p.same}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Admin → Backup e ripristino: tutta la configurazione in un file, e ritorno da un file. */
export default function AdminBackup({ gs, kc, acc, products, onChanged }: { gs: string; kc: Keycloak; acc: AccessConfig; products: Product[]; onChanged: () => Promise<void> }) {
  const [current, setCurrent] = useState<Snapshot | null>(null);
  const [errors, setErrors] = useState<Partial<Record<SectionId, string>>>({});
  const [chosen, setChosen] = useState<Set<SectionId>>(new Set(SECTION_IDS));
  const [file, setFile] = useState<{ file: BackupFile; warnings: string[]; name: string } | null>(null);
  const [restoreIds, setRestoreIds] = useState<Set<SectionId>>(new Set());
  const [mode, setMode] = useState<Mode>("merge");
  const [safety, setSafety] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const reload = useCallback(async () => {
    const r = await collect(gs, kc, acc);
    setCurrent(r.data); setErrors(r.errors);
    return r.data;
  }, [gs, kc, acc]);
  useEffect(() => { void reload(); }, [reload]);

  const download = (data: Snapshot, ids: SectionId[]) =>
    saveBlob(new Blob([JSON.stringify(exportBackup(data, ids, window.location.host, acc.workspace), null, 2)], { type: "application/json" }), backupName(window.location.host));

  const readFile = async (f: File) => {
    setMsg(null);
    try {
      const parsed = parseBackup(await f.text());
      setFile({ ...parsed, name: f.name });
      setRestoreIds(new Set((Object.keys(parsed.file.sections) as SectionId[]).filter((id) => !errors[id])));
    } catch (e) { setFile(null); setMsg({ ok: false, text: `File non utilizzabile: ${(e as Error).message}` }); }
  };

  const fileIds = file ? (Object.keys(file.file.sections) as SectionId[]) : [];
  const plan = file && current ? planRestore(current, file.file.sections, [...restoreIds], mode) : [];
  const total = planSize(plan);
  const missing = file ? missingLayersIn(file.file.sections, [...restoreIds], new Set(products.map((p) => p.name))) : [];
  const removals = plan.reduce((n, p) => n + p.remove.length, 0);

  const restore = async () => {
    if (!file || !current) return;
    if (!window.confirm(`Applicare il ripristino?\n${total} modifiche${removals ? `, di cui ${removals} eliminazioni` : ""}, in un'unica operazione.`)) return;
    setBusy(true); setMsg(null);
    try {
      if (safety) download(current, SECTION_IDS); // copia di ciò che c'è adesso, prima di cambiarlo
      const n = await applyRestore(gs, kc, acc, plan);
      await onChanged();
      await reload();
      setFile(null);
      setMsg({ ok: true, text: `Ripristino completato: ${n} modifiche applicate.${safety ? " La copia della configurazione precedente è stata scaricata." : ""}` });
    } catch (e) {
      setMsg({ ok: false, text: `Ripristino non riuscito, nessuna modifica applicata: ${(e as Error).message}` });
    } finally { setBusy(false); }
  };

  const toggle = (set: Set<SectionId>, id: SectionId, on: boolean) => { const n = new Set(set); if (on) n.add(id); else n.delete(id); return n; };
  const available = SECTION_IDS.filter((id) => current?.[id]);

  return (
    <div className="page-inner wide">
      <h1>Backup e ripristino</h1>
      <p className="muted">Regole dei ruoli, viste iniziali, dashboard, catalogo, moduli di modifica e avvisi in un file JSON: per tenerne una copia o portarli in un altro ambiente. Viste salvate degli utenti, bozze, registro e statistiche non sono inclusi.</p>
      {msg && <div className={msg.ok ? "ok" : "error"} role="status">{msg.text}</div>}

      <section className="bk-card" aria-label="Backup">
        <h2>Backup</h2>
        {!current ? <div className="muted">Lettura della configurazione…</div> : (
          <>
            <div className="check-row bk-sections">
              {SECTION_IDS.map((id) => (
                <label key={id} className="check" title={errors[id]}>
                  <input type="checkbox" disabled={!current[id]} checked={!!current[id] && chosen.has(id)} onChange={(e) => setChosen(toggle(chosen, id, e.target.checked))} />
                  {SECTIONS[id].label} <span className="muted">{current[id] ? `(${current[id]!.length})` : "(non disponibile)"}</span>
                </label>
              ))}
            </div>
            {Object.keys(errors).length > 0 && <div className="notice">Sezioni non lette (tabella assente o non leggibile): {(Object.keys(errors) as SectionId[]).map((id) => SECTIONS[id].label).join(", ")}.</div>}
            <div className="btn-row"><button className="btn-sm primary" disabled={available.every((id) => !chosen.has(id))} onClick={() => download(current, available.filter((id) => chosen.has(id)))}>Scarica backup (JSON)</button></div>
          </>
        )}
      </section>

      <section className="bk-card" aria-label="Ripristino">
        <h2>Ripristino</h2>
        <label className="btn-sm file-btn">Scegli un file di backup…
          <input type="file" accept="application/json,.json" aria-label="File di backup da ripristinare" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void readFile(f); }} />
        </label>
        {file && (
          <div className="bk-restore">
            <div className="muted">{file.name}: backup del {when(file.file.exportedAt)}{file.file.source ? ` da ${file.file.source}` : ""}{file.file.workspace && file.file.workspace !== acc.workspace ? ` (workspace ${file.file.workspace}, qui ${acc.workspace})` : ""}.</div>
            {file.warnings.length > 0 && <ul className="problems">{file.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
            <div className="section-title">Cosa ripristinare</div>
            <div className="check-row">
              {fileIds.map((id) => (
                <label key={id} className="check">
                  <input type="checkbox" disabled={!!errors[id]} checked={restoreIds.has(id)} onChange={(e) => setRestoreIds(toggle(restoreIds, id, e.target.checked))} />
                  {SECTIONS[id].label} <span className="muted">({file.file.sections[id]!.length}{errors[id] ? ", tabella non disponibile qui" : ""})</span>
                </label>
              ))}
            </div>
            <fieldset className="bk-mode">
              <legend>Come</legend>
              <label className="check"><input type="radio" name="bk-mode" checked={mode === "merge"} onChange={() => setMode("merge")} /> Aggiungi e aggiorna <span className="muted">(non elimina nulla)</span></label>
              <label className="check"><input type="radio" name="bk-mode" checked={mode === "replace"} onChange={() => setMode("replace")} /> Sostituisci <span className="muted">(nelle sezioni scelte elimina ciò che non è nel file)</span></label>
            </fieldset>
            {plan.length > 0 && <PlanTable plan={plan} />}
            {missing.length > 0 && <div className="notice">Layer citati nel file ma non pubblicati in questo ambiente: {missing.join(", ")}. Si ripristinano comunque; finché non ci sono, non compaiono.</div>}
            <label className="check"><input type="checkbox" checked={safety} onChange={(e) => setSafety(e.target.checked)} /> Scarica prima una copia della configurazione attuale</label>
            <div className="btn-row">
              <button className="btn-sm primary" disabled={busy || total === 0} onClick={() => void restore()}>{total === 0 ? "Niente da cambiare" : `Ripristina (${total} modifiche)`}</button>
              <button className="btn-sm" disabled={busy} onClick={() => setFile(null)}>Annulla</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
