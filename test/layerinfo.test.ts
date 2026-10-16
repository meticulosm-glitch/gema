// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCapabilities } from "../src/capabilities";
import { getWfsCount } from "../src/api";
import { installDom } from "./dom";
import { mockFetch } from "./support";

installDom();
afterEach(() => vi.unstubAllGlobals());

const CAPS = `<?xml version="1.0"?>
<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms" xmlns:xlink="http://www.w3.org/1999/xlink"><Capability><Layer>
  <Title>root</Title><Abstract>non ereditata</Abstract>
  <Layer queryable="1">
    <Name>iride:ndvi</Name><Title>NDVI</Title>
    <Abstract>Indice di vegetazione
      calcolato da Sentinel-2.</Abstract>
    <KeywordList><Keyword>ndvi</Keyword><Keyword>sentinel</Keyword><Keyword>ndvi</Keyword><Keyword> </Keyword></KeywordList>
    <EX_GeographicBoundingBox><westBoundLongitude>6</westBoundLongitude><eastBoundLongitude>18</eastBoundLongitude><southBoundLatitude>36</southBoundLatitude><northBoundLatitude>47</northBoundLatitude></EX_GeographicBoundingBox>
    <Attribution><Title>Copernicus</Title><OnlineResource xlink:href="https://copernicus.eu"/></Attribution>
    <MetadataURL type="ISO19115:2003"><Format>text/xml</Format><OnlineResource xlink:type="simple" xlink:href="https://meta.example/ndvi.xml"/></MetadataURL>
  </Layer>
  <Layer queryable="1"><Name>iride:vuoto</Name><Title>Vuoto</Title></Layer>
</Layer></Capability></WMS_Capabilities>`;

describe("parseCapabilities: scheda del layer", () => {
  const list = parseCapabilities(CAPS);
  const a = list.find((p) => p.name === "iride:ndvi")!;
  it("descrizione, parole chiave senza doppioni né vuoti, fonte e metadati", () => {
    expect(a.abstract).toBe("Indice di vegetazione\n      calcolato da Sentinel-2.");
    expect(a.keywords).toEqual(["ndvi", "sentinel"]);
    expect(a.attribution).toEqual({ title: "Copernicus", url: "https://copernicus.eu" });
    expect(a.metadataUrl).toBe("https://meta.example/ndvi.xml");
    expect(a.bbox).toEqual([6, 36, 18, 47]);
  });
  it("un layer senza questi dati non ha le chiavi (e non eredita l'abstract del contenitore)", () => {
    const b = list.find((p) => p.name === "iride:vuoto")!;
    for (const k of ["abstract", "keywords", "attribution", "metadataUrl"]) expect(k in b).toBe(false);
  });
});

describe("getWfsCount", () => {
  it("legge numberMatched (WFS 2.0) e numberOfFeatures (1.1) senza scaricare gli oggetti", async () => {
    const f = mockFetch(() => ({ type: "text/xml", body: `<wfs:FeatureCollection numberMatched="1234" numberReturned="0"/>` }));
    expect(await getWfsCount("http://gs", null, "t:a", "x=1")).toBe(1234);
    const u = decodeURIComponent(String(f.mock.calls[0][0]));
    expect(u).toContain("resultType=hits");
    expect(u).toContain("cql_filter=x=1");
    mockFetch(() => ({ body: `<wfs:FeatureCollection numberOfFeatures="7"/>` }));
    expect(await getWfsCount("http://gs", null, "t:a")).toBe(7);
  });
  it("risposta senza numero -> null; ServiceException -> errore leggibile", async () => {
    mockFetch(() => ({ body: "<x/>" }));
    expect(await getWfsCount("http://gs", null, "t:a")).toBeNull();
    mockFetch(() => ({ status: 400, body: "<ServiceException>layer sconosciuto</ServiceException>" }));
    await expect(getWfsCount("http://gs", null, "t:a")).rejects.toThrow("layer sconosciuto");
  });
});
