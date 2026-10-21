// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  byNewest, changedFields, entryName, isCurrent, loadChangeLog, logCql, restoreVersion, toEntry, versionOf, type ChangeEntry,
} from "../src/changeLog";
import { deleteRule, isConfigLayer } from "../src/configStore";
import { ACC, el, fakeKc, mockFetch, XSD } from "./support";

const T = { ...ACC, workspace: "cl" };
const F = (id: number, p: Record<string, unknown>) => ({ id: `change_log.${id}`, geometry: null, properties: p });
const E = (seq: number, extra: Partial<ChangeEntry>): ChangeEntry => ({ fid: `change_log.${seq}`, seq, table: "role_rules", rowId: 1, op: "UPDATE", old: null, new: null, changedBy: "ada", dbUser: "gs", changedAt: "2026-10-20T10:00:00Z", ...extra });
const RULE_XSD = XSD("role_rules", ["role", "layers", "tools", "updated_by", "updated_at"].map((c) => el(c, "xsd:string")).join(""), "http://x/cl");
const OK = "<wfs:WFS_TransactionResponse><wfs:SUCCESS/></wfs:WFS_TransactionResponse>";

describe("lettura", () => {
  it("è una tabella di configurazione (non compare in mappa)", () => expect(isConfigLayer(T, "cl:change_log")).toBe(true));

  it("voci: JSON delle righe, valori mancanti, voci non valide scartate", () => {
    expect(toEntry(F(7, { table_name: "dashboards", row_id: "3", op: "UPDATE", old_data: '{"id":3,"title":"A"}', new_data: '{"id":3,"title":"B"}', changed_by: "ada", db_user: "gs", changed_at: "2026-10-20T10:00:00Z" })))
      .toEqual({ fid: "change_log.7", seq: 7, table: "dashboards", rowId: 3, op: "UPDATE", old: { id: 3, title: "A" }, new: { id: 3, title: "B" }, changedBy: "ada", dbUser: "gs", changedAt: "2026-10-20T10:00:00Z" });
    expect(toEntry(F(8, { table_name: "x", op: "INSERT", old_data: null, new_data: "rotto", row_id: null }))).toMatchObject({ old: null, new: null, rowId: null, changedBy: "" });
    expect(toEntry(F(9, { op: "TRUNCATE" }))).toBeNull();
  });

  it("ordine: più recenti prima; nella stessa transazione l'ultima scritta prima", () => {
    const l = [E(1, { changedAt: "2026-10-20T10:00:00Z" }), E(3, { changedAt: "2026-10-20T09:00:00Z" }), E(2, { changedAt: "2026-10-20T10:00:00Z" })].sort(byNewest);
    expect(l.map((e) => e.seq)).toEqual([2, 1, 3]);
  });

  it("filtri in CQL: tabella, riga, utente, periodo (fine compresa), apici", () => {
    expect(logCql({})).toBe("");
    expect(logCql({ table: "role_rules", rowId: 4.7, user: " o'neil ", from: "2026-10-01", to: "2026-10-31" }))
      .toBe("table_name = 'role_rules' AND row_id = 4 AND changed_by = 'o''neil' AND changed_at >= '2026-10-01T00:00:00Z' AND changed_at < '2026-11-01T00:00:00Z'");
    expect(logCql({ from: "ieri" })).toBe("");
  });

  it("loadChangeLog: WFS 2.0 ordinato dal server, testo cercato anche nei dati, limite segnalato", async () => {
    const f = mockFetch(() => ({ body: JSON.stringify({ features: [
      F(1, { table_name: "role_rules", row_id: 1, op: "INSERT", new_data: '{"id":1,"role":"ops"}', changed_by: "ada", changed_at: "2026-10-20T09:00:00Z" }),
      F(2, { table_name: "dashboards", row_id: 2, op: "UPDATE", old_data: '{"id":2,"title":"Acqua"}', new_data: '{"id":2,"title":"Aria"}', changed_by: "bea", changed_at: "2026-10-20T10:00:00Z" }),
    ] }) }));
    const r = await loadChangeLog("/gs", null, T, { table: "dashboards", text: "acqua" }, 2);
    const url = decodeURIComponent(String(f.mock.calls[0][0]));
    expect(url).toContain("version=2.0.0&request=GetFeature&typeNames=cl:change_log");
    expect(url).toContain("count=2&sortBy=changed_at DESC");
    expect(url).toContain("cql_filter=table_name = 'dashboards'");
    expect(r.entries.map((e) => e.seq)).toEqual([2]);
    expect(r.capped).toBe(true);
  });
});

describe("cosa è cambiato", () => {
  const upd = E(1, { old: { id: 1, role: "ops", tools: "[]", layers: '["*"]', updated_by: "ada" }, new: { id: 1, role: "ops", tools: '["info"]', layers: '["*"]', updated_by: "bea" } });
  it("modifica: solo i campi cambiati, timbri esclusi", () => {
    expect(changedFields(upd)).toEqual([{ field: "tools", before: "[]", after: '["info"]' }]);
  });
  it("creazione ed eliminazione: tutti i campi, un lato solo", () => {
    expect(changedFields(E(2, { op: "INSERT", new: { id: 1, role: "x", updated_at: "t" } }))).toEqual([{ field: "role", before: undefined, after: "x" }]);
    expect(changedFields(E(3, { op: "DELETE", old: { id: 1, role: "x" } }))).toEqual([{ field: "role", before: "x", after: undefined }]);
  });
  it("nome dell'elemento per tabella, accorciato", () => {
    expect(entryName(upd)).toBe("ops");
    expect(entryName(E(4, { table: "announcements", new: { message: "x".repeat(80) } }))).toBe(`${"x".repeat(57)}…`);
    expect(entryName(E(5, { table: "dashboards", op: "DELETE", old: { title: "Vecchia" } }))).toBe("Vecchia");
    expect(entryName(E(6, { new: {} }))).toBe("#1");
  });
  it("versione e stato attuale", () => {
    expect(versionOf(upd)).toBe(upd.new);
    expect(versionOf(E(7, { op: "DELETE", old: { a: 1 } }))).toEqual({ a: 1 });
    const later = E(8, { changedAt: "2026-10-20T11:00:00Z" });
    expect(isCurrent(upd, [upd, later])).toBe(false);
    expect(isCurrent(later, [upd, later])).toBe(true);
    expect(isCurrent(E(9, { op: "DELETE" }), [E(9, { op: "DELETE" })])).toBe(false);
  });
});

describe("ripristino", () => {
  const routes = (current: Record<string, unknown> | null) => {
    const posts: string[] = [];
    const f = mockFetch((u, init) => {
      if (init?.method === "POST") { posts.push(String(init.body)); return { body: OK }; }
      if (u.includes("DescribeFeatureType")) return { body: RULE_XSD };
      return { body: JSON.stringify({ features: current ? [{ id: "role_rules.1", geometry: null, properties: current }] : [] }) };
    });
    return { posts, f };
  };
  const v = E(1, { op: "UPDATE", new: { id: 1, role: "ops", layers: ["*"], tools: "[]", updated_by: "ada", extra: "ignorato" } });

  it("la riga esiste: Update delle sole colonne note, autore e data di chi ripristina", async () => {
    const { posts, f } = routes({ role: "ops", layers: '["a"]', tools: '["info"]' });
    expect(await restoreVersion("/gs-r1", fakeKc({ preferred_username: "dora" }), T, v)).toBe("updated");
    expect(String(f.mock.calls[1][0])).toContain("featureId=role_rules.1");
    const b = posts[0];
    expect(b).toContain('<wfs:Update typeName="cl:role_rules">');
    expect(b).toContain("<wfs:Name>layers</wfs:Name><wfs:Value>[&quot;*&quot;]</wfs:Value>"); // jsonb array -> testo JSON
    expect(b).toContain("<wfs:Name>tools</wfs:Name><wfs:Value>[]</wfs:Value>");
    expect(b).toContain("<wfs:Name>updated_by</wfs:Name><wfs:Value>dora</wfs:Value>");
    expect(b).not.toContain("extra");
    expect(b).toContain('<ogc:FeatureId fid="role_rules.1"/>');
  });

  it("la riga non c'è più: Insert; già uguale: nessuna scrittura", async () => {
    let r = routes(null);
    expect(await restoreVersion("/gs-r2", fakeKc({}), T, E(2, { op: "DELETE", old: { id: 1, role: "ops", layers: '["*"]', tools: "[]" } }))).toBe("inserted");
    expect(r.posts[0]).toContain("<wfs:Insert><cl:role_rules><cl:role>ops</cl:role><cl:layers>[&quot;*&quot;]</cl:layers><cl:tools>[]</cl:tools>");
    r = routes({ role: "ops", layers: '["*"]', tools: "[]", updated_by: "x" });
    expect(await restoreVersion("/gs-r3", fakeKc({}), T, v)).toBe("unchanged");
    expect(r.posts).toHaveLength(0);
  });

  it("voci non ripristinabili", async () => {
    await expect(restoreVersion("/gs-r4", null, T, E(3, { table: "saved_views", new: { a: 1 } }))).rejects.toThrow(/non si può ripristinare/);
    await expect(restoreVersion("/gs-r4", null, T, E(4, { op: "INSERT", new: null }))).rejects.toThrow();
  });
});

describe("eliminazioni firmate", () => {
  it("prima il timbro di chi elimina, poi la Delete, nella stessa transazione", async () => {
    const posts: string[] = [];
    mockFetch((u, init) => { if (init?.method === "POST") { posts.push(String(init.body)); return { body: OK }; } return { body: RULE_XSD }; });
    await deleteRule("/gs-del", fakeKc({ preferred_username: "cleo" }), T, "role_rules.5");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/<wfs:Update typeName="cl:role_rules"><wfs:Property><wfs:Name>updated_by<\/wfs:Name><wfs:Value>cleo<\/wfs:Value>.*<ogc:FeatureId fid="role_rules.5"\/><\/ogc:Filter><\/wfs:Update><wfs:Delete typeName="cl:role_rules">/);
  });
  it("tabelle senza updated_by (viste salvate): solo la Delete", async () => {
    const posts: string[] = [];
    mockFetch((u, init) => { if (init?.method === "POST") { posts.push(String(init.body)); return { body: OK }; } return { body: XSD("saved_views", el("owner", "xsd:string") + el("name", "xsd:string"), "http://x/cl") }; });
    const { deleteView } = await import("../src/configStore");
    await deleteView("/gs-del2", fakeKc({ preferred_username: "cleo" }), T, "saved_views.2");
    expect(posts[0]).not.toContain("<wfs:Update");
    expect(posts[0]).toContain('<wfs:Delete typeName="cl:saved_views">');
  });
});
