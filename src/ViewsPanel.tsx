import { useCallback, useEffect, useState } from "react";
import type Keycloak from "keycloak-js";
import type { AccessConfig } from "./config";
import { deleteView, isMissingTable, loadLocalViews, loadViews, saveView, storeLocalViews, VIEWS_TABLE, type SavedView } from "./configStore";
import type { ViewState } from "./viewState";
import { IconClose } from "./icons";

const MAX_NAME = 80;
const when = (s?: string) => {
  const d = s ? new Date(s) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString("it-IT") : "";
};

/**
 * Viste salvate: layer attivi con filtro, data, stile, opacità, sfondo e inquadratura, con un nome.
 * Con il controllo accessi stanno in PostGIS (tabella saved_views, per utente); senza, solo in questo browser.
 */
export default function ViewsPanel({
  gsUrl, kc, access, capture, onApply, onClose,
}: {
  gsUrl: string;
  kc: Keycloak | null;
  access?: AccessConfig;
  capture: () => ViewState;
  onApply: (s: ViewState) => void;
  onClose: () => void;
}) {
  const remote = !!access?.enabled;
  const [views, setViews] = useState<SavedView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);

  const fail = (e: unknown) =>
    setError(
      isMissingTable(e)
        ? `Tabella ${access?.workspace}:${VIEWS_TABLE} non trovata: aggiorna lo script di inizializzazione (SQL e pubblicazione su GeoServer).`
        : `Operazione non riuscita: ${(e as Error)?.message ?? e}`,
    );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setViews(remote ? await loadViews(gsUrl, kc, access!) : loadLocalViews());
      setError(null);
    } catch (e) {
      setViews([]);
      fail(e);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, gsUrl, kc, access]);
  useEffect(() => { void reload(); }, [reload]);

  const write = async (fn: () => Promise<void> | void) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const create = () => {
    const n = name.trim().slice(0, MAX_NAME);
    if (!n) return;
    void write(async () => {
      const state = capture();
      if (remote) await saveView(gsUrl, kc, access!, { name: n, state });
      else storeLocalViews([{ fid: `l${Date.now()}`, owner: "locale", name: n, state, createdAt: new Date().toISOString() }, ...loadLocalViews()]);
      setName("");
    });
  };
  const overwrite = (v: SavedView) =>
    write(async () => {
      const state = capture();
      if (remote) await saveView(gsUrl, kc, access!, { fid: v.fid, name: v.name, state });
      else storeLocalViews(loadLocalViews().map((x) => (x.fid === v.fid ? { ...x, state } : x)));
    });
  const remove = (v: SavedView) =>
    write(async () => {
      setConfirm(null);
      if (remote) await deleteView(gsUrl, kc, access!, v.fid!);
      else storeLocalViews(loadLocalViews().filter((x) => x.fid !== v.fid));
    });

  return (
    <div className="float-panel views">
      <div className="fp-head">
        <strong>Viste salvate</strong>
        <button className="icon-btn" title="Chiudi" aria-label="Chiudi le viste salvate" onClick={onClose}><IconClose /></button>
      </div>
      <div className="fp-body">
        <form className="fb-row" onSubmit={(e) => { e.preventDefault(); create(); }}>
          <input className="search" placeholder="Nome della vista" aria-label="Nome della vista" maxLength={MAX_NAME} value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn-sm primary" type="submit" disabled={busy || !name.trim()}>Salva</button>
        </form>
        <div className="muted">
          {remote ? "Layer attivi, filtri, date, stili, sfondo e inquadratura di adesso." : "Salvate solo in questo browser (servono Keycloak e il controllo accessi per averle ovunque)."}
        </div>
        {error && <div className="error" role="alert">{error}</div>}
        {loading && <div className="empty">Caricamento…</div>}
        {!loading && !error && views.length === 0 && <div className="empty">Nessuna vista salvata.</div>}
        <ul className="view-list">
          {views.map((v) => (
            <li key={v.fid} className="view-row">
              <button className="view-open" title="Apri questa vista" onClick={() => onApply(v.state)}>
                <span className="view-name">{v.name}</span>
                <span className="muted">{v.state.l.length} layer{when(v.createdAt) ? ` · ${when(v.createdAt)}` : ""}</span>
              </button>
              <button className="btn-sm" title="Sostituisci con la vista attuale" disabled={busy} onClick={() => { void overwrite(v); }}>Aggiorna</button>
              {confirm === v.fid ? (
                <button className="btn-sm danger" disabled={busy} onClick={() => { void remove(v); }}>Conferma</button>
              ) : (
                <button className="icon-btn" title="Elimina" aria-label={`Elimina ${v.name}`} disabled={busy} onClick={() => setConfirm(v.fid ?? null)}><IconClose /></button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
