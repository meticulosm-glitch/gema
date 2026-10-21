// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import DownloadPanel from "../src/DownloadPanel";
import type { Product } from "../src/capabilities";
import { el, fakeKc, mockFetch, XSD } from "./support";

const PARCELS_XSD = XSD("parcels", el("name", "xsd:string") + el("kind", "xsd:string") + `<xsd:element name="geom" type="gml:MultiPolygonPropertyType"/>`, "http://iride");
const WCS_CAPS = `<?xml version="1.0"?><wcs:Capabilities xmlns:wcs="http://www.opengis.net/wcs/2.0"><wcs:Contents><wcs:CoverageSummary><wcs:CoverageId>iride__ndvi</wcs:CoverageId></wcs:CoverageSummary></wcs:Contents></wcs:Capabilities>`;
const vec: Product = { name: "iride:parcels", title: "Particelle", workspace: "iride", vector: true };
const ras: Product = { name: "iride:ndvi", title: "NDVI", workspace: "iride", vector: false, bbox: [12, 41, 13, 42] };

/** Mappa finta: riquadro modificabile e moveend da far scattare nei test. */
function fakeMap(b: [number, number, number, number] = [12.4, 41.8, 12.6, 42]) {
  let box = b;
  const handlers = new Set<() => void>();
  return {
    getBounds: () => ({ toArray: () => [[box[0], box[1]], [box[2], box[3]]] }),
    on: (_: string, h: () => void) => { handlers.add(h); },
    off: (_: string, h: () => void) => { handlers.delete(h); },
    move: (nb: typeof b) => { box = nb; handlers.forEach((h) => h()); },
  };
}

let gsN = 0;
let saved: { name: string; size: number }[];
beforeEach(() => {
  saved = [];
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved.push({ name: this.download, size: 0 }); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** GeoServer finto: schema, conteggio, coperture WCS e file. Ogni test ha un URL suo (le cache sono per URL). */
function server(opts: { count?: number; wcs?: string; file?: { body: string; type: string } } = {}) {
  const calls: string[] = [];
  const gs = `http://gs${++gsN}/geoserver`;
  mockFetch((u) => {
    calls.push(u);
    if (u.includes("DescribeFeatureType")) return { type: "text/xml", body: PARCELS_XSD };
    if (u.includes("resultType=hits")) return { type: "text/xml", body: `<wfs:FeatureCollection numberMatched="${opts.count ?? 12}" numberReturned="0"/>` };
    if (u.includes("service=WCS") && u.includes("GetCapabilities")) return { type: "text/xml", body: opts.wcs ?? WCS_CAPS };
    return opts.file ?? { type: "application/json", body: '{"type":"FeatureCollection","features":[{}]}' };
  });
  const param = (u: string, k: string) => new URL(u).searchParams.get(k);
  const downloads = () => calls.filter((c) => /request=(GetFeature|GetCoverage)/.test(c) && !c.includes("resultType=hits"));
  return { gs, calls, param, downloads };
}

const mount = (product: Product, over: Partial<Parameters<typeof DownloadPanel>[0]> & { gs: string }) => {
  const map = fakeMap();
  const props = { gsUrl: over.gs, kc: fakeKc({}, "tok"), product, cql: "", time: "", map: map as never, onClose: vi.fn(), ...over };
  return { ...render(<DownloadPanel {...props} />), props, map };
};

describe("DownloadPanel: vettoriale", () => {
  it("mostra il conteggio nell'area visibile e scarica GeoJSON con filtro e area", async () => {
    const s = server({ count: 12345 });
    mount(vec, { gs: s.gs, cql: "kind = 'A'" });
    expect(await screen.findByText("12.345 oggetti")).toBeInTheDocument();
    expect(screen.getByText("kind = 'A'")).toBeInTheDocument();
    const hits = s.calls.find((c) => c.includes("resultType=hits"))!;
    expect(s.param(hits, "cql_filter")).toBe("(kind = 'A') AND BBOX(geom,12.4,41.8,12.6,42,'EPSG:4326')");
    fireEvent.click(screen.getByRole("button", { name: "Scarica" }));
    expect(await screen.findByText(/^Scaricato parcels_\d{8}-\d{4}\.geojson/)).toBeInTheDocument();
    const [d] = s.downloads();
    expect(s.param(d, "outputFormat")).toBe("application/json");
    expect(s.param(d, "cql_filter")).toBe("(kind = 'A') AND BBOX(geom,12.4,41.8,12.6,42,'EPSG:4326')");
    expect(s.param(d, "maxFeatures")).toBe("50000");
    expect(saved.map((x) => x.name)[0]).toMatch(/^parcels_.*\.geojson$/);
  });

  it("'Tutto il layer' toglie l'area dal filtro; senza filtro nessun cql_filter", async () => {
    const s = server();
    mount(vec, { gs: s.gs });
    await screen.findByText("12 oggetti");
    fireEvent.click(screen.getByLabelText("Tutto il layer"));
    await waitFor(() => expect(s.calls.filter((c) => c.includes("resultType=hits")).length).toBe(2));
    expect(s.param(s.calls.filter((c) => c.includes("resultType=hits"))[1], "cql_filter")).toBeNull();
  });

  it("Shapefile nel formato di GeoServer; la data della mappa non va al WFS e il pannello lo dice", async () => {
    const s = server({ file: { body: "PK\u0003\u0004zip", type: "application/zip" } });
    mount(vec, { gs: s.gs, time: "2026-02-01" });
    await screen.findByText("12 oggetti");
    fireEvent.change(screen.getByLabelText("Formato"), { target: { value: "shp" } });
    fireEvent.click(screen.getByRole("button", { name: "Scarica" }));
    await screen.findByText(/\.zip/);
    const [d] = s.downloads();
    expect(s.param(d, "outputFormat")).toBe("SHAPE-ZIP");
    expect(s.param(d, "time")).toBeNull();
    expect(s.param(d, "format_options")).toBe("CHARSET:UTF-8");
    expect(screen.getByText(/La data della mappa \(2026-02-01\) non si applica/)).toBeInTheDocument();
  });

  it("oltre il limite avvisa che si scaricano solo i primi N", async () => {
    const s = server({ count: 80000 });
    mount(vec, { gs: s.gs, maxFeatures: 10000 });
    expect(await screen.findByRole("status")).toHaveTextContent("solo i primi 10.000 oggetti");
    fireEvent.click(screen.getByRole("button", { name: "Scarica" }));
    await screen.findByText(/Scaricato/);
    expect(s.param(s.downloads()[0], "maxFeatures")).toBe("10000");
  });

  it("nessun oggetto: pulsante disattivato", async () => {
    const s = server({ count: 0 });
    mount(vec, { gs: s.gs });
    expect(await screen.findByText("Nessun oggetto con questi criteri")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scarica" })).toBeDisabled();
  });

  it("l'area segue la mappa mentre il pannello è aperto", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const s = server();
      const { map } = mount(vec, { gs: s.gs });
      await screen.findByText("12 oggetti");
      act(() => map.move([10, 40, 11, 41]));
      await act(async () => { await vi.advanceTimersByTimeAsync(700); });
      await waitFor(() => expect(s.calls.some((c) => (s.param(c, "cql_filter") ?? "").includes("BBOX(geom,10,40,11,41,"))).toBe(true));
    } finally {
      vi.useRealTimers();
    }
  });

  it("al clic usa l'area di quel momento, anche se la mappa si è appena spostata", async () => {
    const s = server();
    const { map } = mount(vec, { gs: s.gs });
    await screen.findByText("12 oggetti");
    act(() => map.move([5, 45, 6, 46])); // nessuna attesa: il conteggio è ancora quello vecchio
    fireEvent.click(screen.getByRole("button", { name: "Scarica" }));
    await screen.findByText(/Scaricato/);
    expect(s.param(s.downloads()[0], "cql_filter")).toBe("BBOX(geom,5,45,6,46,'EPSG:4326')");
  });

  it("errore di GeoServer mostrato all'utente, niente file salvato", async () => {
    const s = server({ file: { type: "application/vnd.ogc.se_xml", body: "<ServiceException>Illegal property name</ServiceException>" } });
    mount(vec, { gs: s.gs });
    await screen.findByText("12 oggetti");
    fireEvent.click(screen.getByRole("button", { name: "Scarica" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Scarico non riuscito: Illegal property name");
    expect(saved).toHaveLength(0);
  });

  it("chiusura", async () => {
    const s = server();
    const { props } = mount(vec, { gs: s.gs });
    fireEvent.click(screen.getByRole("button", { name: "Chiudi lo scarico" }));
    expect(props.onClose).toHaveBeenCalled();
  });
});

describe("DownloadPanel: raster", () => {
  it("GeoTIFF dell'area visibile ritagliata sull'estensione del layer, con la data", async () => {
    const s = server({ file: { type: "image/tiff", body: "II*\u0000tiff" } });
    const { map } = mount(ras, { gs: s.gs, time: "2026-06-01" });
    act(() => map.move([12.5, 41.5, 13.5, 42.5]));
    await act(() => new Promise((r) => setTimeout(r, 400))); // l'area segue la mappa dopo 300 ms
    const btn = await screen.findByRole("button", { name: "Scarica" });
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);
    await screen.findByText(/^Scaricato ndvi_.*\.tif/);
    const [d] = s.downloads();
    expect(s.param(d, "coverageId")).toBe("iride__ndvi");
    expect(new URL(d).searchParams.getAll("subset")).toEqual(["Long(12.5,13)", "Lat(41.5,42)", 'time("2026-06-01")']);
    expect(screen.getByText("Data: 2026-06-01")).toBeInTheDocument();
  });

  it("layer non pubblicato in WCS: avviso e pulsante disattivato", async () => {
    const s = server({ wcs: `<wcs:Capabilities xmlns:wcs="http://www.opengis.net/wcs/2.0"><wcs:Contents/></wcs:Capabilities>` });
    mount(ras, { gs: s.gs });
    expect(await screen.findByText(/non è pubblicato come copertura WCS/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scarica" })).toBeDisabled();
  });

  it("area visibile fuori dall'estensione del layer: avviso", async () => {
    const s = server();
    const { map } = mount(ras, { gs: s.gs });
    act(() => map.move([0, 0, 1, 1]));
    expect(await screen.findByText(/non contiene dati di questo layer/, {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scarica" })).toBeDisabled();
  });

  it("con un intervallo di date avvisa che si usa la data predefinita", async () => {
    const s = server();
    mount(ras, { gs: s.gs, time: "2026-01-01/2026-03-01" });
    expect(await screen.findByText(/si scarica la data predefinita/)).toBeInTheDocument();
  });
});
