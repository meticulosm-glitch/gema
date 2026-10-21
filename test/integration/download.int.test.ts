// @vitest-environment jsdom
// Scarico dei dati con GeoServer vero: le funzioni dell'app (src/download.ts) contro un layer PostGIS e una copertura
// GeoTIFF pubblicati per il test. Verifica i formati che produce GeoServer (GeoJSON, CSV, Shapefile zip, GeoTIFF),
// l'ordine lon/lat, il ritaglio WCS 2.0 in EPSG:4326, gli accenti e i messaggi di errore.
import { fromArrayBuffer, writeArrayBuffer } from "geotiff";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { describeLayer, getWfsCount } from "../../src/api";
import { fetchCoverageNames } from "../../src/capabilities";
import { downloadFilter, fetchDownload, wcsDownloadUrl, wfsDownloadUrl, type Bounds } from "../../src/download";
import { gs, missing, pg, preparedWorkspace, psqlAdmin, readZip, required } from "./support";

const enabled = !!gs && gs.publish && !!pg;
if (!enabled && required) throw new Error(missing("GeoServer", "INT_GEOSERVER_URL e PostgreSQL (INT_PGHOST, ...)"));

/** GeoTIFF 40x20 in EPSG:4326 da 12°E a 13°E e da 41,5°N a 42°N (pixel di 0,025°). */
async function sampleTiff(): Promise<ArrayBuffer> {
  const w = 40, h = 20;
  const values = new Uint8Array(w * h).map((_, i) => (i * 7) % 255);
  return writeArrayBuffer(values, {
    width: w, height: h, ModelPixelScale: [0.025, 0.025, 0], ModelTiepoint: [0, 0, 0, 12, 42, 0],
    GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1, GeogCitationGeoKey: "WGS 84",
  } as never) as unknown as ArrayBuffer;
}

describe.skipIf(!enabled)("scarico dati con GeoServer reale", () => {
  let w: Awaited<ReturnType<typeof preparedWorkspace>>;
  const G = gs ?? { url: "", user: "", password: "" };
  const layer = () => `${w.ws}:punti_dl`;
  const cov = () => `${w.ws}:dem_dl`;

  beforeAll(async () => {
    w = await preparedWorkspace("gema_dl");
    psqlAdmin(
      "CREATE TABLE gema_config.punti_dl (id serial PRIMARY KEY, nome text, tipo text, geom geometry(Point, 4326));" +
        "INSERT INTO gema_config.punti_dl (nome, tipo, geom) VALUES" +
        " ('Colosseo', 'A', ST_SetSRID(ST_MakePoint(12.4922, 41.8902), 4326))," +
        " ('San Pietro', 'A', ST_SetSRID(ST_MakePoint(12.4539, 41.9022), 4326))," +
        " ('Città di Castello', 'B', ST_SetSRID(ST_MakePoint(12.2400, 43.4600), 4326));",
      w.db,
    );
    const ft = await w.rest("POST", `/workspaces/${w.ws}/datastores/gema_config/featuretypes`, {
      featureType: { name: "punti_dl", nativeName: "punti_dl", title: "Punti scarico", srs: "EPSG:4326", enabled: true },
    });
    if (ft.status !== 201) throw new Error(`pubblicazione di punti_dl: HTTP ${ft.status} ${await ft.text()}`);
    const tif = await fetch(`${G.url}/rest/workspaces/${w.ws}/coveragestores/dem_dl/file.geotiff?configure=first&coverageName=dem_dl`, {
      method: "PUT", headers: { Authorization: w.basic, "Content-Type": "image/tiff" }, body: await sampleTiff(),
    });
    if (tif.status !== 201) throw new Error(`caricamento del GeoTIFF: HTTP ${tif.status} ${await tif.text()}`);
    // le richieste dell'app ricevono la Basic come se passassero dal proxy nginx
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(G.url)) return realFetch(input, init);
      const headers = new Headers(init.headers);
      if (!headers.has("Authorization")) headers.set("Authorization", w.basic);
      return realFetch(input, { ...init, headers });
    });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await w?.cleanup();
  });

  const text = async (b: Blob) => Buffer.from(await b.arrayBuffer()).toString("utf8");
  const ROMA: Bounds = [12.47, 41.85, 12.52, 41.95]; // contiene il Colosseo, non San Pietro

  it("GeoJSON con filtro e area: solo gli oggetti giusti, coordinate lon/lat", async () => {
    const s = await describeLayer(G.url, null, layer());
    const filter = downloadFilter(s.geomName, "tipo = 'A'", ROMA);
    expect(await getWfsCount(G.url, null, layer(), filter)).toBe(1);
    const gj = JSON.parse(await text(await fetchDownload(wfsDownloadUrl(G.url, layer(), "geojson", { filter, max: 100 }), null, "json")));
    expect(gj.features).toHaveLength(1);
    expect(gj.features[0].properties.nome).toBe("Colosseo");
    const [lon, lat] = gj.features[0].geometry.coordinates;
    expect(lon).toBeCloseTo(12.4922, 4);
    expect(lat).toBeCloseTo(41.8902, 4);
  });

  it("CSV di tutto il layer: intestazione, accenti in UTF-8, geometria in WKT", async () => {
    const csv = await text(await fetchDownload(wfsDownloadUrl(G.url, layer(), "csv", { max: 100 }), null, "text"));
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toMatch(/nome/);
    expect(lines[0]).toMatch(/tipo/);
    expect(lines).toHaveLength(4);
    expect(csv).toContain("Città di Castello");
    expect(csv).toMatch(/POINT \(12\.49/);
  });

  it("Shapefile: zip con .shp .shx .dbf .prj e nomi accentati in UTF-8 nel .dbf", async () => {
    const blob = await fetchDownload(wfsDownloadUrl(G.url, layer(), "shp", { max: 100 }), null, "binary");
    const zip = readZip(Buffer.from(await blob.arrayBuffer()));
    const names = [...zip.keys()];
    for (const ext of ["shp", "shx", "dbf", "prj"]) expect(names.some((n) => n.toLowerCase().endsWith(`.${ext}`)), `${ext} in ${names.join(",")}`).toBe(true);
    const dbf = [...zip.entries()].find(([n]) => n.toLowerCase().endsWith(".dbf"))![1];
    expect(dbf.includes(Buffer.from("Città di Castello", "utf8"))).toBe(true);
    const prj = [...zip.entries()].find(([n]) => n.toLowerCase().endsWith(".prj"))![1].toString();
    expect(prj).toMatch(/WGS.?84/i);
  });

  it("il tetto agli oggetti viene rispettato", async () => {
    const gj = JSON.parse(await text(await fetchDownload(wfsDownloadUrl(G.url, layer(), "geojson", { max: 2 }), null, "json")));
    expect(gj.features).toHaveLength(2);
  });

  it("un filtro sbagliato dà il messaggio di GeoServer, non un file", async () => {
    const e = await fetchDownload(wfsDownloadUrl(G.url, layer(), "geojson", { filter: "colonna_inesistente = 1", max: 10 }), null, "json").then(() => null, (x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e!.message).not.toBe("GeoServer non ha restituito un file");
    expect(e!.message.length).toBeGreaterThan(5);
  });

  it("la copertura caricata compare tra quelle scaricabili (WCS)", async () => {
    expect((await fetchCoverageNames(G.url)).has(cov())).toBe(true);
  });

  it("GeoTIFF ritagliato sull'area richiesta, georeferenziato", async () => {
    const area: Bounds = [12.2, 41.6, 12.5, 41.9];
    const blob = await fetchDownload(wcsDownloadUrl(G.url, cov(), area), null, "binary");
    const img = await (await fromArrayBuffer(await blob.arrayBuffer())).getImage();
    const [x0, y0, x1, y1] = img.getBoundingBox();
    const tol = 0.03; // GeoServer allinea il ritaglio ai pixel (0,025°)
    expect(x0).toBeGreaterThanOrEqual(area[0] - tol);
    expect(x1).toBeLessThanOrEqual(area[2] + tol);
    expect(y0).toBeGreaterThanOrEqual(area[1] - tol);
    expect(y1).toBeLessThanOrEqual(area[3] + tol);
    expect(img.getWidth()).toBeLessThan(40); // non l'intera copertura
    expect(img.getWidth()).toBeGreaterThan(5);
  });

  it("una copertura inesistente dà il messaggio di GeoServer", async () => {
    const e = await fetchDownload(wcsDownloadUrl(G.url, `${w.ws}:non_esiste`, [12, 41.5, 13, 42]), null, "binary").then(() => null, (x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e!.message.length).toBeGreaterThan(5);
  });
});
