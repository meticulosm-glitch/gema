/**
 * Avvisi in testa all'applicazione (informazioni, attenzione, manutenzione), gestiti dalla pagina Admin -> Avvisi.
 * Una riga per avviso nella tabella announcements; il periodo e i ruoli decidono chi lo vede e quando.
 */
export type Level = "info" | "warning" | "maintenance";
export const LEVELS: { id: Level; label: string }[] = [
  { id: "info", label: "Informazione" },
  { id: "warning", label: "Attenzione" },
  { id: "maintenance", label: "Manutenzione" },
];

export interface Announcement {
  fid?: string;
  message: string;
  level: Level;
  startsAt: string;     // ISO 8601 con fuso, "" = subito
  endsAt: string;       // ISO 8601 con fuso, "" = finché non si disattiva
  roles: string[];      // vuoto = tutti
  dismissible: boolean; // l'utente lo può chiudere (gli avvisi di manutenzione no)
  active: boolean;
  updatedBy?: string;
  updatedAt?: string;
}

export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const time = (s: string) => (s && ISO_RE.test(s) ? Date.parse(s) : NaN);

export const blankAnnouncement = (): Announcement => ({ message: "", level: "info", startsAt: "", endsAt: "", roles: [], dismissible: true, active: true });

export function sanitizeLevel(v: unknown): Level {
  return v === "warning" || v === "maintenance" ? v : "info";
}

/** Problemi che impediscono il salvataggio. */
export function validateAnnouncement(a: Announcement): string[] {
  const errs: string[] = [];
  if (!a.message.trim()) errs.push("Scrivi il testo dell'avviso.");
  if (a.message.length > 1000) errs.push("Il testo è troppo lungo (massimo 1000 caratteri).");
  if (a.startsAt && Number.isNaN(time(a.startsAt))) errs.push("Data di inizio non valida.");
  if (a.endsAt && Number.isNaN(time(a.endsAt))) errs.push("Data di fine non valida.");
  if (a.startsAt && a.endsAt && time(a.endsAt) <= time(a.startsAt)) errs.push("La fine deve venire dopo l'inizio.");
  return errs;
}

export type Phase = "off" | "scheduled" | "live" | "ended";
/** Stato di un avviso in un istante: spento, programmato, in corso, scaduto. */
export function phaseOf(a: Announcement, now: number): Phase {
  if (!a.active) return "off";
  const s = time(a.startsAt), e = time(a.endsAt);
  if (!Number.isNaN(s) && now < s) return "scheduled";
  if (!Number.isNaN(e) && now >= e) return "ended";
  return "live";
}

const RANK: Record<Level, number> = { maintenance: 0, warning: 1, info: 2 };

/**
 * Avvisi da mostrare ora a un utente: in corso, per tutti o per uno dei suoi ruoli, non chiusi da lui
 * (gli avvisi non chiudibili restano sempre). Prima la manutenzione, poi attenzione, poi informazioni; i più recenti prima.
 */
export function visibleAnnouncements(list: Announcement[], roles: string[], now: number, dismissed: Set<string> = new Set()): Announcement[] {
  return list
    .filter((a) => phaseOf(a, now) === "live")
    .filter((a) => a.roles.length === 0 || a.roles.some((r) => roles.includes(r)))
    .filter((a) => !a.dismissible || !dismissed.has(dismissKey(a)))
    .sort((a, b) => RANK[a.level] - RANK[b.level] || String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

/** Chiave di chiusura: cambia se l'avviso viene modificato, così una nuova versione ricompare. */
export const dismissKey = (a: Announcement) => `${a.fid ?? ""}|${a.updatedAt ?? ""}`;

// ---------------------------------------------------------------- chiusure (nel browser: comodità per chi legge)
const KEY = "mapp.dismissedAnnouncements";
export function loadDismissed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch { return new Set(); }
}
export function storeDismissed(s: Set<string>): void {
  try { localStorage.setItem(KEY, JSON.stringify(Array.from(s).slice(-200))); } catch { /* storage non disponibile: l'avviso tornerà alla prossima apertura */ }
}

// ---------------------------------------------------------------- date per i campi del modulo (ora locale del browser)
/** ISO -> valore di <input type="datetime-local"> nell'ora locale. */
export function toLocalInput(iso: string): string {
  const t = time(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** Valore di <input type="datetime-local"> (ora locale) -> ISO in UTC; vuoto o non valido -> "". */
export function fromLocalInput(v: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return "";
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? "" : new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Testo con i link (http/https) resi cliccabili: pezzi di testo e di link, senza HTML. */
export function linkify(text: string): { text: string; href?: string }[] {
  const out: { text: string; href?: string }[] = [];
  const re = /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g;
  let last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(text));) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[0], href: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
