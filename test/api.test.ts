import { afterEach, describe, expect, it, vi } from "vitest";
import { installDom } from "./dom";
import { describeLayer, describeTable, getFeatureInfo, getWfsFeatureById, getWfsFeatures, wfsTransaction, wmsTileUrl } from "../src/api";

installDom();

const schemaXml = `<?xml version="1.0"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:gml="http://www.opengis.net/gml" targetNamespace="http://iride" elementFormDefault="qualified">
  <xsd:element name="parcels" type="iride:parcelsType"/>
  <xsd:complexType name="parcelsType">
    <xsd:sequence>
      <xsd:element name="nome" type="xsd:string"/>
      <xsd:element name="area" type="xsd:double"/>
      <xsd:element name="geom" type="gml:MultiPolygonPropertyType"/>
    </xsd:sequence>
  </xsd:complexType>
</xsd:schema>`;

const tableXml = `<?xml version="1.0"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="http://mapp">
  <xsd:element name="role_rules"/>
  <xsd:complexType><xsd:sequence>
    <xsd:element name="role" type="xsd:string"/>
  </xsd:sequence></xsd:complexType>
</xsd:schema>`;

function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: string; ok?: boolean }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const res = handler(String(url), init);
    const status = res.status ?? 200;
    const ok = res.ok ?? (status >= 200 && status < 300);
    return { ok, status, text: async () => res.body };
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("wmsTileUrl", () => {
  it("compone i tile WMS con CQL, tempo e revisione", () => {
    const u = wmsTileUrl("http://gs", "iride:a b", { cql: " nome = 'x' ", time: "2024" }, 3);
    expect(u).toContain("layers=iride%3Aa%20b");
    expect(u).toContain("cql_filter=nome%20%3D%20'x'");
    expect(u).toContain("time=2024");
    expect(u).toContain("_r=3");
    expect(u.endsWith("&bbox={bbox-epsg-3857}")).toBe(true);
    const plain = wmsTileUrl("http://gs", "a", { cql: "  ", time: "" }, 0);
    expect(plain).not.toContain("cql_filter");
    expect(plain).not.toContain("time=");
    expect(plain).not.toContain("_r=");
  });
});

describe("schema WFS", () => {
  it("interpreta DescribeFeatureType e distingue tabelle senza geometria", async () => {
    const calls = mockFetch((url) => ({ body: url.includes("role_rules") ? tableXml : schemaXml }));
    const s = await describeLayer("http://gs.schema", null, "iride:parcels");
    expect(s).toMatchObject({
      prefix: "iride", ns: "http://iride", typeName: "parcels", geomName: "geom", geomType: "MultiPolygon",
    });
    expect(s.fields).toEqual([{ name: "nome", type: "string" }, { name: "area", type: "double" }]);

    await describeLayer("http://gs.schema", null, "iride:parcels");
    expect(calls.filter((c) => c.url.includes("parcels"))).toHaveLength(1);

    const table = await describeTable("http://gs.schema", null, "mapp:role_rules");
    expect(table.geomName).toBe("");
    expect(table.fields.map((f) => f.name)).toEqual(["role"]);
    expect(table.prefix).toBe("mapp");
  });

  it("fallisce sui raster e sulle risposte di errore, senza avvelenare la cache", async () => {
    mockFetch(() => ({ body: tableXml }));
    await expect(describeLayer("http://gs.raster", null, "iride:dem")).rejects.toThrow(/colonna geometrica/);

    mockFetch(() => ({ status: 500, body: `<ServiceException>layer sconosciuto</ServiceException>` }));
    await expect(describeLayer("http://gs.err", null, "iride:x")).rejects.toThrow(/sconosciuto/);

    mockFetch(() => ({ body: schemaXml }));
    await expect(describeLayer("http://gs.err", null, "iride:x")).resolves.toMatchObject({ geomType: "MultiPolygon" });
  });

  it("usa il prefisso ns se il layer non ha workspace", async () => {
    mockFetch(() => ({ body: schemaXml }));
    const s = await describeLayer("http://gs.ns", null, "parcels");
    expect(s.prefix).toBe("ns");
    expect(s.typeName).toBe("parcels");
  });
});

describe("lettura feature", () => {
  it("GetFeature aggiunge CQL e propertyName", async () => {
    const calls = mockFetch(() => ({ body: JSON.stringify({ features: [{ id: "a.1", properties: { n: 1 } }] }) }));
    const fs = await getWfsFeatures("http://gs", { token: "t" } as never, "iride:a", " n = 1 ", 10, ["n", "nome"]);
    expect(fs).toHaveLength(1);
    const url = calls[0].url;
    expect(url).toContain("maxFeatures=10");
    expect(url).toContain("cql_filter=");
    expect(url).toContain("propertyName=");
    expect(calls[0].init?.headers).toEqual({ Authorization: "Bearer t" });
  });

  it("GetFeatureById torna null se non c'è l'oggetto", async () => {
    mockFetch(() => ({ body: JSON.stringify({ features: [] }) }));
    expect(await getWfsFeatureById("http://gs", null, "iride:a", "a.9")).toBeNull();
  });

  it("GetFeatureInfo costruisce la finestra intorno al clic", async () => {
    const calls = mockFetch(() => ({ body: JSON.stringify({ features: [{ id: "a.1" }] }) }));
    const map = {
      project: () => ({ x: 10, y: 20 }),
      unproject: ([x, y]: [number, number]) => ({ lng: x / 100, lat: y / 100 }),
    };
    const fs = await getFeatureInfo("http://gs", null, "iride:a", map as never, { lng: 0.1, lat: 0.2 }, { time: "2024" });
    expect(fs).toHaveLength(1);
    expect(calls[0].url).toContain("request=GetFeatureInfo");
    expect(calls[0].url).toContain("x=50");
    expect(calls[0].url).toContain("time=2024");
  });

  it("segnala una risposta non JSON", async () => {
    mockFetch(() => ({ body: "<html>no</html>" }));
    await expect(getWfsFeatures("http://gs", null, "a")).rejects.toThrow(/non JSON/);
  });
});

describe("wfsTransaction", () => {
  const ok = `<wfs:WFS_TransactionResponse><wfs:Status><wfs:SUCCESS/></wfs:Status></wfs:WFS_TransactionResponse>`;

  it("accetta SUCCESS", async () => {
    const calls = mockFetch(() => ({ body: ok }));
    await expect(wfsTransaction("http://gs", { token: "t" } as never, "<xml/>")).resolves.toBeUndefined();
    expect(calls[0].url).toBe("http://gs/wfs");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.body).toBe("<xml/>");
    expect(calls[0].init?.headers).toMatchObject({ "Content-Type": "text/xml", Authorization: "Bearer t" });
  });

  it("traduce 401, 403, eccezioni OGC e transazioni fallite", async () => {
    mockFetch(() => ({ status: 401, body: "" }));
    await expect(wfsTransaction("http://gs", null, "<xml/>")).rejects.toThrow(/401/);

    mockFetch(() => ({ status: 403, body: "" }));
    await expect(wfsTransaction("http://gs", null, "<xml/>")).rejects.toThrow(/403/);

    mockFetch(() => ({ status: 200, body: `<ServiceException><![CDATA[permesso negato]]></ServiceException>` }));
    await expect(wfsTransaction("http://gs", null, "<xml/>")).rejects.toThrow("permesso negato");

    mockFetch(() => ({ status: 200, body: `<wfs:FAILED/><wfs:Message>geometria invalida</wfs:Message>` }));
    await expect(wfsTransaction("http://gs", null, "<xml/>")).rejects.toThrow("geometria invalida");

    mockFetch(() => ({ status: 200, body: `<wfs:FAILED/>` }));
    await expect(wfsTransaction("http://gs", null, "<xml/>")).rejects.toThrow(/rifiutata/);

    mockFetch(() => ({ status: 500, body: "boom" }));
    await expect(wfsTransaction("http://gs", null, "<xml/>")).rejects.toThrow("HTTP 500");

    mockFetch(() => ({ status: 200, body: "<ok/>" }));
    await expect(wfsTransaction("http://gs", null, "<xml/>")).rejects.toThrow(/inattesa/);
  });
});
