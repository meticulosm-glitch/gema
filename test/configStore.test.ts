import { afterEach, describe, expect, it, vi } from "vitest";
import { installDom } from "./dom";
import type { AccessConfig } from "../src/config";
import { dashId, deleteRule, isMissingTable, loadDashboards, loadRules, saveDashboard, saveRule } from "../src/configStore";

installDom();

const acc: AccessConfig = {
  enabled: true,
  adminRole: "fss-etl-admin",
  viewerRole: "fss-etl-viewer",
  rolesClient: "mapp-web",
  knownRoles: [],
  workspace: "mapp",
};

const schemaXml = `<?xml version="1.0"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="http://mapp">
  <xsd:element name="ignored"/>
  <xsd:complexType><xsd:sequence>
    <xsd:element name="role" type="xsd:string"/>
    <xsd:element name="title" type="xsd:string"/>
  </xsd:sequence></xsd:complexType>
</xsd:schema>`;

const success = `<wfs:WFS_TransactionResponse><wfs:Status><wfs:SUCCESS/></wfs:Status></wfs:WFS_TransactionResponse>`;

function mockFetch(routes: (url: string, init?: RequestInit) => string) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, text: async () => routes(String(url), init) };
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("isMissingTable / dashId", () => {
  it("riconosce una tabella di configurazione non pubblicata", () => {
    expect(isMissingTable(new Error("Could not find feature type"))).toBe(true);
    expect(isMissingTable("layer non trovato")).toBe(true);
    expect(isMissingTable(new Error("HTTP 500"))).toBe(false);
    expect(isMissingTable(null)).toBe(false);
  });

  it("estrae l'id locale dal fid", () => {
    expect(dashId("dashboards.42")).toBe("42");
    expect(dashId("a.b.c")).toBe("c");
    expect(dashId(undefined)).toBe("");
    expect(dashId("solo")).toBe("solo");
  });
});

describe("loadRules / loadDashboards", () => {
  it("normalizza JSON, scarta strumenti sconosciuti e ruoli vuoti", async () => {
    mockFetch(() => JSON.stringify({
      features: [
        { id: "role_rules.1", properties: { role: "viewer", layers: '["a","*"]', tools: '["info","nope","edit"]', updated_by: "ada", updated_at: "2026-01-01" } },
        { id: "role_rules.2", properties: { role: "", layers: "[]", tools: "[]" } },
        { id: "role_rules.3", properties: { role: "ops", layers: "not-json", tools: null } },
      ],
    }));
    const rules = await loadRules("http://gs.rules", null, acc);
    expect(rules).toEqual([
      { fid: "role_rules.1", role: "viewer", layers: ["a", "*"], tools: ["info", "edit"], updatedBy: "ada", updatedAt: "2026-01-01" },
      { fid: "role_rules.3", role: "ops", layers: [], tools: [], updatedBy: undefined, updatedAt: undefined },
    ]);
  });

  it("ordina le dashboard e ripara le definizioni non valide", async () => {
    mockFetch(() => JSON.stringify({
      features: [
        { id: "dashboards.2", properties: { title: "Zeta", description: "", roles: '["ops"]', definition: "[]" } },
        { id: "dashboards.1", properties: { roles: "nope", definition: '{"no":"array"}' } },
      ],
    }));
    const dashes = await loadDashboards("http://gs.dash", { token: "t" } as never, acc);
    expect(dashes.map((d) => d.title)).toEqual(["(senza titolo)", "Zeta"]);
    expect(dashes[0]).toMatchObject({ fid: "dashboards.1", roles: [], widgets: [], description: "" });
    expect(dashes[1].roles).toEqual(["ops"]);
  });
});

describe("scrittura WFS-T delle tabelle di configurazione", () => {
  it("inserisce una regola nuova e aggiorna una esistente senza riscrivere il ruolo", async () => {
    const calls = mockFetch((url) => url.includes("DescribeFeatureType") ? schemaXml : success);
    const kc = { token: "t", tokenParsed: { preferred_username: "ada" } } as never;
    await saveRule("http://gs.save.rule", kc, acc, { role: "ops", layers: ["a"], tools: ["info"] });
    const insert = calls.find((c) => c.init?.method === "POST")!;
    expect(String(insert.init?.body)).toContain("<wfs:Insert>");
    expect(String(insert.init?.body)).toContain("<mapp:role>ops</mapp:role>");
    const quot = "&" + "quot;";
    expect(String(insert.init?.body)).toContain(`<mapp:layers>[${quot}a${quot}]</mapp:layers>`);
    expect(String(insert.init?.body)).toContain("<mapp:updated_by>ada</mapp:updated_by>");

    await saveRule("http://gs.save.rule", kc, acc, { fid: `role_rules.9`, role: "ops", layers: ["b"], tools: ["edit"] });
    const update = calls.filter((c) => c.init?.method === "POST").at(-1)!;
    const body = String(update.init?.body);
    expect(body).toContain("<wfs:Update ");
    expect(body).toContain('fid="role_rules.9"');
    expect(body).not.toContain("<wfs:Name>role</wfs:Name>");
    expect(body).toContain("[" + "&" + "quot;b" + "&" + "quot;]");
  });

  it("cancella una regola e salva una dashboard", async () => {
    const calls = mockFetch((url) => url.includes("DescribeFeatureType") ? schemaXml : success);
    await deleteRule("http://gs.del", null, acc, "role_rules.3");
    expect(String(calls.find((c) => c.init?.method === "POST")?.init?.body)).toContain("<wfs:Delete ");

    await saveDashboard("http://gs.del", null, acc, {
      fid: "dashboards.4", title: `A & B`, description: "d", roles: ["ops"], widgets: [],
    });
    const body = String(calls.filter((c) => c.init?.method === "POST").at(-1)?.init?.body);
    expect(body).toContain("<wfs:Value>A " + "&" + "amp; B</wfs:Value>");
    expect(body).toContain("<wfs:Name>updated_by</wfs:Name><wfs:Value></wfs:Value>");
    expect(body).toMatch(/<wfs:Name>updated_at<\/wfs:Name><wfs:Value>\d{4}-\d{2}-\d{2}T/);
  });
});
