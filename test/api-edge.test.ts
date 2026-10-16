// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { describeLayer, describeTable, fetchLegendBlob, getFeatureInfo, getWfsFeatureById, getWfsFeatures, wfsTransaction, wmsTileUrl } from "../src/api";
import { el, fakeKc, mockFetch, XSD } from "./support";

const calls = (f: ReturnType<typeof mockFetch>) => f.mock.calls.map(([u, i]) => [String(u), i as RequestInit | undefined] as const);

describe("wmsTileUrl", () => {
  it("URL base con il placeholder del bbox", () => {
    const u = wmsTileUrl("/geoserver", "iride:a b");
    expect(u).toContain("/geoserver/wms?service=WMS&version=1.1.1&request=GetMap&layers=iride%3Aa%20b");
    expect(u.endsWith("&bbox={bbox-epsg-3857}")).toBe(true);
    expect(u).not.toContain("cql_filter");
    expect(u).not.toContain("time=");
    expect(u).not.toContain("_r=");
  });
  it("CQL e TIME codificati e senza spazi ai bordi", () => {
    const u = wmsTileUrl("/g", "a:b", { cql: "  nome = 'X & Y'  ", time: " 2026-01-01/2026-02-01 " }, 3);
    expect(u).toContain("&cql_filter=nome%20%3D%20'X%20%26%20Y'");
    expect(u).toContain("&time=2026-01-01%2F2026-02-01");
    expect(u).toContain("&_r=3");
  });
  it("CQL/TIME vuoti o solo spazi sono ignorati", () => {
    const u = wmsTileUrl("/g", "a:b", { cql: "   ", time: "" });
    expect(u).not.toContain("cql_filter");
    expect(u).not.toContain("time=");
  });
});

describe("getWfsFeatures", () => {
  it("richiesta WFS 1.0.0 in JSON con filtro, limite e proprietà", async () => {
    const f = mockFetch(() => ({ body: JSON.stringify({ features: [{ id: "a.1", properties: { x: 1 }, geometry: null }] }), type: "application/json" }));
    const out = await getWfsFeatures("/geoserver", fakeKc({}, "T1"), "iride:a", "x > 1", 50, ["x", "y"]);
    expect(out).toHaveLength(1);
    const [url, init] = calls(f)[0];
    expect(url).toContain("version=1.0.0&request=GetFeature&typeName=iride%3Aa");
    expect(url).toContain("outputFormat=application/json&maxFeatures=50&srsName=EPSG:4326");
    expect(url).toContain("&cql_filter=x%20%3E%201");
    expect(url).toContain("&propertyName=x%2Cy");
    expect(init?.headers).toEqual({ Authorization: "Bearer T1" });
  });
  it("senza token nessuna intestazione Authorization; features assenti = []", async () => {
    const f = mockFetch(() => ({ body: "{}" }));
    expect(await getWfsFeatures("/g", null, "a:b")).toEqual([]);
    expect(calls(f)[0][1]?.headers).toEqual({});
  });
  it("ServiceException di GeoServer diventa il messaggio dell'errore", async () => {
    mockFetch(() => ({ status: 200, body: `<ServiceExceptionReport><ServiceException code="InvalidParameterValue">Feature type iride:x unknown</ServiceException></ServiceExceptionReport>` }));
    await expect(getWfsFeatures("/g", null, "iride:x")).rejects.toThrow("Feature type iride:x unknown");
  });
  it("errore HTTP senza eccezione: HTTP <codice>", async () => {
    mockFetch(() => ({ status: 503, body: "boh" }));
    await expect(getWfsFeatures("/g", null, "a:b")).rejects.toThrow("HTTP 503");
  });
  it("ServiceException con CDATA e spazi: testo ripulito e troncato a 300 caratteri", async () => {
    mockFetch(() => ({ status: 400, body: `<ows:ExceptionReport><ServiceException><![CDATA[  Could   not\nfind type ${"x".repeat(400)} ]]></ServiceException></ows:ExceptionReport>` }));
    const e = (await getWfsFeatures("/g", null, "a:b").catch((x) => x)) as Error;
    expect(e.message.startsWith("Could not find type xxx")).toBe(true);
    expect(e.message.length).toBeLessThanOrEqual(300);
  });
  it("risposta 200 non JSON: errore leggibile", async () => {
    mockFetch(() => ({ body: "<html>login</html>" }));
    await expect(getWfsFeatures("/g", null, "a:b")).rejects.toThrow("risposta non JSON");
  });
});

describe("getWfsFeatureById", () => {
  it("restituisce il primo oggetto o null", async () => {
    mockFetch(() => ({ body: JSON.stringify({ features: [{ id: "a.5", geometry: null, properties: {} }] }) }));
    expect((await getWfsFeatureById("/g", null, "a:b", "a.5"))?.id).toBe("a.5");
    mockFetch(() => ({ body: JSON.stringify({ features: [] }) }));
    expect(await getWfsFeatureById("/g", null, "a:b", "a.9")).toBeNull();
  });
});

describe("getFeatureInfo", () => {
  const map: any = { project: ([x, y]: number[]) => ({ x: x * 100, y: y * 100 }), unproject: ([x, y]: number[]) => ({ lng: x / 100, lat: y / 100 }) };
  it("finestra 101x101 centrata sul clic, con CQL e TIME", async () => {
    const f = mockFetch(() => ({ body: JSON.stringify({ features: [{ id: "a.1", geometry: null, properties: null }] }) }));
    const out = await getFeatureInfo("/g", null, "a:b", map, { lng: 12, lat: 42 }, { cql: "a=1", time: "2026" });
    expect(out).toHaveLength(1);
    const u = calls(f)[0][0];
    expect(u).toContain("request=GetFeatureInfo&layers=a%3Ab&query_layers=a%3Ab");
    expect(u).toContain("width=101&height=101&x=50&y=50");
    expect(u).toContain("info_format=application/json");
    expect(u).toContain("&cql_filter=a%3D1");
    expect(u).toContain("&time=2026");
    const bbox = /bbox=([^&]+)/.exec(u)![1].split(",").map(Number);
    expect((bbox[0] + bbox[2]) / 2).toBeCloseTo(12, 6);
    expect((bbox[1] + bbox[3]) / 2).toBeCloseTo(42, 6);
  });
});

describe("describeLayer / describeTable", () => {
  const parcels = XSD("parcels",
    el("nome", "xsd:string") + el("anno", "xsd:int") + el("area", "xsd:double") + el("geom", "gml:MultiPolygonPropertyType"), "http://iride/ns");

  it("schema: prefisso, namespace, geometria e attributi non geometrici", async () => {
    mockFetch(() => ({ body: parcels, type: "text/xml" }));
    const s = await describeLayer("/geoserver-1", null, "iride:parcels");
    expect(s).toMatchObject({ prefix: "iride", ns: "http://iride/ns", typeName: "parcels", geomName: "geom", geomType: "MultiPolygon" });
    expect(s.fields).toEqual([{ name: "nome", type: "string" }, { name: "anno", type: "int" }, { name: "area", type: "double" }]);
  });
  it("la risposta è in cache: una sola richiesta per layer", async () => {
    const f = mockFetch(() => ({ body: parcels }));
    await describeLayer("/geoserver-2", null, "iride:parcels");
    await describeLayer("/geoserver-2", null, "iride:parcels");
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("tipi geometrici: Point, Curve (->LineString), generica", async () => {
    mockFetch(() => ({ body: XSD("p", el("g", "gml:PointPropertyType")) }));
    expect((await describeLayer("/g3", null, "a:p")).geomType).toBe("Point");
    mockFetch(() => ({ body: XSD("c", el("g", "gml:CurvePropertyType")) }));
    expect((await describeLayer("/g3", null, "a:c")).geomType).toBe("LineString");
    mockFetch(() => ({ body: XSD("g", el("g", "gml:GeometryPropertyType")) }));
    expect((await describeLayer("/g3", null, "a:g")).geomType).toBe("Geometry");
  });
  it("layer senza geometria (raster/gruppo): errore; describeTable invece lo ammette", async () => {
    const tab = XSD("role_rules", el("role", "xsd:string") + el("layers", "xsd:string"), "http://mapp");
    mockFetch(() => ({ body: tab }));
    await expect(describeLayer("/g4", null, "mapp:role_rules")).rejects.toThrow(/colonna geometrica/);
    const t = await describeTable("/g4", null, "mapp:role_rules");
    expect(t.geomName).toBe("");
    expect(t.fields.map((x) => x.name)).toEqual(["role", "layers"]);
  });
  it("errore di GeoServer sul layer sconosciuto, e non resta in cache", async () => {
    const f = mockFetch(() => ({ status: 400, body: `<ServiceException>Could not find type: iride:nope</ServiceException>` }));
    await expect(describeLayer("/g5", null, "iride:nope")).rejects.toThrow(/Could not find type/);
    await expect(describeLayer("/g5", null, "iride:nope")).rejects.toThrow(/Could not find type/);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("risposta non XML schema", async () => {
    mockFetch(() => ({ body: "<html><body>login</body></html>" }));
    await expect(describeLayer("/g6", null, "a:b")).rejects.toThrow("schema non disponibile");
  });
  it("layer senza prefisso", async () => {
    mockFetch(() => ({ body: XSD("solo", el("g", "gml:PointPropertyType")) }));
    expect((await describeLayer("/g7", null, "solo")).prefix).toBe("ns");
  });
});

describe("wfsTransaction", () => {
  const OK = `<wfs:WFS_TransactionResponse><wfs:TransactionResult><wfs:Status><wfs:SUCCESS/></wfs:Status></wfs:TransactionResult></wfs:WFS_TransactionResponse>`;
  it("POST del XML a /wfs con Content-Type text/xml e token", async () => {
    const f = mockFetch(() => ({ body: OK }));
    await wfsTransaction("/geoserver", fakeKc({}, "T"), "<xml/>");
    const [url, init] = calls(f)[0];
    expect(url).toBe("/geoserver/wfs");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("<xml/>");
    expect(init?.headers).toEqual({ "Content-Type": "text/xml", Authorization: "Bearer T" });
  });
  it("401, 403: messaggi dedicati", async () => {
    mockFetch(() => ({ status: 401 }));
    await expect(wfsTransaction("/g", null, "x")).rejects.toThrow(/401/);
    mockFetch(() => ({ status: 403 }));
    await expect(wfsTransaction("/g", null, "x")).rejects.toThrow(/403.*sola lettura/);
  });
  it("ServiceException, FAILED con messaggio, FAILED senza messaggio, risposta inattesa, HTTP", async () => {
    mockFetch(() => ({ body: `<ServiceException>Errore X</ServiceException>` }));
    await expect(wfsTransaction("/g", null, "x")).rejects.toThrow("Errore X");
    mockFetch(() => ({ body: `<wfs:Status><wfs:FAILED/></wfs:Status><wfs:Message> vincolo violato </wfs:Message>` }));
    await expect(wfsTransaction("/g", null, "x")).rejects.toThrow("vincolo violato");
    mockFetch(() => ({ body: `<wfs:FAILED/>` }));
    await expect(wfsTransaction("/g", null, "x")).rejects.toThrow("transazione rifiutata");
    mockFetch(() => ({ body: `<html>ciao</html>` }));
    await expect(wfsTransaction("/g", null, "x")).rejects.toThrow("risposta inattesa");
    mockFetch(() => ({ status: 500, body: "" }));
    await expect(wfsTransaction("/g", null, "x")).rejects.toThrow("HTTP 500");
  });
});

describe("fetchLegendBlob", () => {
  it("restituisce l'immagine", async () => {
    mockFetch(() => ({ body: "png", type: "image/png" }));
    expect((await fetchLegendBlob("/g", null, "a:b")).type).toBe("image/png");
  });
  it("errore se non è un'immagine o HTTP KO", async () => {
    mockFetch(() => ({ body: "x", type: "text/xml" }));
    await expect(fetchLegendBlob("/g", null, "a:b")).rejects.toThrow("legenda non disponibile");
    mockFetch(() => ({ status: 404 }));
    await expect(fetchLegendBlob("/g", null, "a:b")).rejects.toThrow("HTTP 404");
  });
});
