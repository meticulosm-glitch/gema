/**
 * Segnalazione degli errori del browser: gli errori JavaScript non gestiti (e le promesse rifiutate senza catch) vanno a
 * /client-errors, dove nginx li scrive nel log JSON ("type":"client-error") che Loki raccoglie. Così un errore che
 * l'utente vede solo come "non succede niente" diventa una riga cercabile, con pagina, versione e pila.
 *
 * Niente dati personali: nessun nome utente, nessun token (anche se compare in un messaggio viene oscurato), della pagina
 * solo il percorso (il frammento #s=... contiene la vista e i filtri). Al massimo MAX_PER_PAGE segnalazioni per pagina,
 * le ripetizioni dello stesso errore contano una volta sola.
 */
export const ENDPOINT = "/client-errors";
export const MAX_PER_PAGE = 10;
const MAX_MESSAGE = 500;
const MAX_STACK = 4000;

export interface ClientError {
  kind: "error" | "rejection" | "startup";
  message: string;
  stack?: string;
  source?: string;
  line?: number;
  col?: number;
  page: string;
  release: string;
  time: string;
}

/** Oscura token e credenziali che possono finire in un messaggio (URL con access_token, header Bearer, JWT). */
export function redact(s: string): string {
  return s
    .replace(/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, "[token]")
    .replace(/(bearer|basic)\s+[\w~+/.=-]{8,}/gi, "$1 [token]")
    .replace(/([?&#](?:access_token|refresh_token|id_token|code|session_state|password|token)=)[^&#\s"']*/gi, "$1[oscurato]");
}

/** URL senza query né frammento (la query può contenere filtri, il frammento la vista). */
export const stripUrl = (u: string) => u.replace(/[?#].*$/, "");

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** Errori che non dicono nulla o non sono nostri: script di altri siti senza dettagli, estensioni del browser, avvisi benigni. */
export function ignorable(message: string, source = "", stack = ""): boolean {
  if (/^(Uncaught )?Script error\.?$/.test(message.trim())) return true;
  if (/ResizeObserver loop (limit exceeded|completed with undelivered notifications)/.test(message)) return true;
  return /^(chrome|moz|safari(-web)?)-extension:/.test(source) || /(chrome|moz|safari(-web)?)-extension:\/\//.test(stack);
}

/** Versione della build: il nome con hash dello script principale (cambia a ogni rilascio). */
export function currentRelease(doc: Document = document): string {
  const src = doc.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src ?? "";
  return src.split("/").pop()?.replace(/\?.*$/, "") || "dev";
}

type Send = (url: string, body: string) => void;

/** sendBeacon arriva anche se la pagina si sta chiudendo; altrimenti fetch con keepalive. Stesso sito, con i cookie: davanti a
 * nginx può esserci oauth2-proxy, che senza cookie di sessione rifiuta la richiesta (nginx non li passa oltre). Gli errori di
 * invio si ignorano. */
export const defaultSend: Send = (url, body) => {
  try {
    if (navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }))) return;
  } catch { /* sendBeacon non disponibile o rifiutato */ }
  try {
    void fetch(url, { method: "POST", body, keepalive: true, credentials: "same-origin", headers: { "Content-Type": "application/json" } }).catch(() => undefined);
  } catch { /* niente rete: si perde la segnalazione, non si genera un altro errore */ }
};

export class ClientErrorReporter {
  private seen = new Set<string>();
  private sent = 0;
  private enabled = true;

  constructor(
    private readonly send: Send = defaultSend,
    private readonly release = "dev",
    private readonly now: () => Date = () => new Date(),
    private readonly page: () => string = () => location.pathname,
    private readonly endpoint = ENDPOINT,
  ) {}

  disable(): void { this.enabled = false; }
  get count(): number { return this.sent; }

  report(kind: ClientError["kind"], err: unknown, where: { source?: string; line?: number; col?: number } = {}): boolean {
    if (!this.enabled || this.sent >= MAX_PER_PAGE) return false;
    const e = err as { message?: unknown; stack?: unknown; name?: unknown } | null;
    const raw = e && typeof e === "object" && "message" in e ? String(e.message ?? "") : typeof err === "string" ? err : String(err);
    const name = e && typeof e === "object" && typeof e.name === "string" && e.name !== "Error" && !raw.startsWith(e.name) ? `${e.name}: ` : "";
    const message = cut(redact(name + raw), MAX_MESSAGE) || "(senza messaggio)";
    const stack = e && typeof e === "object" && typeof e.stack === "string" ? cut(redact(e.stack), MAX_STACK) : undefined;
    const source = where.source ? stripUrl(where.source) : undefined;
    if (ignorable(message, source, stack)) return false;
    const key = `${kind}|${message}|${source ?? ""}|${where.line ?? ""}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.sent++;
    const body: ClientError = { kind, message, page: this.page(), release: this.release, time: this.now().toISOString() };
    if (stack) body.stack = stack;
    if (source) body.source = source;
    if (where.line) body.line = where.line;
    if (where.col) body.col = where.col;
    this.send(this.endpoint, JSON.stringify(body));
    return true;
  }

  /** Ascolta gli errori della finestra; restituisce la funzione che smette di ascoltare. */
  attach(win: Window = window): () => void {
    const onError = (ev: ErrorEvent) => {
      // gli errori di caricamento di immagini e script arrivano solo in cattura, non qui: questi sono errori JavaScript
      this.report("error", ev.error ?? ev.message, { source: ev.filename, line: ev.lineno, col: ev.colno });
    };
    const onRejection = (ev: PromiseRejectionEvent) => {
      const r = ev.reason;
      // una richiesta annullata (cambio pagina, nuovo filtro) non è un errore
      if (r && typeof r === "object" && (r as { name?: string }).name === "AbortError") return;
      this.report("rejection", r);
    };
    win.addEventListener("error", onError);
    win.addEventListener("unhandledrejection", onRejection);
    return () => { win.removeEventListener("error", onError); win.removeEventListener("unhandledrejection", onRejection); };
  }
}

let current: ClientErrorReporter | null = null;
let detach: (() => void) | null = null;

/** Avvia la segnalazione (prima di caricare la configurazione: anche un errore di avvio va segnalato). */
export function startClientErrors(send?: Send): ClientErrorReporter {
  stopClientErrors();
  current = new ClientErrorReporter(send, currentRelease());
  detach = current.attach();
  return current;
}

/** Spegne la segnalazione (configurazione clientErrors: false). */
export function stopClientErrors(): void {
  detach?.();
  current?.disable();
  detach = null;
  current = null;
}

/** Segnala un errore gestito ma bloccante (es. l'app non parte). */
export function reportClientError(err: unknown, kind: ClientError["kind"] = "startup"): void {
  current?.report(kind, err);
}
