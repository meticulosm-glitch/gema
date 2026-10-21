// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageTracker, insertTx, sessionId, startUsage, stopUsage, track, type UsageOptions } from "../src/usage";
import { fillDays, groupTop, loadUsage, periodFrom } from "../src/usageStats";
import { ACC, el, fakeKc, mockFetch, XSD } from "./support";

const T = { ...ACC, workspace: "us" };
const XS = XSD("usage_events", ["at", "session", "username", "roles", "kind", "target", "detail"].map((c) => el(c, "xsd:string")).join(""), "http://x/us");
const OK = new Response("<wfs:WFS_TransactionResponse><wfs:SUCCESS/></wfs:WFS_TransactionResponse>");
let n = 0;
const opts = (extra: Partial<UsageOptions> = {}): UsageOptions => {
  mockFetch(() => ({ body: XS }));
  return { gs: `/gs-${++n}`, kc: fakeKc({ preferred_username: "ada" }, "tok"), acc: T, mode: "anonymous", roles: ["viewer"], intervalMs: 3_600_000, now: () => new Date("2026-10-20T10:00:00Z"), post: vi.fn(async () => OK.clone()), ...extra };
};

beforeEach(() => sessionStorage.clear());
afterEach(() => { stopUsage(); vi.useRealTimers(); });

describe("sessione e transazione", () => {
  it("id di sessione casuale, stabile nella scheda", () => {
    const a = sessionId();
    expect(a.length).toBeGreaterThanOrEqual(8);
    expect(sessionId()).toBe(a);
    sessionStorage.clear();
    expect(sessionId()).not.toBe(a);
  });
  it("un solo Insert per gruppo di eventi, testo con escape", () => {
    const xml = insertTx({ prefix: "us", ns: "http://x/us", typeName: "usage_events", geomName: "", geomType: "", fields: [] },
      [{ at: "t1", kind: "layer", target: "ws:<a>", detail: "" }, { at: "t2", kind: "page", target: "mappa", detail: "" }], { session: "s1234567", username: "", roles: ["r&d"] });
    expect(xml.match(/<wfs:Insert>/g)).toHaveLength(1);
    expect(xml.match(/<us:usage_events>/g)).toHaveLength(2);
    expect(xml).toContain("<us:target>ws:&lt;a&gt;</us:target>");
    expect(xml).toContain("<us:roles>[&quot;r&amp;d&quot;]</us:roles>");
    expect(xml).toContain("<us:username></us:username>");
  });
});

describe("tracker", () => {
  it("accumula e invia a gruppi; anonimo senza nome utente", async () => {
    const o = opts({ batchSize: 3 });
    const t = new UsageTracker(o);
    t.add("page", "mappa"); t.add("layer", "ws:a");
    expect(o.post).not.toHaveBeenCalled();
    t.add("tool", "length");
    await t.flush();
    expect(o.post).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(o.post!).mock.calls[0];
    expect(url).toBe(`${o.gs}/wfs`);
    expect(init.headers).toMatchObject({ Authorization: "Bearer tok", "Content-Type": "text/xml" });
    expect(String(init.body).match(/<us:usage_events>/g)).toHaveLength(3);
    expect(String(init.body)).toContain("<us:username></us:username>");
    expect(String(init.body)).toContain("<us:at>2026-10-20T10:00:00.000Z</us:at>");
    expect(t.sent).toBe(3);
    expect(t.pending()).toBe(0);
    t.stop();
  });
  it("con nome utente in modalità named; testo tagliato a 200", async () => {
    const o = opts({ mode: "named" });
    const t = new UsageTracker(o);
    t.add("dashboard", "x".repeat(300));
    await t.flush();
    const body = String(vi.mocked(o.post!).mock.calls[0][1].body);
    expect(body).toContain("<us:username>ada</us:username>");
    expect(body).toContain(`<us:target>${"x".repeat(200)}</us:target>`);
    t.stop();
  });
  it("doppioni ravvicinati contati una volta", async () => {
    let now = Date.parse("2026-10-20T10:00:00Z");
    const o = opts({ now: () => new Date(now) });
    const t = new UsageTracker(o);
    t.add("page", "mappa"); now += 500; t.add("page", "mappa"); now += 3000; t.add("page", "mappa");
    expect(t.pending()).toBe(2);
    t.stop();
  });
  it("spento: nessun invio; tabella mancante o scrittura negata: si ferma e svuota la coda", async () => {
    const off = new UsageTracker(opts({ mode: "off" }));
    off.add("page", "x");
    expect(off.pending()).toBe(0);
    const o = opts({ post: vi.fn(async () => new Response("", { status: 403 })) });
    const t = new UsageTracker(o);
    t.add("page", "x"); await t.flush();
    expect(t.disabled).toBe(true);
    t.add("page", "y"); await t.flush();
    expect(o.post).toHaveBeenCalledTimes(1);
    const missing = opts();
    mockFetch(() => ({ body: '<ServiceExceptionReport><ServiceException>Feature type us:usage_events unknown</ServiceException></ServiceExceptionReport>' }));
    const t2 = new UsageTracker(missing);
    t2.add("page", "x"); await t2.flush();
    expect(t2.disabled).toBe(true);
    expect(missing.post).not.toHaveBeenCalled();
  });
  it("errori temporanei: dopo 3 di fila si ferma; transazione FAILED conta come errore", async () => {
    const o = opts({ post: vi.fn(async () => new Response("<wfs:FAILED/>")) });
    const t = new UsageTracker(o);
    for (let i = 0; i < 3; i++) { t.add("page", `p${i}`); await t.flush(); }
    expect(t.disabled).toBe(true);
    expect(t.sent).toBe(0);
  });
  it("invio periodico e all'uscita dalla pagina (keepalive)", async () => {
    vi.useFakeTimers();
    const o = opts({ intervalMs: 1000 });
    const t = startUsage(o);
    track("page", "mappa");
    await vi.advanceTimersByTimeAsync(1100);
    expect(o.post).toHaveBeenCalledTimes(1);
    expect(vi.mocked(o.post!).mock.calls[0][1].keepalive).toBe(false);
    track("layer", "ws:a");
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(10);
    expect(o.post).toHaveBeenCalledTimes(2);
    expect(vi.mocked(o.post!).mock.calls[1][1].keepalive).toBe(true);
    stopUsage();
    track("page", "dopo");
    expect(t.pending()).toBe(0);
  });
  it("track senza raccolta avviata: nessun effetto", () => {
    expect(() => track("page", "x")).not.toThrow();
  });
});

describe("statistiche", () => {
  it("periodo e giorni a zero", () => {
    expect(periodFrom(7, new Date("2026-10-20T23:00:00Z"))).toEqual({ from: "2026-10-14", to: "2026-10-20" });
    expect(fillDays([{ day: "2026-10-19", events: 5, sessions: 2, users: 1 }], "2026-10-18", "2026-10-20").map((d) => [d.day, d.sessions])).toEqual([["2026-10-18", 0], ["2026-10-19", 2], ["2026-10-20", 0]]);
  });
  it("raggruppa per tipo e oggetto sommando i giorni; ordina per eventi", () => {
    const g = groupTop([
      { kind: "layer", target: "a", events: 2, sessions: 1, users: 0 }, { kind: "layer", target: "b", events: 5, sessions: 2, users: 0 },
      { kind: "layer", target: "a", events: 4, sessions: 2, users: 0 }, { kind: "tool", target: "length", events: 1, sessions: 1, users: 0 },
    ]);
    expect(g.layer!.map((r) => [r.target, r.events, r.sessions])).toEqual([["a", 6, 3], ["b", 5, 2]]);
    expect(g.tool).toHaveLength(1);
  });
  it("loadUsage: le quattro viste filtrate per giorno; totali, ruoli, utenti", async () => {
    const f = mockFetch((u) => {
      const fc = (rows: Record<string, unknown>[]) => ({ body: JSON.stringify({ features: rows.map((p, i) => ({ id: `x.${i}`, geometry: null, properties: p })) }) });
      if (u.includes("usage_sessions")) return fc([{ day: "2026-10-19Z", events: 10, sessions: 3, users: 2 }, { day: "2026-10-20", events: 4, sessions: 1, users: 1 }]);
      if (u.includes("usage_daily")) return fc([{ day: "2026-10-19", kind: "layer", target: "ws:a", events: 3, sessions: 2, users: 0 }]);
      if (u.includes("usage_roles")) return fc([{ day: "2026-10-19", role: "v", events: 8, sessions: 2 }, { day: "2026-10-20", role: "v", events: 4, sessions: 1 }, { day: "2026-10-20", role: "a", events: 1, sessions: 1 }]);
      return fc([{ day: "2026-10-19", username: "ada", events: 3, sessions: 1 }, { day: "2026-10-20", username: "ada", events: 1, sessions: 1 }, { day: "2026-10-20", username: "bea", events: 9, sessions: 3 }]);
    });
    const r = await loadUsage("/gs", null, T, 7, new Date("2026-10-20T12:00:00Z"));
    expect(f.mock.calls.map((c) => decodeURIComponent(String(c[0])))).toEqual(expect.arrayContaining([expect.stringContaining("typeName=us:usage_sessions"), expect.stringContaining("cql_filter=day >= '2026-10-14'")]));
    expect(r.days).toHaveLength(7);
    expect(r.totals).toEqual({ events: 14, sessions: 4, users: 2 });
    expect(r.byKind.layer).toEqual([{ target: "ws:a", events: 3, sessions: 2, users: 0 }]);
    expect(r.roles).toEqual([{ role: "v", events: 12, sessions: 3 }, { role: "a", events: 1, sessions: 1 }]);
    expect(r.users).toEqual([{ username: "bea", events: 9, sessions: 3, days: 1, last: "2026-10-20" }, { username: "ada", events: 4, sessions: 2, days: 2, last: "2026-10-20" }]);
  });
});
