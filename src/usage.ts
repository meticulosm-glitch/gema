import type Keycloak from "keycloak-js";
import type { AccessConfig } from "./config";
import { describeTable, type Schema } from "./api";
import { isMissingTable } from "./configStore";

/**
 * Statistiche d'uso: il browser raccoglie pochi eventi (pagina aperta, layer acceso, strumento, dashboard, scarico,
 * ricerca, vista salvata) e li aggiunge alla tabella usage_events a gruppi, con una sola transazione WFS-T.
 * Modalità: off, anonymous (ruoli e sessione, nessun nome utente) o named (anche il nome utente).
 * Niente contenuti: della ricerca solo il tipo, dei layer e delle dashboard solo il nome.
 */
export const USAGE_TABLE = "usage_events";
export type UsageKind = "page" | "layer" | "tool" | "dashboard" | "download" | "search" | "view";
export type UsageMode = "off" | "anonymous" | "named";
export interface UsageEvent { at: string; kind: UsageKind; target: string; detail: string }

export interface UsageOptions {
  gs: string;
  kc: Keycloak;
  acc: AccessConfig;
  mode: UsageMode;
  roles: string[];
  batchSize?: number;          // invio quando la coda arriva a tanti eventi (default 20)
  intervalMs?: number;         // invio periodico (default 30 s)
  now?: () => Date;
  post?: (url: string, init: RequestInit) => Promise<Response>;
}

const SESSION_KEY = "gema.usageSession";
const cut = (s: string) => s.trim().slice(0, 200);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Id della sessione: casuale, per scheda del browser (non identifica la persona). */
export function sessionId(): string {
  const make = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`).replace(/-/g, "").slice(0, 32);
  try {
    const v = sessionStorage.getItem(SESSION_KEY);
    if (v && v.length >= 8) return v;
    const n = make(); sessionStorage.setItem(SESSION_KEY, n); return n;
  } catch { return make(); }
}

/** Transazione WFS-T con un Insert per gruppo di eventi. */
export function insertTx(s: Schema, events: UsageEvent[], common: { session: string; username: string; roles: string[] }): string {
  const t = `${s.prefix}:${s.typeName}`;
  const f = (k: string, v: string) => `<${s.prefix}:${k}>${esc(v)}</${s.prefix}:${k}>`;
  const rows = events.map((e) => `<${t}>${f("at", e.at)}${f("session", common.session)}${f("username", common.username)}${f("roles", JSON.stringify(common.roles))}${f("kind", e.kind)}${f("target", e.target)}${f("detail", e.detail)}</${t}>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><wfs:Transaction service="WFS" version="1.0.0" xmlns:wfs="http://www.opengis.net/wfs" xmlns:${s.prefix}="${esc(s.ns)}"><wfs:Insert>${rows}</wfs:Insert></wfs:Transaction>`;
}

export class UsageTracker {
  readonly session = sessionId();
  private queue: UsageEvent[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private schema: Promise<Schema> | null = null;
  private resolved: Schema | null = null;    // lo schema già letto: alla chiusura della pagina si invia senza attese
  private failures = 0;
  private sending: Promise<void> = Promise.resolve();
  private last: { key: string; t: number } | null = null;
  disabled = false;
  sent = 0;

  constructor(private o: UsageOptions) {
    if (o.mode === "off") { this.disabled = true; return; }
    this.timer = setInterval(() => void this.flush(), o.intervalMs ?? 30_000);
    void this.loadSchema().catch(() => {}); // subito: alla chiusura della pagina non c'è tempo per leggerlo
  }

  private loadSchema(): Promise<Schema> {
    const { gs, kc, acc } = this.o;
    this.schema ??= describeTable(gs, kc, `${acc.workspace}:${USAGE_TABLE}`).then((s) => { this.resolved = s; return s; }, (e) => {
      this.schema = null;
      if (isMissingTable(e)) this.stop(); // tabella non pubblicata: per questa sessione niente raccolta
      throw e;
    });
    return this.schema;
  }

  add(kind: UsageKind, target = "", detail = ""): void {
    if (this.disabled) return;
    const now = (this.o.now ?? (() => new Date()))();
    // lo stesso evento ripetuto subito (doppio clic, re-render) conta una volta
    const key = `${kind}|${target}|${detail}`;
    if (this.last && this.last.key === key && now.getTime() - this.last.t < 2000) return;
    this.last = { key, t: now.getTime() };
    this.queue.push({ at: now.toISOString(), kind, target: cut(target), detail: cut(detail) });
    if (this.queue.length >= (this.o.batchSize ?? 20)) void this.flush();
  }

  pending(): number { return this.queue.length; }

  /** Invia la coda. `leaving`: la pagina si sta chiudendo (fetch keepalive, che sopravvive alla chiusura). */
  flush(leaving = false): Promise<void> {
    // alla chiusura la richiesta deve partire adesso, non dopo le attese della catena
    if (leaving) return this.send(true);
    this.sending = this.sending.then(() => this.send(false));
    return this.sending;
  }

  private async send(leaving: boolean): Promise<void> {
    if (this.disabled || this.queue.length === 0) return;
    if (leaving && !this.resolved) return; // senza schema non si può comporre l'inserimento in tempo
    const batch = this.queue.splice(0, leaving ? 100 : 200); // keepalive: corpo sotto i 64 kB
    const { gs, kc, mode, roles } = this.o;
    try {
      const s = this.resolved ?? await this.loadSchema();
      const username = mode === "named" ? String((kc.tokenParsed as any)?.preferred_username ?? "") : "";
      const body = insertTx(s, batch, { session: this.session, username, roles });
      const post = this.o.post ?? ((u, i) => fetch(u, i));
      const req = post(`${gs}/wfs`, { method: "POST", keepalive: leaving, headers: { "Content-Type": "text/xml", ...(kc.token ? { Authorization: `Bearer ${kc.token}` } : {}) }, body });
      const r = await req;
      const text = await r.text().catch(() => "");
      if (!r.ok || /FAILED|ServiceException|ExceptionReport/.test(text)) throw new Error(r.ok ? text.slice(0, 200) : `HTTP ${r.status}`);
      this.failures = 0; this.sent += batch.length;
    } catch (e) {
      // tabella non pubblicata o scrittura negata: per questa sessione non si riprova (niente richieste inutili)
      if (isMissingTable(e) || /HTTP 40[13]|denied|not allowed/i.test(String((e as Error)?.message ?? e)) || ++this.failures >= 3) this.stop();
    }
  }

  stop(): void {
    this.disabled = true;
    this.queue = [];
    if (this.timer) clearInterval(this.timer);
  }
}

// ---------------------------------------------------------------- istanza dell'applicazione
let current: UsageTracker | null = null;
let onHide: (() => void) | null = null;
let onLeave: (() => void) | null = null;

/** Avvia la raccolta (una per pagina). Restituisce il tracker, utile nei test. */
export function startUsage(o: UsageOptions): UsageTracker {
  stopUsage();
  current = new UsageTracker(o);
  if (!current.disabled && typeof document !== "undefined") {
    onHide = () => { if (document.visibilityState === "hidden") void current?.flush(true); };
    onLeave = () => void current?.flush(true);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onLeave);
  }
  return current;
}

export function stopUsage(): void {
  current?.stop();
  current = null;
  if (onHide) document.removeEventListener("visibilitychange", onHide);
  if (onLeave) window.removeEventListener("pagehide", onLeave);
  onHide = null; onLeave = null;
}

/** Registra un evento (senza effetto se la raccolta è spenta). */
export function track(kind: UsageKind, target = "", detail = ""): void { current?.add(kind, target, detail); }
