import { useCallback, useEffect, useRef, useState } from "react";
import type Keycloak from "keycloak-js";
import type { AccessConfig, AppConfig } from "./config";
import { GROUPS, STATUS_LABEL, reportText, runChecks, summary, type CheckResult, type CheckStatus, type DiagContext } from "./diagnostics";
import { saveBlob } from "./download";

const ICON: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✕", info: "i", skip: "–" };

/** Pagina Admin → Diagnostica: controlli su GeoServer, tabelle, scrittura, token e Keycloak, sfondi. */
export default function AdminDiagnostics({ cfg, acc, gs, kc, run = runChecks }: { cfg: AppConfig; acc: AccessConfig; gs: string; kc: Keycloak; run?: typeof runChecks }) {
  const [results, setResults] = useState<CheckResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [when, setWhen] = useState<Date | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const gen = useRef(0);

  const start = useCallback(() => {
    const id = ++gen.current;
    setBusy(true); setResults([]); setCopied(null);
    const ctx: DiagContext = { cfg, acc, gs, kc, origin: window.location.origin };
    void run(ctx, (partial) => { if (gen.current === id) setResults(partial); })
      .then((all) => { if (gen.current === id) { setResults(all); setWhen(new Date()); } })
      .finally(() => { if (gen.current === id) setBusy(false); });
  }, [cfg, acc, gs, kc, run]);
  useEffect(() => { start(); return () => { gen.current++; }; }, [start]);

  const s = summary(results);
  const text = () => reportText(results, when ?? new Date(), window.location.origin);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text()); setCopied("Rapporto copiato negli appunti."); }
    catch { setCopied("Copia non consentita dal browser: usa «Scarica rapporto»."); }
  };
  const download = () => saveBlob(new Blob([text()], { type: "text/plain;charset=utf-8" }), `diagnostica-${(when ?? new Date()).toISOString().slice(0, 16).replace(/[:T]/g, "-")}.txt`);

  return (
    <div className="page-inner wide">
      <div className="page-title">
        <div>
          <h1>Diagnostica</h1>
          <p className="muted">Controlli fatti da questo browser, con il tuo token e lo stesso proxy dell'applicazione.</p>
        </div>
        <div className="btn-row">
          <button className="btn-sm primary" disabled={busy} onClick={start}>{busy ? "Controllo in corso…" : "Ripeti i controlli"}</button>
          <button className="btn-sm" disabled={busy || results.length === 0} onClick={() => void copy()}>Copia rapporto</button>
          <button className="btn-sm" disabled={busy || results.length === 0} onClick={download}>Scarica rapporto</button>
        </div>
      </div>
      <div className="diag-summary" role="status" aria-live="polite">
        {busy ? "Controllo in corso…" : results.length === 0 ? "" : s.fail ? `${s.fail} errori, ${s.warn} avvisi, ${s.ok} controlli superati.` : s.warn ? `Nessun errore; ${s.warn} avvisi, ${s.ok} controlli superati.` : `Tutto a posto: ${s.ok} controlli superati.`}
        {when && !busy && <span className="muted"> · {when.toLocaleTimeString("it-IT")}</span>}
      </div>
      {copied && <div className="ok">{copied}</div>}
      {!busy && (s.fail > 0 || s.warn > 0) && (
        <section className="diag-todo" aria-label="Da sistemare">
          <strong>Da sistemare</strong>
          <ul>
            {results.filter((r) => r.status === "fail" || r.status === "warn").map((r) => (
              <li key={r.id} className={`ds-${r.status}`}><a href={`#diag-${r.id}`}>{r.label}</a>: {r.detail.split("\n")[0]}</li>
            ))}
          </ul>
        </section>
      )}
      {GROUPS.map((g) => {
        const rows = results.filter((r) => r.group === g);
        if (!rows.length) return null;
        return (
          <section key={g} className="diag-group" aria-label={g}>
            <h2>{g}</h2>
            <ul className="diag-list">
              {rows.map((r) => (
                <li key={r.id} id={`diag-${r.id}`} className={`diag-row ds-${r.status}`} data-check={r.id}>
                  <span className="diag-icon" aria-hidden="true">{ICON[r.status]}</span>
                  <div className="diag-main">
                    <div className="diag-head"><strong>{r.label}</strong><span className="diag-status">{STATUS_LABEL[r.status]}</span>{r.ms != null && <span className="muted">{r.ms} ms</span>}</div>
                    <div className="diag-detail">{r.detail}</div>
                    {r.hint && <div className="diag-hint">{r.hint}</div>}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
