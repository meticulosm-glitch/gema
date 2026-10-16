import { beforeAll, describe, expect, it, vi } from "vitest";
import { installDom } from "./dom";

installDom();

const { fetchProducts, fetchVectorNames, markVector, parseCapabilities, parseWfsTypes } = await import("../src/capabilities");

const wms = `<?xml version="1.0"?>
<WMS_Capabilities>
  <Capability>
    <Layer>
      <Name>root</Name><Title>Gruppo</Title>
      <Layer>
        <Name>iride:beta</Name><Title>Beta</Title>
        <EX_GeographicBoundingBox>
          <westBoundLongitude>10</westBoundLongitude>
          <southBoundLatitude>40</southBoundLatitude>
          <eastBoundLongitude>12</eastBoundLongitude>
          <northBoundLatitude>43</northBoundLatitude>
        </EX_GeographicBoundingBox>
        <Dimension name="TIME" default="2024">2020,2021,2024</Dimension>
      </Layer>
      <Layer>
        <Title>senza nome</Title>
      </Layer>
      <Layer>
        <Name>solo</Name><Title>Alpha</Title>
        <Dimension name="time">2020-01-01/2024-01-01/P1D</Dimension>
        <EX_GeographicBoundingBox>
          <westBoundLongitude>nope</westBoundLongitude>
          <southBoundLatitude>0</southBoundLatitude>
          <eastBoundLongitude>1</eastBoundLongitude>
          <northBoundLatitude>1</northBoundLatitude>
        </EX_GeographicBoundingBox>
      </Layer>
    </Layer>
  </Capability>
</WMS_Capabilities>`;

describe("parseCapabilities", () => {
  it("tiene solo i layer foglia, con bbox, tempo e workspace", () => {
    const list = parseCapabilities(wms);
    expect(list.map((p) => p.name)).toEqual(["solo", "iride:beta"]);
    const beta = list[1];
    expect(beta.title).toBe("Beta");
    expect(beta.workspace).toBe("iride");
    expect(beta.bbox).toEqual([10, 40, 12, 43]);
    expect(beta.time).toEqual({ extent: "2020,2021,2024", default: "2024", values: ["2024", "2021", "2020"] });
    const solo = list[0];
    expect(solo.workspace).toBe("(default)");
    expect(solo.bbox).toBeUndefined();
    expect(solo.time?.values).toBeUndefined();
    expect(solo.time?.extent).toContain("/");
  });

  it("rifiuta una risposta che non è XML", () => {
    expect(() => parseCapabilities("non è xml")).toThrow(/non XML/);
  });

  it("non elenca le date se sono troppe", () => {
    const dates = Array.from({ length: 501 }, (_, i) => `2020-01-${String((i % 28) + 1).padStart(2, "0")}`).join(",");
    const xml = `<WMS_Capabilities><Capability><Layer><Layer><Name>a</Name><Title>A</Title><Dimension name="time">${dates}</Dimension></Layer></Layer></Capability></WMS_Capabilities>`;
    expect(parseCapabilities(xml)[0].time?.values).toBeUndefined();
  });
});

describe("WFS feature types", () => {
  const wfs = `<?xml version="1.0"?>
    <WFS_Capabilities><FeatureTypeList>
      <FeatureType><Name>iride:beta</Name></FeatureType>
      <FeatureType><Name>  </Name></FeatureType>
      <FeatureType><Title>no</Title></FeatureType>
    </FeatureTypeList></WFS_Capabilities>`;

  it("estrae i nomi pubblicati", () => {
    expect([...parseWfsTypes(wfs)]).toEqual(["iride:beta"]);
  });

  it("rifiuta XML non valido", () => {
    expect(() => parseWfsTypes("???")).toThrow(/non XML/);
  });

  it("marca i prodotti vettoriali, o lascia tutto invariato se il WFS non è noto", () => {
    const list = parseCapabilities(wms);
    expect(markVector(list, null)[0].vector).toBeUndefined();
    const marked = markVector(list, new Set(["iride:beta"]));
    expect(marked.find((p) => p.name === "iride:beta")?.vector).toBe(true);
    expect(marked.find((p) => p.name === "solo")?.vector).toBe(false);
    expect(list[0].vector).toBeUndefined();
  });
});

describe("fetch verso GeoServer", () => {
  beforeAll(() => installDom());

  it("fetchVectorNames torna null se la risposta è vuota, in errore o la rete fallisce", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => `<WFS_Capabilities></WFS_Capabilities>` });
    expect(await fetchVectorNames("http://gs")).toBeNull();

    fetchMock.mockResolvedValueOnce({ ok: false, text: async () => "" });
    expect(await fetchVectorNames("http://gs", "tok")).toBeNull();

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await fetchVectorNames("http://gs")).toBeNull();

    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => wfsDoc() });
    const signal = new AbortController().signal;
    const names = await fetchVectorNames("http://gs", "tok", signal);
    expect(names).toEqual(new Set(["iride:beta"]));
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(String(url)).toContain("service=WFS");
    expect(init.headers).toEqual({ Authorization: "Bearer tok" });
    expect(init.signal).toBe(signal);
    vi.unstubAllGlobals();
  });

  it("fetchProducts unisce WMS e WFS e propaga l'errore HTTP", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce({ ok: true, text: async () => wms })
      .mockResolvedValueOnce({ ok: true, text: async () => wfsDoc() });
    const products = await fetchProducts("http://gs", "tok");
    expect(products.find((p) => p.name === "iride:beta")?.vector).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: "Bearer tok" });

    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, text: async () => "" });
    await expect(fetchProducts("http://gs")).rejects.toThrow("HTTP 502");
    vi.unstubAllGlobals();
  });
});

function wfsDoc(): string {
  return `<WFS_Capabilities><FeatureTypeList><FeatureType><Name>iride:beta</Name></FeatureType></FeatureTypeList></WFS_Capabilities>`;
}
