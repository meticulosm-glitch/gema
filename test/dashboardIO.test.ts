// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { DashboardDef, WidgetDef } from "../src/configStore";
import {
  FORMAT, duplicate, exportDashboards, exportName, missingLayers, parseImport, planImport, remapLayers, sanitizeWidget, unknownRoles,
} from "../src/dashboardIO";
import { importDashboards } from "../src/configStore";
import { ACC, el, fakeKc, mockFetch, XSD } from "./support";

let n = 0;
const uid = () => `u${++n}`;
const W = (id: string, layer = "iride:parcels", extra: Partial<WidgetDef> = {}): WidgetDef => ({ id, type: "kpi", title: id, layer, agg: "count", w: 1, ...extra });
const D = (title: string, extra: Partial<DashboardDef> = {}): DashboardDef => ({ fid: `dashboards.${title.length}`, title, description: "", roles: [], widgets: [W("a")], updatedBy: "ada", ...extra });

describe("esportazione", () => {
  it("formato, versione, provenienza; niente fid né autori", () => {
    const f = exportDashboards([D("Uno", { roles: ["v"] })], "host:1", new Date("2026-10-20T10:00:00Z"));
    expect(f).toEqual({ format: FORMAT, version: 1, exportedAt: "2026-10-20T10:00:00.000Z", source: "host:1", dashboards: [{ title: "Uno", description: "", roles: ["v"], widgets: [W("a")] }] });
  });
  it("nome del file", () => {
    expect(exportName([D("Qualità dell'aria!")])).toBe("dashboard-qualita-dell-aria.json");
    expect(exportName([D("A"), D("B")], new Date("2026-10-20T10:00:00Z"))).toBe("dashboard-2026-10-20.json");
    expect(exportName([D("!!!")], new Date("2026-10-20T10:00:00Z"))).toBe("dashboard-2026-10-20.json");
  });
  it("duplica: copia senza fid, titolo '(copia)', id dei widget nuovi, ruoli copiati non condivisi", () => {
    const src = D("Uno", { roles: ["v"] });
    const c = duplicate(src, uid);
    expect(c.fid).toBeUndefined();
    expect(c.title).toBe("Uno (copia)");
    expect(c.widgets[0].id).not.toBe("a");
    c.roles.push("x");
    expect(src.roles).toEqual(["v"]);
  });
});

describe("importazione", () => {
  it("sanitizeWidget: tipi, aggregazioni e larghezze ammessi; scarta widget senza tipo o layer", () => {
    expect(sanitizeWidget({ id: "ok", type: "bar", layer: "l", field: "f", agg: "media?", w: 7, extra: 1 }, uid)).toEqual({ id: "ok", type: "bar", title: "", layer: "l", field: "f", agg: "count", w: 1 });
    expect(sanitizeWidget({ id: "a b <x>", type: "kpi", layer: "l", agg: "sum", valueField: "v", w: 3, cql: "x = 1" }, uid)).toMatchObject({ id: expect.stringMatching(/^u\d+$/), agg: "sum", valueField: "v", w: 3, cql: "x = 1" });
    expect(sanitizeWidget({ type: "torta", layer: "l" }, uid)).toBeNull();
    expect(sanitizeWidget({ type: "kpi" }, uid)).toBeNull();
    expect(sanitizeWidget(null, uid)).toBeNull();
  });

  it("file esportato, dashboard singola o elenco", () => {
    const f = JSON.stringify(exportDashboards([D("Uno"), D("Due")]));
    expect(parseImport(f, uid).items.map((d) => d.title)).toEqual(["Uno", "Due"]);
    expect(parseImport(JSON.stringify({ title: "Sola", widgets: [W("x")] }), uid).items).toHaveLength(1);
    expect(parseImport(JSON.stringify([{ title: "A", widgets: [W("x")] }]), uid).items[0].fid).toBeUndefined();
  });

  it("avvisi: widget scartati, dashboard senza titolo o senza widget validi; id doppi rinominati", () => {
    const r = parseImport(JSON.stringify({ dashboards: [
      { title: "Buona", roles: ["v", 3, ""], widgets: [W("x"), W("x"), { type: "torta" }] },
      { title: "", widgets: [W("y")] },
      { title: "Vuota", widgets: [{ type: "?" }] },
    ] }), uid);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].roles).toEqual(["v"]);
    expect(new Set(r.items[0].widgets.map((w) => w.id)).size).toBe(2);
    expect(r.warnings).toEqual(["«Buona»: 1 widget non validi scartati.", "Dashboard n. 2 senza titolo: saltata.", "«Vuota»: 1 widget non validi scartati.", "«Vuota»: nessun widget valido, saltata."]);
  });

  it("errori: non JSON, formato o versione sbagliati, niente da importare", () => {
    expect(() => parseImport("{", uid)).toThrow("il file non è JSON valido");
    expect(() => parseImport(JSON.stringify({ format: "altro", dashboards: [] }), uid)).toThrow("formato non riconosciuto: altro");
    expect(() => parseImport(JSON.stringify({ format: FORMAT, version: 2, dashboards: [] }), uid)).toThrow(/versione più recente \(2\)/);
    expect(() => parseImport(JSON.stringify({ a: 1 }), uid)).toThrow("il file non contiene dashboard");
    expect(() => parseImport(JSON.stringify({ dashboards: [] }), uid)).toThrow("il file non contiene dashboard");
    expect(() => parseImport(JSON.stringify({ dashboards: [{ title: "", widgets: [] }] }), uid)).toThrow(/nessuna dashboard importabile/);
  });

  it("layer mancanti, ruoli sconosciuti, rimappatura", () => {
    const items = [D("A", { roles: ["v", "z"], widgets: [W("1", "uat:a"), W("2", "iride:parcels")] }), D("B", { widgets: [W("3", "uat:a"), W("4", "uat:b")] })];
    expect(missingLayers(items, new Set(["iride:parcels"]))).toEqual(["uat:a", "uat:b"]);
    expect(unknownRoles(items, new Set(["v"]))).toEqual(["z"]);
    const m = remapLayers(items, { "uat:a": "iride:a", "uat:b": "" });
    expect(m.flatMap((d) => d.widgets.map((w) => w.layer))).toEqual(["iride:a", "iride:parcels", "iride:a", "uat:b"]);
    expect(items[0].widgets[0].layer).toBe("uat:a"); // l'originale non cambia
  });

  it("piano: sostituzione per titolo (senza distinguere maiuscole) solo se chiesta, esclusioni", () => {
    const existing = [D("Particelle", { fid: "dashboards.1" })];
    const items = [D("particelle", { fid: undefined }), D("Nuova", { fid: undefined }), D("Esclusa", { fid: undefined })];
    expect(planImport(items, existing, new Set()).insert.map((d) => d.title)).toEqual(["particelle", "Nuova", "Esclusa"]);
    const p = planImport(items, existing, new Set(["particelle"]), new Set(["Esclusa"]));
    expect(p.update).toEqual([expect.objectContaining({ title: "particelle", fid: "dashboards.1" })]);
    expect(p.insert.map((d) => d.title)).toEqual(["Nuova"]);
  });
});

describe("importDashboards (WFS-T)", () => {
  it("una sola transazione con Update delle sostituite e Insert delle nuove; niente da fare = nessuna richiesta", async () => {
    const posts: string[] = [];
    mockFetch((url, init) => {
      if (init?.method === "POST") { posts.push(String(init.body)); return { body: "<wfs:SUCCESS/>" }; }
      return { body: XSD("dashboards", ["title", "description", "roles", "definition"].map((x) => el(x, "xsd:string")).join(""), "http://x/m") };
    });
    expect(await importDashboards("/gs-io", fakeKc({ preferred_username: "ada" }), ACC, { insert: [], update: [] })).toBe(0);
    expect(posts).toHaveLength(0);
    const nn = await importDashboards("/gs-io", fakeKc({ preferred_username: "ada" }), ACC, { update: [D("Vecchia", { fid: "dashboards.7" })], insert: [D("Nuova", { fid: undefined })] });
    expect(nn).toBe(2);
    expect(posts).toHaveLength(1);
    expect(posts[0].indexOf('<wfs:Update typeName="mapp:dashboards">')).toBeLessThan(posts[0].indexOf("<wfs:Insert>"));
    expect(posts[0]).toContain('fid="dashboards.7"');
    expect(posts[0]).toContain("<mapp:title>Nuova</mapp:title>");
    expect(posts[0]).toContain("<mapp:updated_by>ada</mapp:updated_by>");
  });
});
