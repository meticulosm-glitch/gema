// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { dashId, deleteDashboard, deleteRule, isConfigLayer, isMissingTable, loadDashboards, loadRules, saveDashboard, saveRule, type DashboardDef } from "../src/configStore";
import { ACC, el, fakeKc, mockFetch, XSD } from "./support";

const feats = (...p: Record<string, unknown>[]) => JSON.stringify({ features: p.map((properties, i) => ({ id: `t.${i + 1}`, geometry: null, properties })) });
const RULES_XSD = XSD("role_rules", el("role", "xsd:string") + el("layers", "xsd:string") + el("tools", "xsd:string"), "http://x/test");
const OK = `<wfs:SUCCESS/>`;
const T = { ...ACC, workspace: "test" };

describe("isMissingTable / dashId / isConfigLayer", () => {
  it("isMissingTable riconosce gli errori da 'layer inesistente'", () => {
    for (const m of ["Feature type test:role_rules unknown", "Could not find type", "not found", "no such table", "Tabella non trovata"]) expect(isMissingTable(new Error(m))).toBe(true);
    expect(isMissingTable(new Error("HTTP 500"))).toBe(false);
    expect(isMissingTable("Unknown")).toBe(true);
    expect(isMissingTable(undefined)).toBe(false);
  });
  it("dashId prende l'ultimo pezzo dell'fid", () => {
    expect(dashId("dashboards.12")).toBe("12");
    expect(dashId("12")).toBe("12");
    expect(dashId(undefined)).toBe("");
  });
  it("isConfigLayer: solo le due tabelle del workspace di configurazione, non il resto del workspace", () => {
    expect(isConfigLayer(T, "test:role_rules")).toBe(true);
    expect(isConfigLayer(T, "test:dashboards")).toBe(true);
    expect(isConfigLayer(T, "test:strade")).toBe(false);
    expect(isConfigLayer(T, "iride:role_rules")).toBe(false);
  });
});

describe("loadRules", () => {
  it("legge il layer del workspace configurato e decodifica il JSON", async () => {
    const f = mockFetch(() => ({ body: feats({ role: "viewer", layers: '["iride:a","*"]', tools: '["info","table"]', updated_by: "pippo" }) }));
    const r = await loadRules("/geoserver", null, T);
    expect(String(f.mock.calls[0][0])).toContain("typeName=test%3Arole_rules");
    expect(r).toEqual([{ fid: "t.1", role: "viewer", layers: ["iride:a", "*"], tools: ["info", "table"], updatedBy: "pippo", updatedAt: undefined }]);
  });
  it("scarta strumenti sconosciuti, JSON rotto, valori non stringa e righe senza ruolo", async () => {
    mockFetch(() => ({ body: feats(
      { role: "a", layers: "non json", tools: '["info","hack","edit"]' },
      { role: "b", layers: '[1,"x:y",null]', tools: "{}" },
      { role: "", layers: "[]", tools: "[]" },
      {},
    ) }));
    const r = await loadRules("/g", null, ACC);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ role: "a", layers: [], tools: ["info", "edit"] });
    expect(r[1]).toMatchObject({ role: "b", layers: ["x:y"], tools: [] });
  });
  it("propaga l'errore se il layer non esiste", async () => {
    mockFetch(() => ({ status: 400, body: "<ServiceException>Feature type test:role_rules unknown</ServiceException>" }));
    const e = await loadRules("/g", null, ACC).catch((x) => x);
    expect(isMissingTable(e)).toBe(true);
  });
});

describe("loadDashboards", () => {
  it("decodifica i widget, ordina per titolo e tollera dati sporchi", async () => {
    const w = [{ id: "1", type: "kpi", title: "K", layer: "a:b", agg: "count", w: 1 }];
    mockFetch(() => ({ body: feats(
      { title: "Zeta", description: "d", roles: '["viewer"]', definition: JSON.stringify(w) },
      { title: "Alfa", roles: "rotto", definition: "{}" },
      { description: "x" },
    ) }));
    const d = await loadDashboards("/g", null, ACC);
    expect(d.map((x) => x.title)).toEqual(["(senza titolo)", "Alfa", "Zeta"]);
    expect(d.find((x) => x.title === "Zeta")).toMatchObject({ fid: "t.1", description: "d", roles: ["viewer"], widgets: w });
    expect(d.find((x) => x.title === "Alfa")).toMatchObject({ roles: [], widgets: [], description: "" });
  });
});

describe("scrittura", () => {
  let f: ReturnType<typeof mockFetch>;
  beforeEach(() => {
    f = mockFetch((u, init) => ((init as RequestInit | undefined)?.method === "POST" ? { body: OK } : { body: RULES_XSD }));
  });
  const post = () => String(f.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === "POST")![1]!.body);

  it("saveRule nuova: Insert con ruolo, layer e strumenti in JSON, autore dal token", async () => {
    await saveRule("/geoserver-w1", fakeKc({ preferred_username: "pippo" }), T, { role: "fss-etl-viewer", layers: ["iride:a"], tools: ["info"] });
    const x = post();
    expect(x).toContain("<wfs:Insert><test:role_rules>");
    expect(x).toContain("<test:role>fss-etl-viewer</test:role>");
    expect(x).toContain("<test:layers>[&quot;iride:a&quot;]</test:layers>"); // le virgolette del JSON sono protette nell'XML
    expect(x).toContain("<test:tools>");
    expect(x).toContain("<test:updated_by>pippo</test:updated_by>");
    expect(x).toMatch(/<test:updated_at>\d{4}-\d\d-\d\dT/);
  });
  it("saveRule esistente: Update per fid, senza toccare il ruolo", async () => {
    await saveRule("/geoserver-w2", null, T, { fid: "role_rules.4", role: "x", layers: ["*"], tools: [] });
    const x = post();
    expect(x).toContain('<wfs:Update typeName="test:role_rules">');
    expect(x).toContain('<ogc:FeatureId fid="role_rules.4"/>');
    expect(x).not.toContain("<wfs:Name>role</wfs:Name>");
    expect(x).toContain("<wfs:Name>layers</wfs:Name>");
  });
  it("valori con caratteri XML sono protetti", async () => {
    const d: DashboardDef = { title: "A & <B>", description: 'd"q', roles: ["v"], widgets: [] };
    await saveDashboard("/geoserver-w3", null, T, d);
    const x = post();
    expect(x).toContain("A &amp; &lt;B&gt;");
    expect(x).toContain("d&quot;q");
    expect(x).not.toContain("<B>");
  });
  it("delete: Delete per fid, rule e dashboard", async () => {
    await deleteRule("/geoserver-w4", null, T, "role_rules.9");
    expect(post()).toContain('<wfs:Delete typeName="test:role_rules"><ogc:Filter><ogc:FeatureId fid="role_rules.9"/>');
    await deleteDashboard("/geoserver-w4", null, T, "dashboards.2");
    expect(f.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === "POST")).toHaveLength(2);
  });
  it("se il proxy rifiuta la scrittura l'errore arriva al chiamante", async () => {
    mockFetch((u, init) => ((init as RequestInit | undefined)?.method === "POST" ? { status: 403 } : { body: RULES_XSD }));
    await expect(saveRule("/geoserver-w5", null, T, { role: "x", layers: [], tools: [] })).rejects.toThrow(/403/);
  });
});

