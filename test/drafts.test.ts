// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  deleteDashboardAndDraft, deleteDashboardDraft, isConfigLayer, loadDashboardDrafts, publishDashboard, saveDashboardDraft, type DashboardDef, type DashboardDraft,
} from "../src/configStore";
import { draftChanges, editorContent, itemStatus, mergeItems, previewNotes, sameContent } from "../src/dashDrafts";
import { computePermissions } from "../src/roles";
import { ACC, el, fakeKc, mockFetch, XSD } from "./support";

const T = { ...ACC, workspace: "dr" };
const NS = "http://x/dr";
const COLS = ["title", "description", "roles", "definition", "updated_by", "updated_at"];
const DASH_XSD = XSD("dashboards", COLS.map((n) => el(n, "xsd:string")).join(""), NS);
const DRAFT_XSD = XSD("dashboard_drafts", ["dashboard_id", ...COLS].map((n) => el(n, "xsd:string")).join(""), NS);
const ok = (ids: string[] = []) => `<wfs:WFS_TransactionResponse xmlns:wfs="w" xmlns:ogc="o"><wfs:InsertResult>${(ids.length ? ids : ["none"]).map((i) => `<ogc:FeatureId fid="${i}"/>`).join("")}</wfs:InsertResult><wfs:SUCCESS/></wfs:WFS_TransactionResponse>`;
const routes = (ids: string[] = []) => {
  const posts: string[] = [];
  mockFetch((url, init) => {
    if (init?.method === "POST") { posts.push(String(init.body)); return { body: ok(ids) }; }
    if (url.includes("DescribeFeatureType")) return { body: url.includes("dashboard_drafts") ? DRAFT_XSD : DASH_XSD };
    return { body: "{}" };
  });
  return posts;
};
const W = (id: string, extra = {}) => ({ id, type: "kpi" as const, title: id, layer: "ws:a", agg: "count" as const, w: 1 as const, ...extra });
const D = (title: string, extra: Partial<DashboardDef> = {}): DashboardDef => ({ title, description: "", roles: ["v"], widgets: [W("a")], ...extra });
const DR = (fid: string, dashboardId: string, def: DashboardDef): DashboardDraft => ({ fid, dashboardId, def });

describe("bozze: lettura e scrittura", () => {
  it("è una tabella di configurazione", () => expect(isConfigLayer(T, "dr:dashboard_drafts")).toBe(true));

  it("loadDashboardDrafts: definizione con filtri, id della pubblicata ripulito, ordine per titolo", async () => {
    mockFetch(() => ({ body: JSON.stringify({ features: [
      { id: "dashboard_drafts.2", geometry: null, properties: { dashboard_id: " 7 ", title: "Zeta", roles: '["v"]', definition: JSON.stringify({ widgets: [W("a")], filters: { area: true } }), updated_by: "ada" } },
      { id: "dashboard_drafts.3", geometry: null, properties: { dashboard_id: null, title: "Alfa", description: null, roles: "rotto", definition: "rotto" } },
    ] }) }));
    const l = await loadDashboardDrafts("/gs-l", null, T);
    expect(l.map((d) => [d.fid, d.dashboardId, d.def.title])).toEqual([["dashboard_drafts.3", "", "Alfa"], ["dashboard_drafts.2", "7", "Zeta"]]);
    expect(l[0].def).toMatchObject({ description: "", roles: [], widgets: [] });
    expect(l[1].def).toMatchObject({ filters: { area: true }, widgets: [W("a")] });
    expect(l[1].updatedBy).toBe("ada");
  });

  it("saveDashboardDraft: nuova (con id della pubblicata) restituisce il fid; esistente non riscrive dashboard_id", async () => {
    let posts = routes(["dashboard_drafts.9"]);
    expect(await saveDashboardDraft("/gs-s1", fakeKc({ preferred_username: "ada" }), T, { dashboardId: "4", def: D(" Bozza ", { filters: { area: true } }) })).toBe("dashboard_drafts.9");
    expect(posts[0]).toContain("<wfs:Insert><dr:dashboard_drafts><dr:dashboard_id>4</dr:dashboard_id><dr:title>Bozza</dr:title>");
    expect(posts[0]).toContain("&quot;filters&quot;:{&quot;area&quot;:true}");
    expect(posts[0]).toContain("<dr:updated_by>ada</dr:updated_by>");
    posts = routes();
    expect(await saveDashboardDraft("/gs-s2", null, T, { fid: "dashboard_drafts.9", dashboardId: "4", def: D("B") })).toBe("dashboard_drafts.9");
    expect(posts[0]).toContain('<wfs:Update typeName="dr:dashboard_drafts">');
    expect(posts[0]).not.toContain("dashboard_id");
  });

  it("publishDashboard: inserisce la nuova ed elimina la bozza nella stessa transazione; restituisce il fid", async () => {
    const posts = routes(["dashboards.12"]);
    expect(await publishDashboard("/gs-p1", null, T, D("Nuova"), "dashboard_drafts.3")).toBe("dashboards.12");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/<wfs:Insert><dr:dashboards><dr:title>Nuova<\/dr:title>.*<wfs:Delete typeName="dr:dashboard_drafts"><ogc:Filter><ogc:FeatureId fid="dashboard_drafts.3"\/>/);
  });

  it("publishDashboard: aggiorna la pubblicata; senza bozza nessuna eliminazione", async () => {
    const posts = routes();
    expect(await publishDashboard("/gs-p2", null, T, D("V2", { fid: "dashboards.4" }))).toBe("dashboards.4");
    expect(posts[0]).toContain('<wfs:Update typeName="dr:dashboards">');
    expect(posts[0]).toContain('<ogc:FeatureId fid="dashboards.4"/>');
    expect(posts[0]).not.toContain("Delete");
  });

  it("scarta ed elimina", async () => {
    let posts = routes();
    await deleteDashboardDraft("/gs-d1", null, T, "dashboard_drafts.3");
    expect(posts[0]).toContain('<wfs:Delete typeName="dr:dashboard_drafts"><ogc:Filter><ogc:FeatureId fid="dashboard_drafts.3"/>');
    posts = routes();
    await deleteDashboardAndDraft("/gs-d2", null, T, "dashboards.4", "dashboard_drafts.5");
    expect(posts).toHaveLength(1);
    expect(posts[0].match(/<wfs:Delete/g)).toHaveLength(2);
    posts = routes();
    await deleteDashboardAndDraft("/gs-d3", null, T, undefined, "dashboard_drafts.5");
    expect(posts[0]).toContain('typeName="dr:dashboard_drafts"');
    expect(posts[0]).not.toContain('typeName="dr:dashboards"');
    posts = routes();
    await deleteDashboardAndDraft("/gs-d4", null, T);
    expect(posts).toHaveLength(0);
  });
});

describe("elenco e stato", () => {
  const pubA = D("Alfa", { fid: "dashboards.1" });
  const pubB = D("Beta", { fid: "dashboards.2" });
  it("pubblicate con la loro bozza, bozze nuove e bozze rimaste senza dashboard; ordine per titolo", () => {
    const items = mergeItems([pubB, pubA], [DR("dashboard_drafts.1", "2", D("Beta v2")), DR("dashboard_drafts.2", "", D("Gamma")), DR("dashboard_drafts.3", "99", D("Orfana"))]);
    expect(items.map((i) => [i.key, itemStatus(i)])).toEqual([
      ["dashboards.1", "published"], ["dashboards.2", "changed"], ["dashboard_drafts.2", "draft"], ["dashboard_drafts.3", "draft"],
    ]);
  });
  it("nell'editor: la bozza (con il fid della pubblicata) o la pubblicata; senza autore e data", () => {
    const [a, b] = mergeItems([{ ...pubA, updatedBy: "x", updatedAt: "y" }, pubB], [DR("dashboard_drafts.1", "2", D("Beta v2"))]);
    expect(editorContent(a)).toEqual(D("Alfa", { fid: "dashboards.1" }));
    expect(editorContent(b)).toEqual(D("Beta v2", { fid: "dashboards.2" }));
    expect(editorContent(b)).not.toBe(b.draft!.def);
    expect(editorContent({ key: "k", draft: DR("k", "", D("N")) })).not.toHaveProperty("fid");
  });
  it("stesso contenuto: ordine dei ruoli indifferente, widget e filtri contano", () => {
    expect(sameContent(D("a", { roles: ["x", "y"], updatedBy: "u" }), D("a", { roles: ["y", "x"] }))).toBe(true);
    expect(sameContent(D("a"), D("a", { filters: { area: true } }))).toBe(false);
    expect(sameContent(D("a"), D("a", { widgets: [W("a", { title: "z" })] }))).toBe(false);
  });
  it("differenze tra pubblicata e bozza", () => {
    const pub = D("Alfa", { roles: ["v", "x"], widgets: [W("a"), W("b"), W("c")] });
    expect(draftChanges(pub, pub)).toEqual([]);
    const draft = D("Alfa 2", { description: "nuova", roles: ["v", "y"], widgets: [W("c"), W("b", { title: "B" }), W("d"), W("e")], filters: { area: true } });
    expect(draftChanges(pub, draft)).toEqual([
      "titolo («Alfa» → «Alfa 2»)", "descrizione", "ruoli aggiunti: y", "ruoli tolti: x", "2 widget nuovi", "1 widget tolto", "1 widget modificato", "ordine dei widget", "filtri globali",
    ]);
  });
});

describe("anteprima per ruolo", () => {
  const rules = [{ role: "v", layers: ["ws:a"], tools: [] }, { role: "z", layers: ["ws:b"], tools: [] }];
  const d = D("x", { roles: ["v"], widgets: [W("a"), W("b", { layer: "ws:b" }), { ...W("t"), type: "text" as const, layer: "" }], filters: { area: true } });
  it("ruolo assegnato, layer abilitati, area del ruolo", () => {
    expect(previewNotes(d, "v", computePermissions(["v"], rules, ACC), [1, 2, 3, 4])).toEqual([
      { level: "ok", text: "v trova questa dashboard nell'elenco (dopo la pubblicazione)." },
      { level: "warning", text: expect.stringContaining("Layer non abilitati per v nella pagina Ruoli e permessi: ws:b.") },
      { level: "ok", text: "«La mia area» usa l'area della vista iniziale del ruolo: 1,2,3,4." },
    ]);
  });
  it("ruolo non assegnato e senza regole; niente area", () => {
    const n = previewNotes({ ...d, filters: undefined }, "w", computePermissions(["w"], rules, ACC));
    expect(n.map((x) => x.text)).toEqual([
      "Il ruolo w non ha regole: non entra nell'applicazione.",
      "w non è tra i ruoli della dashboard: non la vedrà.",
      expect.stringContaining("ws:a, ws:b"),
    ]);
    expect(previewNotes({ ...d, filters: { area: true } }, "z", computePermissions(["z"], rules, ACC)).at(-1)!.text).toBe("Il ruolo non ha un'area nella vista iniziale: «La mia area» non compare.");
  });
});
