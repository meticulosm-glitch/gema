// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { deleteRoleSettings, isConfigLayer, loadRoleViews, saveRoleSettings } from "../src/configStore";
import { ACC, el, fakeKc, mockFetch, XSD } from "./support";

const T = { ...ACC, workspace: "rv" };
const NS = "http://x/rv";
const RULES_XSD = XSD("role_rules", el("role", "xsd:string") + el("layers", "xsd:string") + el("tools", "xsd:string"), NS);
const VIEWS_XSD = XSD("role_views", ["role", "bbox", "basemap", "layers"].map((n) => el(n, "xsd:string")).join(""), NS);
const OK = "<wfs:WFS_TransactionResponse><wfs:SUCCESS/></wfs:WFS_TransactionResponse>";
const fc = (rows: Record<string, unknown>[]) => JSON.stringify({ features: rows.map((p, i) => ({ id: `role_views.${i + 1}`, geometry: null, properties: p })) });

/** fetch finto: schemi delle due tabelle, transazioni registrate. */
const routes = (gs: string) => {
  const posts: string[] = [];
  mockFetch((url, init) => {
    if (init?.method === "POST") { posts.push(String(init.body)); return { body: OK }; }
    if (url.includes("DescribeFeatureType")) return { body: url.includes("role_views") ? VIEWS_XSD : RULES_XSD };
    return { body: "{}" };
  });
  return { posts, gs };
};

describe("role_views", () => {
  it("è una tabella di configurazione (mai in mappa)", () => {
    expect(isConfigLayer(T, "rv:role_views")).toBe(true);
  });

  it("loadRoleViews: riquadri e JSON ripuliti, righe senza ruolo scartate, ordine per ruolo", async () => {
    const f = mockFetch(() => ({ body: fc([
      { role: "z-ops", bbox: "9,45,10,46", basemap: " sat ", layers: '["a"]', updated_by: "ada" },
      { role: "a-viewer", bbox: "rotto", basemap: null, layers: "non json" },
      { role: "", bbox: "", basemap: "", layers: "[]" },
    ]) }));
    const v = await loadRoleViews("/gs-load", null, T);
    expect(String(f.mock.calls[0][0])).toContain("typeName=rv%3Arole_views");
    expect(v).toEqual([
      { fid: "role_views.2", role: "a-viewer", basemap: "", layers: [], updatedBy: undefined, updatedAt: undefined },
      { fid: "role_views.1", role: "z-ops", bbox: [9, 45, 10, 46], basemap: "sat", layers: ["a"], updatedBy: "ada", updatedAt: undefined },
    ]);
  });

  it("saveRoleSettings: regola nuova e vista nuova nella stessa transazione", async () => {
    const { posts } = routes("/gs-a");
    await saveRoleSettings("/gs-a", fakeKc({ preferred_username: "ada" }), T, { role: "ops", layers: ["*"], tools: ["info"] }, { role: "ops", bbox: [9, 45, 10.5, 46], basemap: "grigio", layers: ["iride:ndvi"] });
    expect(posts).toHaveLength(1);
    const b = posts[0];
    expect(b.match(/<wfs:Insert>/g)).toHaveLength(2);
    expect(b).toContain("<wfs:Insert><rv:role_rules><rv:role>ops</rv:role>");
    expect(b).toContain("<rv:role_views><rv:role>ops</rv:role><rv:bbox>9,45,10.5,46</rv:bbox><rv:basemap>grigio</rv:basemap>");
    expect(b).toContain("<rv:layers>[&quot;iride:ndvi&quot;]</rv:layers><rv:updated_by>ada</rv:updated_by>");
  });

  it("saveRoleSettings: aggiorna le righe esistenti senza riscrivere il ruolo; vista vuota = riga eliminata", async () => {
    const { posts } = routes("/gs-b");
    await saveRoleSettings("/gs-b", null, T, { fid: "role_rules.4", role: "ops", layers: ["a"], tools: [] }, { fid: "role_views.7", role: "ops", basemap: "", layers: ["a"] });
    expect(posts[0]).toContain('<wfs:Update typeName="rv:role_views">');
    expect(posts[0]).toContain("<wfs:Name>bbox</wfs:Name><wfs:Value></wfs:Value>");
    expect(posts[0]).not.toContain("<wfs:Name>role</wfs:Name>");
    await saveRoleSettings("/gs-b", null, T, { fid: "role_rules.4", role: "ops", layers: ["a"], tools: [] }, { fid: "role_views.7", role: "ops", basemap: " ", layers: [] });
    expect(posts[1]).toContain('<wfs:Delete typeName="rv:role_views"><ogc:Filter><ogc:FeatureId fid="role_views.7"/></ogc:Filter></wfs:Delete>');
    // vista vuota e mai salvata: nessuna operazione sulla tabella delle viste
    await saveRoleSettings("/gs-b", null, T, { role: "nuovo", layers: ["a"], tools: [] }, { role: "nuovo", basemap: "", layers: [] });
    expect(posts[2]).not.toContain("role_views");
    // vista non gestita (tabella mancante): solo la regola
    await saveRoleSettings("/gs-b", null, T, { role: "x", layers: ["a"], tools: [] });
    expect(posts[3]).not.toContain("role_views");
    expect(posts[3]).toContain("<wfs:Insert>");
  });

  it("deleteRoleSettings: regola e vista insieme; niente da eliminare = nessuna richiesta", async () => {
    const { posts } = routes("/gs-c");
    await deleteRoleSettings("/gs-c", null, T, "role_rules.1", "role_views.2");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('fid="role_rules.1"');
    expect(posts[0]).toContain('fid="role_views.2"');
    await deleteRoleSettings("/gs-c", null, T, "role_rules.3");
    expect(posts[1]).not.toContain("role_views");
    await deleteRoleSettings("/gs-c", null, T);
    expect(posts).toHaveLength(2);
  });
});
