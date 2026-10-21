// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config";
import {
  checkBasemaps, checkDiscovery, checkGeoServer, checkRefresh, checkTable, checkToken, checkWrite, configSummary, redirectInfo, reportText, runChecks,
  sampleTile, sortResults, summary, writeProbe, type DiagContext,
} from "../src/diagnostics";
import { CONFIG_COLUMNS, CONFIG_TABLES } from "../src/configStore";
import { configMapData } from "./integration/support";
import { ACC, el, fakeKc, mockFetch, XSD } from "./support";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const claims = (extra: Record<string, unknown> = {}) => ({
  preferred_username: "ada", azp: "mapp", iss: "https://kc/realms/r", exp: NOW / 1000 + 600, iat: NOW / 1000 - 60,
  resource_access: { mapp: { roles: [ACC.adminRole] } }, realm_access: { roles: ["offline_access"] }, ...extra,
});
const cfg: AppConfig = { apiUrl: "", geoserverUrl: "/geoserver", basemapTiles: "https://t/{z}/{x}/{y}.png", mapCenter: [12, 42], mapZoom: 5, keycloak: { url: "https://kc/", realm: "r", clientId: "mapp" }, access: ACC, basemaps: [{ id: "osm", label: "Mappa", tiles: "https://{s}.t/{z}/{x}/{y}.png" }, { id: "none", label: "Nessuno" }] };
const ctx = (extra: Partial<DiagContext> = {}, c = claims()): DiagContext => {
  const kc = fakeKc(c, "segreto-token");
  kc.updateToken = vi.fn(async () => true);
  return { cfg, acc: ACC, gs: "https://app/geoserver", kc, origin: "https://app", now: () => NOW, loadImage: async () => {}, timeoutMs: 500, ...extra };
};
const cols = (t: string) => CONFIG_COLUMNS[t].map((c) => el(c, "xsd:string")).join("");
const OK_TX = "<wfs:WFS_TransactionResponse><wfs:SUCCESS/></wfs:WFS_TransactionResponse>";

describe("configurazione", () => {
  it("riassunto dei valori letti", () => {
    const r = configSummary(ctx());
    expect(r.status).toBe("info");
    expect(r.detail).toContain("GeoServer: https://app/geoserver");
    expect(r.detail).toContain("Keycloak: https://kc/ · realm r · client mapp");
    expect(r.detail).toContain(`Workspace delle tabelle: ${ACC.workspace}`);
    expect(r.detail).toContain("Sfondi: 2; ricerca luoghi: spenta");
  });
  it("le colonne attese sono quelle create da mapp-config.sql", () => {
    const sql = configMapData()["mapp-config.sql"];
    for (const t of CONFIG_TABLES.filter((x) => !/^usage_(daily|sessions|roles|users)$/.test(x))) { // le viste sotto
      const m = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS :"schema"\\.${t} \\(([\\s\\S]*?)\\n\\s*\\);`));
      expect(m, t).toBeTruthy();
      const names = m![1].split("\n").map((l) => l.trim().match(/^([a-z_]+)\s+(text|serial|bigserial|integer|boolean|timestamptz)/)?.[1]).filter((n): n is string => !!n && n !== "id");
      expect(names, t).toEqual(CONFIG_COLUMNS[t]);
    }
    for (const v of ["usage_daily", "usage_sessions", "usage_roles", "usage_users"]) {
      const m = sql.match(new RegExp(`CREATE OR REPLACE VIEW :"schema"\\.${v} AS\\s+SELECT ([\\s\\S]*?)\\s+FROM`));
      expect(m, v).toBeTruthy();
      const names = Array.from(m![1].matchAll(/AS (\w+)|(?:^|,\s*)(?:\w+\.)?(kind|role|username)(?=\s*,|$)|coalesce\(target, ''\) AS (\w+)/g)).map((x) => x[1] ?? x[2] ?? x[3]);
      expect(names, v).toEqual(CONFIG_COLUMNS[v]);
    }
  });
});

describe("GeoServer", () => {
  it("WMS e WFS: numero di layer con il token; senza layer è un avviso", async () => {
    const f = mockFetch((u) => ({ body: u.includes("WMS") ? '<Layer queryable="1"/><Layer queryable="1"/><Layer>gruppo</Layer>' : "<FeatureType/>" }));
    const [wms, wfs] = await checkGeoServer(ctx());
    expect(wms).toMatchObject({ id: "gs-wms", status: "ok", detail: "2 layer WMS visibili con il tuo token" });
    expect(wfs).toMatchObject({ id: "gs-wfs", status: "ok", detail: "1 tipi WFS visibili con il tuo token" });
    expect((f.mock.calls[0][1] as RequestInit).headers).toEqual({ Authorization: "Bearer segreto-token" });
    mockFetch(() => ({ body: "<WFS_Capabilities/>" }));
    expect((await checkGeoServer(ctx()))[1]).toMatchObject({ status: "warn", hint: expect.stringContaining("regole dati") });
  });
  it("errori: HTTP, eccezione OGC, nessuna risposta", async () => {
    mockFetch(() => ({ status: 502, body: "bad gateway" }));
    expect((await checkGeoServer(ctx()))[0]).toMatchObject({ status: "fail", detail: "HTTP 502", hint: expect.stringContaining("GEOSERVER_PROXY_URL") });
    mockFetch(() => ({ body: "<ServiceExceptionReport/>" }));
    expect((await checkGeoServer(ctx()))[0].detail).toMatch(/eccezione/);
    mockFetch(() => new Promise(() => {}));
    expect((await checkGeoServer(ctx({ timeoutMs: 20 })))[0].detail).toMatch(/nessuna risposta/);
  });
});

describe("tabelle", () => {
  it("pubblicata, con tutte le colonne e leggibile", async () => {
    mockFetch((u) => ({ body: u.includes("DescribeFeatureType") ? XSD("role_rules", cols("role_rules")) : JSON.stringify({ features: [] }) }));
    expect(await checkTable(ctx(), "role_rules")).toMatchObject({ id: "table-role_rules", label: `${ACC.workspace}:role_rules`, status: "ok", detail: "5 colonne, lettura consentita" });
  });
  it("colonne mancanti: avviso con il rimedio", async () => {
    mockFetch((u) => ({ body: u.includes("DescribeFeatureType") ? XSD("dashboards", el("title", "xsd:string") + el("roles", "xsd:string")) : JSON.stringify({ features: [] }) }));
    expect(await checkTable(ctx(), "dashboards")).toMatchObject({ status: "warn", detail: "Colonne mancanti: description, definition, updated_by, updated_at", hint: expect.stringContaining("Riesegui il Job") });
  });
  it("non leggibile, non pubblicata, altro errore", async () => {
    mockFetch((u) => (u.includes("DescribeFeatureType") ? { body: XSD("role_rules", cols("role_rules")) } : { status: 403, body: "" }));
    expect(await checkTable(ctx(), "role_rules")).toMatchObject({ status: "fail", detail: expect.stringContaining("non leggibile"), hint: expect.stringContaining("SET_ACL") });
    mockFetch(() => ({ body: '<ServiceExceptionReport><ServiceException>Feature type mapp:x unknown</ServiceException></ServiceExceptionReport>' }));
    expect(await checkTable(ctx(), "dashboard_drafts")).toMatchObject({ status: "fail", detail: "Non pubblicata in GeoServer." });
    mockFetch(() => ({ status: 500, body: "boom" }));
    expect(await checkTable(ctx(), "role_rules")).toMatchObject({ status: "fail", detail: "HTTP 500" });
  });
  it("prova di scrittura: Update che non trova righe", async () => {
    const xml = writeProbe("mapp", 'http://x/"ns', "role_rules");
    expect(xml).toContain('xmlns:mapp="http://x/&quot;ns"');
    expect(xml).toContain('<wfs:Update typeName="mapp:role_rules">');
    expect(xml).toContain("<ogc:Literal>__gema_diagnostica__</ogc:Literal>");
    expect(xml).not.toMatch(/Insert|Delete/);
    const posts: string[] = [];
    mockFetch((u, init) => { if (init?.method === "POST") { posts.push(String(init.body)); return { body: OK_TX }; } return { body: XSD("role_rules", cols("role_rules"), "http://x/mapp") }; });
    expect(await checkWrite(ctx())).toMatchObject({ status: "ok", detail: expect.stringContaining("nessuna riga cambiata") });
    expect(posts[0]).toContain('xmlns:mapp="http://x/mapp"');
    mockFetch((u, init) => (init?.method === "POST" ? { status: 403, body: "" } : { body: XSD("role_rules", cols("role_rules")) }));
    expect(await checkWrite(ctx())).toMatchObject({ status: "fail", detail: expect.stringContaining("403"), hint: expect.stringContaining("GEOSERVER_WRITE_PASSTHROUGH") });
  });
});

describe("token e Keycloak", () => {
  it("ruoli, scadenza; nessun avviso se tutto è a posto", () => {
    const r = checkToken(ctx());
    expect(r.map((x) => [x.id, x.status])).toEqual([["token-roles", "ok"], ["token-exp", "ok"]]);
    expect(r[0].detail).toBe(`Utente: ada\nClient role di mapp: ${ACC.adminRole}\nRealm role: offline_access`);
    expect(r[1].detail).toBe("Scade tra 10 min (si rinnova da solo).");
  });
  it("ruolo admin assente, ruoli su un altro client, client diverso, orologio avanti", () => {
    const r = checkToken(ctx({}, claims({ resource_access: { altro: { roles: [ACC.adminRole] } }, azp: "altro", iat: NOW / 1000 + 300, exp: NOW / 1000 - 1 })));
    expect(r.map((x) => [x.id, x.status])).toEqual([["token-roles", "warn"], ["token-azp", "warn"], ["token-exp", "warn"], ["clock", "warn"]]);
    expect(r[0].detail).toContain("Ruoli di altri client (ignorati): altro");
    expect(r[0].hint).toContain("client role del client mapp");
    expect(r[3].detail).toContain("300 s nel futuro");
  });
  it("discovery: issuer uguale, diverso, errore, Keycloak non configurato", async () => {
    const f = mockFetch(() => ({ body: JSON.stringify({ issuer: "https://kc/realms/r" }) }));
    expect(await checkDiscovery(ctx())).toMatchObject({ status: "ok", detail: "Issuer https://kc/realms/r" });
    expect(String(f.mock.calls[0][0])).toBe("https://kc/realms/r/.well-known/openid-configuration");
    mockFetch(() => ({ body: JSON.stringify({ issuer: "http://interno:8080/realms/r" }) }));
    expect(await checkDiscovery(ctx())).toMatchObject({ status: "warn", hint: expect.stringContaining("KEYCLOAK_URL") });
    mockFetch(() => { throw new TypeError("Failed to fetch"); });
    expect(await checkDiscovery(ctx())).toMatchObject({ status: "fail", detail: expect.stringContaining("Failed to fetch"), hint: expect.stringContaining("Web origins") });
    expect(await checkDiscovery(ctx({ cfg: { ...cfg, keycloak: undefined } }))).toMatchObject({ status: "skip" });
  });
  it("rinnovo del token forzato; rifiutato = indicazione su Web origins", async () => {
    const c = ctx();
    expect(await checkRefresh(c)).toMatchObject({ status: "ok" });
    expect(c.kc.updateToken).toHaveBeenCalledWith(-1);
    (c.kc.updateToken as any).mockRejectedValue(undefined);
    expect(await checkRefresh(c)).toMatchObject({ status: "fail", detail: "Rinnovo rifiutato.", hint: expect.stringContaining("https://app") });
  });
  it("indirizzi da mettere nel client", () => {
    expect(redirectInfo(ctx()).detail).toBe("Valid redirect URIs: https://app/*\nValid post logout redirect URIs: https://app/*\nWeb origins: https://app");
  });
});

describe("sfondi", () => {
  it("un tile per sfondo; sfondo vuoto saltato", async () => {
    expect(sampleTile("https://{s}.t/{z}/{x}/{y}{r}.png")).toBe("https://a.t/0/0/0.png");
    const loaded: string[] = [];
    const r = await checkBasemaps(ctx({ loadImage: async (u) => { loaded.push(u); if (u.includes("rotto")) throw new Error("tile non caricato"); } }));
    expect(r.map((x) => [x.label, x.status])).toEqual([["Mappa", "ok"], ["Nessuno", "skip"]]);
    expect(loaded).toEqual(["https://a.t/0/0/0.png"]);
    const bad = await checkBasemaps(ctx({ cfg: { ...cfg, basemaps: [{ id: "x", label: "X", tiles: "https://rotto/{z}/{x}/{y}" }] }, loadImage: async () => { throw new Error("tile non caricato"); } }));
    expect(bad[0]).toMatchObject({ status: "fail", hint: expect.stringContaining("BASEMAPS") });
  });
});

describe("insieme", () => {
  it("tutti i controlli, risultati parziali man mano, ordine stabile, riepilogo e rapporto senza token", async () => {
    mockFetch((u, init) => {
      if (init?.method === "POST") return { body: OK_TX };
      if (u.includes("GetCapabilities")) return { body: '<Layer queryable="1"/><FeatureType/>' };
      if (u.includes(".well-known")) return { body: JSON.stringify({ issuer: "https://kc/realms/r" }) };
      const t = CONFIG_TABLES.find((x) => u.includes(`%3A${x}`) && !u.includes(`%3A${x}_`)) ?? "role_rules";
      return { body: u.includes("DescribeFeatureType") ? XSD(t, cols(t)) : JSON.stringify({ features: [] }) };
    });
    const partial: number[] = [];
    const all = await runChecks(ctx(), (r) => partial.push(r.length));
    expect(partial.length).toBeGreaterThan(3);
    expect(partial.at(-1)).toBe(all.length);
    expect(all.map((r) => r.group)).toEqual(sortResults(all).map((r) => r.group));
    expect(all[0].id).toBe("config");
    expect(all.filter((r) => r.group === "Tabelle di configurazione").map((r) => r.id)).toEqual([...CONFIG_TABLES.map((t) => `table-${t}`), "write"]);
    expect(summary(all)).toMatchObject({ fail: 0, warn: 0, info: 2, skip: 1 });
    const txt = reportText(all, new Date(NOW), "https://app");
    expect(txt.startsWith("Diagnostica Gema · https://app · 2026-10-20T12:00:00.000Z")).toBe(true);
    expect(txt).toContain("## Tabelle di configurazione");
    expect(txt).toMatch(/\[OK\] Scrittura \(WFS-T\) \(\d+ ms\)/);
    expect(txt).not.toContain("segreto-token");
  });
});
