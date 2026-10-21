// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClientErrorReporter, ENDPOINT, MAX_PER_PAGE, currentRelease, defaultSend, ignorable, redact, reportClientError, startClientErrors, stopClientErrors, stripUrl,
} from "../src/clientErrors";

const fixed = () => new Date("2026-10-20T10:00:00Z");
const make = () => {
  const sent: { url: string; body: any }[] = [];
  const r = new ClientErrorReporter((url, body) => sent.push({ url, body: JSON.parse(body) }), "index-abc123.js", fixed, () => "/dashboards/3");
  return { r, sent };
};

afterEach(() => { stopClientErrors(); vi.restoreAllMocks(); });

describe("clientErrors: contenuto della segnalazione", () => {
  it("messaggio, pila, pagina (solo percorso), versione, ora, posizione senza query", () => {
    const { r, sent } = make();
    const e = new TypeError("x is undefined");
    e.stack = "TypeError: x is undefined\n    at f (https://gema.example/assets/index-abc123.js:1:200)";
    expect(r.report("error", e, { source: "https://gema.example/assets/index-abc123.js?v=1#x", line: 1, col: 200 })).toBe(true);
    expect(sent).toEqual([{ url: ENDPOINT, body: {
      kind: "error", message: "TypeError: x is undefined", stack: e.stack, source: "https://gema.example/assets/index-abc123.js",
      line: 1, col: 200, page: "/dashboards/3", release: "index-abc123.js", time: "2026-10-20T10:00:00.000Z",
    } }]);
  });

  it("valori non Error: stringhe, oggetti, undefined", () => {
    const { r, sent } = make();
    r.report("rejection", "rifiutata");
    r.report("rejection", { code: 7 });
    r.report("rejection", undefined);
    r.report("rejection", { message: "" });
    expect(sent.map((s) => s.body.message)).toEqual(["rifiutata", "[object Object]", "undefined", "(senza messaggio)"]);
    expect(sent.every((s) => s.body.stack === undefined && s.body.source === undefined)).toBe(true);
  });

  it("oscura token e credenziali, taglia messaggi e pile lunghe", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhZGEifQ.c2lnbmF0dXJh";
    expect(redact(`fallita ${jwt}`)).toBe("fallita [token]");
    expect(redact("Authorization: Bearer abcdefghijklmnop")).toBe("Authorization: Bearer [token]");
    expect(redact("Basic cmVhZGVyOnJwYXNz")).toBe("Basic [token]");
    expect(redact("/cb#state=1&code=SEGRETO&session_state=x")).toBe("/cb#state=1&code=[oscurato]&session_state=[oscurato]");
    expect(redact("https://x/?access_token=abc&layer=a")).toBe("https://x/?access_token=[oscurato]&layer=a");
    expect(redact("nessun segreto qui")).toBe("nessun segreto qui");
    const { r, sent } = make();
    const e = new Error("m".repeat(2000) + jwt);
    e.stack = "s".repeat(9000);
    r.report("error", e);
    expect(sent[0].body.message).toHaveLength(501);
    expect(sent[0].body.message.endsWith("…")).toBe(true);
    expect(sent[0].body.stack).toHaveLength(4001);
    expect(JSON.stringify(sent[0].body).length).toBeLessThan(16 * 1024); // limite di nginx
  });

  it("stripUrl: via query e frammento", () => {
    expect(stripUrl("https://a/b?c=1#s=2")).toBe("https://a/b");
    expect(stripUrl("/x#y")).toBe("/x");
  });
});

describe("clientErrors: quante e quali", () => {
  it("lo stesso errore conta una volta; al massimo MAX_PER_PAGE per pagina", () => {
    const { r, sent } = make();
    expect(r.report("error", new Error("uguale"), { source: "/a.js", line: 3 })).toBe(true);
    expect(r.report("error", new Error("uguale"), { source: "/a.js", line: 3 })).toBe(false);
    expect(r.report("error", new Error("uguale"), { source: "/a.js", line: 4 })).toBe(true);
    for (let i = 0; i < 30; i++) r.report("error", new Error(`n${i}`));
    expect(sent).toHaveLength(MAX_PER_PAGE);
    expect(r.count).toBe(MAX_PER_PAGE);
  });

  it("ignora errori senza dettagli, estensioni del browser, ResizeObserver", () => {
    expect(ignorable("Script error.")).toBe(true);
    expect(ignorable("Uncaught Script error")).toBe(true);
    expect(ignorable("ResizeObserver loop completed with undelivered notifications.")).toBe(true);
    expect(ignorable("x", "chrome-extension://abc/content.js")).toBe(true);
    expect(ignorable("x", "", "at f (moz-extension://abc/c.js:1:1)")).toBe(true);
    expect(ignorable("TypeError: x")).toBe(false);
    const { r, sent } = make();
    r.report("error", "Script error.");
    expect(sent).toHaveLength(0);
  });

  it("spenta: nessun invio", () => {
    const { r, sent } = make();
    r.disable();
    expect(r.report("error", new Error("x"))).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("clientErrors: eventi della finestra", () => {
  it("errori e promesse rifiutate; le richieste annullate no; detach smette di ascoltare", () => {
    const { r, sent } = make();
    const win = new EventTarget() as unknown as Window; // la finestra vera: vitest tratterebbe gli eventi come errori non gestiti
    const off = r.attach(win);
    win.dispatchEvent(new ErrorEvent("error", { message: "boom", error: new RangeError("boom"), filename: "http://h/assets/i.js?x", lineno: 5, colno: 9 }));
    const rej = (reason: unknown) => { const ev = new Event("unhandledrejection") as PromiseRejectionEvent; Object.defineProperty(ev, "reason", { value: reason }); win.dispatchEvent(ev); };
    rej(new Error("promessa"));
    rej(new DOMException("annullata", "AbortError"));
    expect(sent.map((s) => [s.body.kind, s.body.message, s.body.source ?? "", s.body.line ?? 0])).toEqual([
      ["error", "RangeError: boom", "http://h/assets/i.js", 5],
      ["rejection", "promessa", "", 0],
    ]);
    off();
    win.dispatchEvent(new ErrorEvent("error", { message: "dopo", error: new Error("dopo") }));
    expect(sent).toHaveLength(2);
  });

  it("start/stop/reportClientError a livello di modulo", () => {
    const send = vi.fn();
    startClientErrors(send);
    reportClientError(new Error("config.json non trovato"));
    expect(JSON.parse(send.mock.calls[0][1])).toMatchObject({ kind: "startup", message: "config.json non trovato", release: "dev" });
    stopClientErrors();
    reportClientError(new Error("altro"));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("versione dallo script principale", () => {
    const doc = document.implementation.createHTMLDocument();
    expect(currentRelease(doc)).toBe("dev");
    const s = doc.createElement("script");
    s.type = "module";
    s.src = "http://h/assets/index-Ab12Cd.js?x=1";
    doc.head.appendChild(s);
    expect(currentRelease(doc)).toBe("index-Ab12Cd.js");
  });
});

describe("clientErrors: invio", () => {
  it("sendBeacon con corpo JSON; se rifiuta, fetch keepalive (con il cookie della sessione, serve a oauth2-proxy)", async () => {
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    defaultSend("/client-errors", '{"a":1}');
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, blob] = beacon.mock.calls[0] as unknown as [string, Blob];
    expect(url).toBe("/client-errors");
    expect(blob.type).toBe("application/json");
    expect(await blob.text()).toBe('{"a":1}');
    expect(fetchSpy).not.toHaveBeenCalled();
    beacon.mockReturnValue(false);
    defaultSend("/client-errors", '{"a":2}');
    expect(fetchSpy).toHaveBeenCalledWith("/client-errors", expect.objectContaining({ method: "POST", body: '{"a":2}', keepalive: true, credentials: "same-origin" }));
  });

  it("errori di rete: nessuna eccezione", () => {
    Object.defineProperty(navigator, "sendBeacon", { value: () => { throw new Error("no"); }, configurable: true });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    expect(() => defaultSend("/client-errors", "{}")).not.toThrow();
  });
});
