import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type Keycloak from "keycloak-js";
import type { AccessConfig } from "./config";
import type { Product } from "./capabilities";
import { OTHERS, folderPath, isEmptyCatalog, type Catalog, type CatalogFolder, type CatalogLayer } from "./catalog";
import {
  addFolder, canMoveInto, childrenOf, diffCatalog, diffSize, editableCatalog, moveBy, moveTargets, moveTo, parentOf, patchFolder, patchLayer,
  refId, removeFolder, rowsToSave, validate, type EditState, type Ref,
} from "./catalogEdit";
import { CatalogConflictError, saveCatalog } from "./configStore";
import { IconDown, IconFolder, IconGrip, IconLayers, IconUp } from "./icons";

type Row = { ref: Ref; depth: number; folder?: CatalogFolder; layer?: CatalogLayer; product?: Product; hiddenByParent: boolean };

/** Righe dell'albero in ordine di visita, con la profondità (le cartelle chiuse non mostrano il contenuto). */
function rowsOf(cat: Catalog, products: Map<string, Product>, collapsed: Set<string>, q: string): Row[] {
  const s = q.trim().toLowerCase();
  const matches = (r: Row): boolean => {
    if (!s) return true;
    const t = r.folder ? r.folder.title : `${r.layer!.title} ${r.product?.title ?? ""} ${r.layer!.layer}`;
    return t.toLowerCase().includes(s);
  };
  const out: Row[] = [];
  const walk = (parent: string, depth: number, hidden: boolean): boolean => {
    let any = false;
    for (const ref of childrenOf(cat, parent)) {
      if (ref.kind === "folder") {
        const folder = cat.folders.find((f) => f.key === ref.key)!;
        const row: Row = { ref, depth, folder, hiddenByParent: hidden };
        const at = out.length;
        out.push(row);
        const inner = walk(ref.key, depth + 1, hidden || folder.hidden);
        const self = matches(row);
        if (s && !inner && !self) out.splice(at); // ricerca: cartella senza risultati
        else any = true;
        if (!s && collapsed.has(ref.key)) out.splice(at + 1);
      } else {
        const layer = cat.layers.find((l) => l.layer === ref.name)!;
        const row: Row = { ref, depth, layer, product: products.get(ref.name), hiddenByParent: hidden };
        if (matches(row)) { out.push(row); any = true; }
      }
    }
    return any;
  };
  walk("", 0, false);
  return out;
}

const layerCount = (cat: Catalog, key: string): number =>
  cat.layers.filter((l) => l.folder === key).length + cat.folders.filter((f) => f.parent === key).reduce((n, f) => n + layerCount(cat, f.key), 0);

export default function AdminCatalog({
  gs, kc, acc, products, catalog, catalogError, onChanged,
}: {
  gs: string; kc: Keycloak; acc: AccessConfig; products: Product[]; catalog: Catalog; catalogError: string | null; onChanged: () => Promise<void>;
}) {
  const [base, setBase] = useState<Catalog>(catalog);
  const [edit, setEdit] = useState<EditState>(() => editableCatalog(products, catalog));
  const [sel, setSel] = useState<Ref | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; conflict?: boolean } | null>(null);
  const drag = useRef<Ref | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);

  // catalogo ricaricato (dopo un salvataggio o una ricarica): si riparte da quello
  useEffect(() => {
    setBase(catalog);
    setEdit(editableCatalog(products, catalog));
  }, [catalog, products]);

  const byName = useMemo(() => new Map(products.map((p) => [p.name, p])), [products]);
  const cat = edit.cat;
  const diff = useMemo(() => diffCatalog(base, rowsToSave(edit)), [base, edit]);
  const changes = diffSize(diff);
  const problems = validate(cat);
  const fresh = isEmptyCatalog(base);
  const newLayers = fresh ? 0 : cat.layers.filter((l) => !l.fid).length;
  const rows = useMemo(() => rowsOf(cat, byName, collapsed, filter), [cat, byName, collapsed, filter]);

  // modifiche non salvate: avviso se si chiude o ricarica la pagina
  useEffect(() => {
    if (changes === 0) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [changes]);

  const update = (fn: (c: Catalog) => Catalog) => { setEdit((s) => ({ ...s, cat: fn(s.cat) })); setMsg(null); };
  const selFolder = sel?.kind === "folder" ? cat.folders.find((f) => f.key === sel.key) : undefined;
  const selLayer = sel?.kind === "layer" ? cat.layers.find((l) => l.layer === sel.name) : undefined;
  const selProduct = selLayer ? byName.get(selLayer.layer) : undefined;
  const siblings = sel ? childrenOf(cat, parentOf(cat, sel)) : [];
  const selIndex = sel ? siblings.findIndex((r) => refId(r) === refId(sel)) : -1;

  const save = async () => {
    if (problems.length) return;
    setBusy(true); setMsg(null);
    try {
      const n = await saveCatalog(gs, kc, acc, base, rowsToSave(edit));
      await onChanged();
      setMsg({ ok: true, text: `Catalogo salvato (${n} ${n === 1 ? "modifica" : "modifiche"}). Gli utenti lo vedono alla prossima apertura della mappa.` });
    } catch (e) {
      setMsg({ ok: false, text: `Salvataggio non riuscito: ${(e as Error).message}`, conflict: e instanceof CatalogConflictError });
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => { setBusy(true); try { await onChanged(); setMsg(null); } finally { setBusy(false); } };
  const discard = () => { setEdit(editableCatalog(products, base)); setMsg(null); };
  const newFolder = (parent = "") => {
    const r = addFolder(cat, "Nuova cartella", parent);
    setEdit((s) => ({ ...s, cat: r.cat }));
    setMsg(null);
    setSel({ kind: "folder", key: r.key });
    setCollapsed((s) => { const n = new Set(s); n.delete(parent); return n; });
  };

  // ---- trascinamento: su una cartella = dentro (in fondo); su un layer o su una cartella con Maiusc = prima di lui
  const targetFor = (row: Row | null, e: DragEvent): { parent: string; before?: Ref } | null => {
    const r = drag.current;
    if (!r) return null;
    if (!row) return canMoveInto(cat, r, "") ? { parent: "" } : null;
    if (row.ref.kind === "folder" && !e.shiftKey) return canMoveInto(cat, r, row.ref.key) ? { parent: row.ref.key } : null;
    const parent = parentOf(cat, row.ref);
    return canMoveInto(cat, r, parent) ? { parent, before: row.ref } : null;
  };
  const dragProps = (row: Row | null) => ({
    onDragOver: (e: DragEvent) => { if (targetFor(row, e)) { e.preventDefault(); setDropOn(row ? refId(row.ref) : "root"); } },
    onDragLeave: () => setDropOn((d) => (d === (row ? refId(row.ref) : "root") ? null : d)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const t = targetFor(row, e);
      const r = drag.current;
      drag.current = null; setDropOn(null);
      if (t && r) { update((c) => moveTo(c, r, t.parent, t.before)); setSel(r); }
    },
  });

  return (
    <div className="page-inner wide catalog-admin">
      <h1>Catalogo prodotti</h1>
      <p className="muted">
        Come appaiono i layer di GeoServer nell'elenco della mappa: cartelle, ordine, titoli e descrizioni, layer nascosti e accesi
        all'apertura. Trascina gli elementi oppure usa le frecce. Titolo e descrizione vuoti = quelli di GeoServer.
        Nascondere un layer non è un permesso: chi vede cosa lo decidono i ruoli e GeoServer.
      </p>
      {catalogError && <div className="error">{catalogError}</div>}
      {fresh && !catalogError && <div className="notice">Il catalogo non è ancora stato salvato: gli utenti vedono i layer raggruppati per workspace. Qui sotto trovi lo stesso schema come punto di partenza.</div>}
      {newLayers > 0 && <div className="notice">{newLayers === 1 ? "1 layer pubblicato" : `${newLayers} layer pubblicati`} dopo l'ultimo salvataggio: {newLayers === 1 ? "è" : "sono"} in fondo a «{cat.folders.find((f) => f.key === OTHERS)?.title}». Salva per confermarne la posizione.</div>}
      {msg && (
        <div className={msg.ok ? "ok" : "error"} role="status">
          {msg.text} {msg.conflict && <button className="btn-sm" disabled={busy} onClick={() => void reload()}>Ricarica il catalogo</button>}
        </div>
      )}

      <div className="btn-row cat-toolbar">
        <button className="btn-sm" onClick={() => newFolder("")} disabled={busy}>Nuova cartella</button>
        <input className="search" type="search" placeholder="Filtra cartelle e layer…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtra il catalogo" />
        <span className="spacer" />
        {changes > 0 && <span className="muted cat-changes">{changes === 1 ? "1 modifica non salvata" : `${changes} modifiche non salvate`}</span>}
        <button className="btn-sm" disabled={busy || changes === 0} onClick={discard}>Annulla modifiche</button>
        <button className="btn-sm primary" disabled={busy || changes === 0 || problems.length > 0 || !!catalogError} onClick={() => void save()}>
          {busy ? "Salvataggio…" : "Salva catalogo"}
        </button>
      </div>
      {problems.map((p) => <div key={p} className="error">{p}</div>)}

      <div className="cat-grid">
        <div className="cat-tree" role="tree" aria-label="Catalogo">
          {rows.length === 0 && <div className="empty">{filter ? "Nessun elemento corrisponde al filtro." : "Nessun layer pubblicato."}</div>}
          {rows.map((row) => {
            const id = refId(row.ref);
            const on = sel && refId(sel) === id;
            const f = row.folder, l = row.layer;
            const hidden = row.hiddenByParent || !!f?.hidden || !!l?.hidden;
            return (
              <div
                key={id}
                role="treeitem"
                aria-selected={!!on}
                aria-expanded={f ? !collapsed.has(f.key) : undefined}
                data-ref={id}
                className={`cat-row${f ? " folder" : " layer"}${on ? " on" : ""}${hidden ? " is-hidden" : ""}${dropOn === id ? " drop" : ""}`}
                style={{ paddingLeft: 8 + row.depth * 20 }}
                draggable
                onDragStart={(e) => { drag.current = row.ref; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", id); }}
                onDragEnd={() => { drag.current = null; setDropOn(null); }}
                {...dragProps(row)}
                onClick={() => setSel(row.ref)}
              >
                <span className="cat-grip" aria-hidden="true"><IconGrip /></span>
                {f ? (
                  <button
                    className="cat-caret"
                    aria-label={collapsed.has(f.key) ? `Apri ${f.title}` : `Chiudi ${f.title}`}
                    onClick={(e) => { e.stopPropagation(); setCollapsed((s) => { const n = new Set(s); if (n.has(f.key)) n.delete(f.key); else n.add(f.key); return n; }); }}
                  >
                    {collapsed.has(f.key) ? "▸" : "▾"}
                  </button>
                ) : <span className="cat-caret" />}
                <span className="cat-ico">{f ? <IconFolder /> : <IconLayers />}</span>
                <span className="cat-title">
                  {f ? f.title || <em>(senza titolo)</em> : l!.title || row.product?.title || l!.layer}
                  {l && <small className="muted">{l.layer}</small>}
                </span>
                {f && <span className="count">{layerCount(cat, f.key)}</span>}
                {f?.key === OTHERS && <span className="tag">non catalogati</span>}
                {l && !l.fid && !fresh && <span className="tag new">nuovo</span>}
                {l?.title && <span className="tag" title={`In GeoServer: ${row.product?.title ?? ""}`}>titolo</span>}
                {l?.defaultOn && <span className="tag on">acceso</span>}
                {hidden && <span className="tag off">{row.hiddenByParent ? "nascosto (cartella)" : "nascosto"}</span>}
                {f?.expanded && <span className="tag">aperta</span>}
                <span className="cat-moves">
                  <button className="icon-btn" title="Sposta su" aria-label="Sposta su" onClick={(e) => { e.stopPropagation(); update((c) => moveBy(c, row.ref, -1)); }}><IconUp /></button>
                  <button className="icon-btn" title="Sposta giù" aria-label="Sposta giù" onClick={(e) => { e.stopPropagation(); update((c) => moveBy(c, row.ref, 1)); }}><IconDown /></button>
                </span>
              </div>
            );
          })}
          {!filter && <div className={`cat-root-drop${dropOn === "root" ? " drop" : ""}`} {...dragProps(null)}>Trascina qui per portare al primo livello</div>}
        </div>

        <div className="cat-detail">
          {!sel && <div className="empty">Seleziona una cartella o un layer per modificarlo.</div>}

          {selFolder && (
            <div className="cat-form" data-edit={`f:${selFolder.key}`}>
              <h3>{selFolder.key === OTHERS ? "Cartella dei layer non catalogati" : "Cartella"}</h3>
              {selFolder.key === OTHERS && <p className="muted">Qui finiscono i layer pubblicati in GeoServer dopo l'ultimo salvataggio. Puoi rinominarla, spostarla o nasconderla (i nuovi layer resteranno nascosti finché non li sposti).</p>}
              <label><span>Titolo</span><input className="search" value={selFolder.title} onChange={(e) => update((c) => patchFolder(c, selFolder.key, { title: e.target.value }))} /></label>
              <label><span>Descrizione</span><textarea className="search" rows={3} value={selFolder.description} placeholder="Facoltativa: appare sotto il nome della cartella" onChange={(e) => update((c) => patchFolder(c, selFolder.key, { description: e.target.value }))} /></label>
              <label><span>Contenuta in</span>
                <select value={selFolder.parent} disabled={selFolder.key === OTHERS} onChange={(e) => update((c) => moveTo(c, sel!, e.target.value))}>
                  {moveTargets(cat, sel!).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select>
              </label>
              <label className="check"><input type="checkbox" checked={selFolder.expanded} onChange={(e) => update((c) => patchFolder(c, selFolder.key, { expanded: e.target.checked }))} /> <span className="check-text">Aperta all'avvio<small className="muted">la cartella si apre da sola quando si apre la mappa</small></span></label>
              <label className="check"><input type="checkbox" checked={selFolder.hidden} onChange={(e) => update((c) => patchFolder(c, selFolder.key, { hidden: e.target.checked }))} /> <span className="check-text">Nascosta<small className="muted">la cartella e tutto quello che contiene non compaiono nell'elenco</small></span></label>
              <div className="btn-row">
                <button className="btn-sm" disabled={selIndex <= 0} onClick={() => update((c) => moveBy(c, sel!, -1))}>Su</button>
                <button className="btn-sm" disabled={selIndex < 0 || selIndex >= siblings.length - 1} onClick={() => update((c) => moveBy(c, sel!, 1))}>Giù</button>
                {selFolder.key !== OTHERS && <button className="btn-sm" onClick={() => newFolder(selFolder.key)}>Nuova sottocartella</button>}
                {selFolder.key !== OTHERS && (
                  <button className="btn-sm danger" onClick={() => { update((c) => removeFolder(c, selFolder.key)); setSel(null); }}>Elimina cartella</button>
                )}
              </div>
              {selFolder.key !== OTHERS && <p className="muted">Eliminando la cartella il suo contenuto passa a «{folderPath(cat, selFolder.parent) || "primo livello"}».</p>}
            </div>
          )}

          {selLayer && (
            <div className="cat-form" data-edit={`l:${selLayer.layer}`}>
              <h3>Layer <code>{selLayer.layer}</code></h3>
              <label><span>Titolo</span><input className="search" value={selLayer.title} placeholder={selProduct?.title ?? ""} onChange={(e) => update((c) => patchLayer(c, selLayer.layer, { title: e.target.value }))} /></label>
              <span className="muted">In GeoServer: {selProduct?.title ?? "—"}</span>
              <label><span>Descrizione</span><textarea className="search" rows={4} value={selLayer.description} placeholder={selProduct?.abstract ?? "Nessuna descrizione in GeoServer"} onChange={(e) => update((c) => patchLayer(c, selLayer.layer, { description: e.target.value }))} /></label>
              <label><span>Cartella</span>
                <select value={selLayer.folder} onChange={(e) => update((c) => moveTo(c, sel!, e.target.value))}>
                  {moveTargets(cat, sel!).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select>
              </label>
              <label className="check"><input type="checkbox" checked={selLayer.defaultOn} onChange={(e) => update((c) => patchLayer(c, selLayer.layer, { defaultOn: e.target.checked }))} /> <span className="check-text">Acceso di default<small className="muted">si accende quando la mappa si apre senza un link o una vista salvata</small></span></label>
              <label className="check"><input type="checkbox" checked={selLayer.hidden} onChange={(e) => update((c) => patchLayer(c, selLayer.layer, { hidden: e.target.checked }))} /> <span className="check-text">Nascosto<small className="muted">non compare nell'elenco dei prodotti (gli amministratori lo vedono marcato)</small></span></label>
              <div className="btn-row">
                <button className="btn-sm" disabled={selIndex <= 0} onClick={() => update((c) => moveBy(c, sel!, -1))}>Su</button>
                <button className="btn-sm" disabled={selIndex < 0 || selIndex >= siblings.length - 1} onClick={() => update((c) => moveBy(c, sel!, 1))}>Giù</button>
              </div>
            </div>
          )}

          {edit.stale.length > 0 && !catalogError && (
            <div className="cat-form cat-stale">
              <h3>Layer non più pubblicati</h3>
              <p className="muted">Sono nel catalogo ma GeoServer non li pubblica (o non sono visibili con le credenziali del proxy). Non compaiono nella mappa; se tornano pubblicati riprendono il loro posto.</p>
              <ul className="plain">
                {edit.stale.map((l) => (
                  <li key={l.layer} className="btn-row">
                    <code>{l.layer}</code>
                    <button className="btn-sm danger" onClick={() => { setEdit((s) => ({ ...s, stale: s.stale.filter((x) => x.layer !== l.layer) })); setMsg(null); }}>Rimuovi dal catalogo</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
