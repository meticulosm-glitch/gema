// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  FORMAT, SECTIONS, applyRestore, backupName, collect, exportBackup, missingLayersIn, parseBackup, planRestore, planSize, type Snapshot,
} from "../src/backup";
import { ACC, el, fakeKc, mockFetch, XSD } from "./support";

const T = { ...ACC, workspace: "bk" };
const NS = "http://x/bk";
const OK = "<wfs:WFS_TransactionResponse><wfs:SUCCESS/></wfs:WFS_TransactionResponse>";
const W = { id: "w1", type: "kpi", title: "K", layer: "ws:a", agg: "count", w: 1 };
const FILE = (sections: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({ format: FORMAT, version: 1, exportedAt: "2026-10-20T10:00:00Z", source: "dev", workspace: "bk", sections, ...extra });

describe("file", () => {
  it("export: solo le sezioni scelte e lette, senza id, autore e data", () => {
    const data: Snapshot = { rules: [{ fid: "role_rules.1", role: "ops", layers: ["*"], tools: ["info"], updatedBy: "ada", updatedAt: "x" } as never], dashboards: [] };
    const f = exportBackup(data, ["rules", "dashboards", "forms"], "host", "bk", new Date("2026-10-20T10:00:00Z"));
    expect(f).toEqual({ format: FORMAT, version: 1, exportedAt: "2026-10-20T10:00:00.000Z", source: "host", workspace: "bk", sections: { rules: [{ role: "ops", layers: ["*"], tools: ["info"] }], dashboards: [] } });
    expect(backupName("gema.example.it:8443", new Date("2026-10-20T10:05:00Z"))).toBe("gema-config-gema.example.it_8443-2026-10-20-10-05.json");
  });

  it("lettura: ogni sezione ripulita; righe non valide e doppioni scartati con avviso", () => {
    const { file, warnings } = parseBackup(FILE({
      rules: [{ role: " ops ", layers: ["*", 3], tools: ["info", "boh"] }, { role: "" }, { role: "ops", layers: [] }],
      roleViews: [{ role: "ops", bbox: [9, 45, 10, 46], basemap: " osm ", layers: ["ws:a"] }, { role: "x", bbox: "rotto" }],
      dashboards: [{ title: "D", roles: ["v"], widgets: [W, { type: "boh" }], filters: { area: true, x: 1 } }],
      catalogFolders: [{ key: "f", parent: "f", title: "F", position: "2", expanded: true }, { key: "g" }],
      catalogLayers: [{ layer: "ws:a", folder: "f", hidden: true, defaultOn: true }],
      forms: [{ layer: "ws:a", fields: [{ name: "n", required: true }] }, { layer: "ws:b", fields: [] }],
      announcements: [{ message: "M", level: "maintenance", dismissible: true, startsAt: "domani" }],
      sconosciuta: [1],
    }));
    const sec = file.sections;
    expect(sec.rules).toEqual([{ role: "ops", layers: ["*"], tools: ["info"] }]);
    expect(sec.roleViews).toEqual([{ role: "ops", bbox: [9, 45, 10, 46], basemap: "osm", layers: ["ws:a"] }, { role: "x", basemap: "", layers: [] }]);
    expect(sec.dashboards![0]).toMatchObject({ title: "D", roles: ["v"], filters: { area: true } });
    expect((sec.dashboards![0] as any).widgets).toHaveLength(1);
    expect(sec.catalogFolders).toEqual([{ key: "f", parent: "", title: "F", description: "", position: 2, expanded: true, hidden: false }]);
    expect(sec.catalogLayers).toEqual([{ layer: "ws:a", folder: "f", position: 0, title: "", description: "", hidden: true, defaultOn: false }]);
    expect(sec.forms).toHaveLength(1);
    expect(sec.announcements).toEqual([{ message: "M", level: "maintenance", startsAt: "", endsAt: "", roles: [], dismissible: false, active: true }]);
    expect(Object.keys(sec)).not.toContain("sconosciuta");
    expect(warnings).toEqual([
      "Regole dei ruoli: 1 righe non valide scartate.", "Regole dei ruoli: 1 doppioni scartati (conta la prima).",
      "Catalogo: cartelle: 1 righe non valide scartate.", "Moduli di modifica: 1 righe non valide scartate.",
    ]);
  });

  it("file non utilizzabili", () => {
    expect(() => parseBackup("{")).toThrow(/JSON valido/);
    expect(() => parseBackup(JSON.stringify({ format: "gema-dashboards" }))).toThrow(/sole dashboard/);
    expect(() => parseBackup(JSON.stringify({ format: "altro" }))).toThrow(/non è un backup/);
    expect(() => parseBackup(FILE({}, { version: 9 }))).toThrow(/versione più recente/);
    expect(() => parseBackup(FILE({ boh: [] }))).toThrow(/non contiene sezioni/);
  });
});

describe("piano di ripristino", () => {
  const cur: Snapshot = {
    rules: [{ fid: "role_rules.1", role: "ops", layers: ["*"], tools: [] }, { fid: "role_rules.2", role: "old", layers: ["ws:a"], tools: [] }] as never,
    forms: [{ fid: "edit_forms.1", layer: "ws:a", fields: [{ name: "n" }] }] as never,
  };
  const inc: Snapshot = {
    rules: [{ role: "ops", layers: ["*"], tools: ["info"] }, { role: "new", layers: ["ws:z"], tools: [] }] as never,
    forms: [{ layer: "ws:a", fields: [{ name: "n" }] }] as never,
  };
  it("aggiungi e aggiorna: nuovi, modificati, uguali; niente eliminazioni", () => {
    const p = planRestore(cur, inc, ["rules", "forms", "dashboards"], "merge");
    expect(p.map((x) => [x.id, x.insert.length, x.update.length, x.remove.length, x.same])).toEqual([["rules", 1, 1, 0, 0], ["forms", 0, 0, 0, 1]]);
    expect(p[0].update[0]).toMatchObject({ fid: "role_rules.1", row: { role: "ops", tools: ["info"] } });
    expect(planSize(p)).toBe(2);
  });
  it("sostituisci: elimina ciò che non è nel file, solo nelle sezioni scelte", () => {
    const p = planRestore(cur, inc, ["rules"], "replace");
    expect(p[0].remove.map((r) => r.fid)).toEqual(["role_rules.2"]);
    expect(planRestore(cur, inc, ["forms"], "replace")[0].remove).toEqual([]);
  });
  it("layer citati e non pubblicati", () => {
    expect(missingLayersIn(inc, ["rules", "forms"], new Set(["ws:a"]))).toEqual(["ws:z"]);
  });
  it("chiavi e colonne per sezione", () => {
    expect(SECTIONS.dashboards.cols({ title: " D ", description: "", roles: ["v"], widgets: [W], filters: { area: true } })).toEqual({ title: "D", description: "", roles: '["v"]', definition: JSON.stringify({ widgets: [W], filters: { area: true } }) });
    expect(SECTIONS.roleViews.cols({ role: "r", basemap: "", layers: [] })).toEqual({ role: "r", bbox: "", basemap: "", layers: "[]" });
    expect(SECTIONS.announcements.cols({ message: "m", level: "maintenance", startsAt: "", endsAt: "", roles: [], dismissible: true, active: true }).dismissible).toBe("false");
  });
});

describe("lettura e scrittura", () => {
  const xsd = (t: string, cols: string[]) => XSD(t, cols.map((c) => el(c, "xsd:string")).join(""), NS);
  const routes = (gs: string, features: Record<string, unknown[]> = {}) => {
    const posts: string[] = [];
    mockFetch((u, init) => {
      if (init?.method === "POST") { posts.push(String(init.body)); return { body: OK }; }
      const t = decodeURIComponent(u).match(/typeName=bk:(\w+)/)?.[1] ?? "";
      if (u.includes("DescribeFeatureType")) return { body: xsd(t, ["role", "layers", "tools", "layer", "definition", "updated_by", "updated_at"]) };
      if (t === "announcements") return { status: 400, body: "<ServiceExceptionReport><ServiceException>Feature type bk:announcements unknown</ServiceException></ServiceExceptionReport>" };
      return { body: JSON.stringify({ features: (features[t] ?? []).map((p, i) => ({ id: `${t}.${i + 1}`, geometry: null, properties: p })) }) };
    });
    return posts;
  };

  it("collect: tutte le sezioni; quelle che non si leggono restano fuori con il motivo", async () => {
    routes("/gs-c", { role_rules: [{ role: "ops", layers: '["*"]', tools: "[]" }] });
    const r = await collect("/gs-c", null, T);
    expect(r.data.rules).toEqual([expect.objectContaining({ fid: "role_rules.1", role: "ops", layers: ["*"] })]);
    expect(r.data.dashboards).toEqual([]);
    expect(r.data.announcements).toBeUndefined();
    expect(r.errors.announcements).toMatch(/unknown/);
  });

  it("applyRestore: una transazione; prima eliminazioni firmate, poi modifiche, poi inserimenti, con autore", async () => {
    const posts = routes("/gs-a");
    const plan = [
      { id: "rules" as const, insert: [{ role: "new", layers: ["ws:z"], tools: [] }], update: [{ fid: "role_rules.1", row: { role: "ops", layers: ["*"], tools: ["info"] }, before: {} }], remove: [{ fid: "role_rules.2", role: "old" }], same: 0 },
      { id: "forms" as const, insert: [{ layer: "ws:b", fields: [{ name: "n" }] }], update: [], remove: [], same: 3 },
    ];
    expect(await applyRestore("/gs-a", fakeKc({ preferred_username: "dora" }), T, plan as never)).toBe(4);
    expect(posts).toHaveLength(1);
    const b = posts[0];
    const order = ['<wfs:Delete typeName="bk:role_rules">', '<wfs:Update typeName="bk:role_rules"><wfs:Property><wfs:Name>role</wfs:Name>', "<wfs:Insert><bk:role_rules>", "<wfs:Insert><bk:edit_forms>"].map((x) => b.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(b.indexOf('<wfs:Update typeName="bk:role_rules"><wfs:Property><wfs:Name>updated_by</wfs:Name><wfs:Value>dora</wfs:Value>')).toBeLessThan(b.indexOf("<wfs:Delete")); // firma prima dell'eliminazione
    expect(b).toContain("<bk:layer>ws:b</bk:layer><bk:definition>[{&quot;name&quot;:&quot;n&quot;}]</bk:definition><bk:updated_by>dora</bk:updated_by>");
    expect(await applyRestore("/gs-a", null, T, [{ id: "rules", insert: [], update: [], remove: [], same: 2 }])).toBe(0);
    expect(posts).toHaveLength(1);
  });
});
