import { LEVELS, linkify, type Announcement } from "./announcements";
import { IconClose } from "./icons";

const ICON: Record<Announcement["level"], string> = { info: "ℹ", warning: "⚠", maintenance: "🛠" };

/** Avvisi in testa alla pagina, sotto la barra. Gli avvisi chiudibili hanno la ×; la manutenzione resta. */
export default function AnnouncementBar({ items, onDismiss }: { items: Announcement[]; onDismiss: (a: Announcement) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="ann-bar" role="region" aria-label="Avvisi">
      {items.map((a) => (
        <div key={a.fid ?? a.message} className={`ann ann-${a.level}`} role={a.level === "info" ? "status" : "alert"} data-level={a.level}>
          <span className="ann-icon" aria-hidden="true">{ICON[a.level]}</span>
          <span className="sr-only">{LEVELS.find((l) => l.id === a.level)?.label}: </span>
          <span className="ann-text">
            {linkify(a.message).map((p, i) => (p.href ? <a key={i} href={p.href} target="_blank" rel="noopener noreferrer">{p.text}</a> : <span key={i}>{p.text}</span>))}
          </span>
          {a.dismissible && a.level !== "maintenance" && (
            <button className="icon-btn ann-close" title="Chiudi l'avviso" aria-label="Chiudi l'avviso" onClick={() => onDismiss(a)}><IconClose /></button>
          )}
        </div>
      ))}
    </div>
  );
}
