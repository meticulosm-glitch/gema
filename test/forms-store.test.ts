// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { deleteEditForm, isConfigLayer, loadEditForm, loadEditForms, saveEditForm } from "../src/configStore";
import { ACC, el, fakeKc, mockFetch, XSD } from "./support";

const T = { ...ACC, workspace: "ef" };
const FORMS_XSD = XSD("edit_forms", el("layer", "xsd:string") + el("definition", "xsd:string"), "http://x/ef");
const OK = "<wfs:WFS_TransactionResponse><wfs:SUCCESS/></wfs:WFS_TransactionResponse>";
const fc = (rows: Record<string, unknown>[]) => JSON.stringify({ features: rows.map((p, i) => ({ id: `edit_forms.${i + 1}`, geometry: null, properties: p })) });

describe("edit_forms", () => {
  it("è una tabella di configurazione", () => expect(isConfigLayer(T, "ef:edit_forms")).toBe(true));

  it("loadEditForms: definizioni ripulite, righe senza layer scartate, ordine per layer", async () => {
    mockFetch(() => ({ body: fc([
      { layer: "z:b", definition: '[{"name":"x","required":true},{"nome":"sbagliato"}]', updated_by: "ada" },
      { layer: "a:a", definition: "rotto" },
      { layer: "", definition: "[]" },
    ]) }));
    expect(await loadEditForms("/gs-f1", null, T)).toEqual([
      { fid: "edit_forms.2", layer: "a:a", fields: [], updatedBy: undefined, updatedAt: undefined },
      { fid: "edit_forms.1", layer: "z:b", fields: [{ name: "x", required: true }], updatedBy: "ada", updatedAt: undefined },
    ]);
  });

  it("loadEditForm: filtro CQL sul layer (con l'apice raddoppiato); nessuna riga = null", async () => {
    const f = mockFetch(() => ({ body: fc([]) }));
    expect(await loadEditForm("/gs-f2", null, T, "ws:l'apice")).toBeNull();
    const url = decodeURIComponent(String(f.mock.calls[0][0]));
    expect(url).toContain("typeName=ef:edit_forms");
    expect(url).toContain("cql_filter=layer = 'ws:l''apice'");
    expect(url).toContain("maxFeatures=1");
  });

  it("saveEditForm: inserisce (con il layer) o aggiorna (senza) la definizione JSON; nessuna regola = elimina", async () => {
    const posts: string[] = [];
    mockFetch((url, init) => {
      if (init?.method === "POST") { posts.push(String(init.body)); return { body: OK }; }
      return { body: FORMS_XSD };
    });
    await saveEditForm("/gs-f3", fakeKc({ preferred_username: "ada" }), T, { layer: "iride:parcels", fields: [{ name: "kind", alias: "Tipo <&>" }] });
    expect(posts[0]).toContain("<wfs:Insert><ef:edit_forms><ef:layer>iride:parcels</ef:layer>");
    expect(posts[0]).toContain("<ef:definition>[{&quot;name&quot;:&quot;kind&quot;,&quot;alias&quot;:&quot;Tipo &lt;&amp;&gt;&quot;}]</ef:definition>"); // JSON con l'escape XML
    expect(posts[0]).toContain("<ef:updated_by>ada</ef:updated_by>");
    await saveEditForm("/gs-f3", null, T, { fid: "edit_forms.4", layer: "iride:parcels", fields: [{ name: "kind", required: true }] });
    expect(posts[1]).toContain('<wfs:Update typeName="ef:edit_forms">');
    expect(posts[1]).not.toContain("<wfs:Name>layer</wfs:Name>");
    await saveEditForm("/gs-f3", null, T, { fid: "edit_forms.4", layer: "iride:parcels", fields: [] });
    expect(posts[2]).toContain('<wfs:Delete typeName="ef:edit_forms"><ogc:Filter><ogc:FeatureId fid="edit_forms.4"/>');
    await saveEditForm("/gs-f3", null, T, { layer: "nuovo:x", fields: [] });
    expect(posts).toHaveLength(3); // niente da eliminare né da scrivere
    await deleteEditForm("/gs-f3", null, T, "edit_forms.9");
    expect(posts[3]).toContain('fid="edit_forms.9"');
  });
});
