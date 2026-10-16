// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fetchLegendBlob, getFeatureInfo, wmsTileUrl } from "../src/api";
import { parseCapabilities } from "../src/capabilities";
import { installDom } from "./dom";
import { mockFetch } from "./support";

installDom();

describe("stile (SLD)", () => {
  it("GetMap: styles vuoto per il predefinito, altrimenti il nome codificato", () => {
    expect(wmsTileUrl("/g", "a:b")).toContain("&styles=&format=");
    expect(wmsTileUrl("/g", "a:b", { style: "  ndvi div " })).toContain("&styles=ndvi%20div&format=");
  });

  it("GetFeatureInfo e legenda usano lo stesso stile", async () => {
    const map: any = { project: ([x, y]: number[]) => ({ x, y }), unproject: ([x, y]: number[]) => ({ lng: x, lat: y }) };
    const f = mockFetch(() => ({ body: JSON.stringify({ features: [] }) }));
    await getFeatureInfo("/g", null, "a:b", map, { lng: 1, lat: 1 }, { style: "ramp" });
    expect(String(f.mock.calls[0][0])).toContain("&styles=ramp&srs=");
    const g = mockFetch(() => ({ body: "png", type: "image/png" }));
    await fetchLegendBlob("/g", null, "a:b", "ramp");
    expect(String(g.mock.calls[0][0])).toContain("&style=ramp");
    await fetchLegendBlob("/g", null, "a:b");
    expect(String(g.mock.calls[1][0])).not.toContain("&style=");
  });

  it("GetFeatureInfo passa il segnale di annullamento solo se c'è", async () => {
    const map: any = { project: ([x, y]: number[]) => ({ x, y }), unproject: ([x, y]: number[]) => ({ lng: x, lat: y }) };
    const f = mockFetch(() => ({ body: JSON.stringify({ features: [] }) }));
    await getFeatureInfo("/g", null, "a:b", map, { lng: 1, lat: 1 });
    expect((f.mock.calls[0][1] as RequestInit).signal).toBeUndefined();
    const ctrl = new AbortController();
    await getFeatureInfo("/g", null, "a:b", map, { lng: 1, lat: 1 }, {}, ctrl.signal);
    expect((f.mock.calls[1][1] as RequestInit).signal).toBe(ctrl.signal);
  });

  it("GetCapabilities: stili del layer, senza doppioni e senza nomi vuoti", () => {
    const xml = `<WMS_Capabilities><Capability><Layer><Layer>
      <Name>iride:ndvi</Name><Title>NDVI</Title>
      <Style><Name>ndvi</Name><Title>NDVI classico</Title></Style>
      <Style><Name>ndvi_div</Name></Style>
      <Style><Name>ndvi</Name><Title>doppione</Title></Style>
      <Style><Title>senza nome</Title></Style>
    </Layer><Layer><Name>iride:plain</Name><Title>Plain</Title></Layer></Layer></Capability></WMS_Capabilities>`;
    const list = parseCapabilities(xml);
    expect(list.find((p) => p.name === "iride:ndvi")?.styles).toEqual([{ name: "ndvi", title: "NDVI classico" }, { name: "ndvi_div", title: "ndvi_div" }]);
    expect(list.find((p) => p.name === "iride:plain")?.styles).toBeUndefined();
  });
});
