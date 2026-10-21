// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampBounds, coverageId, cqlIdent, downloadFilter, downloadName, fetchDownload, fmtBytes, intersect, layerFromCoverageId,
  saveBlob, singleInstant, vectorFormat, VECTOR_FORMATS, wcsDownloadUrl, wfsDownloadUrl,
} from "../src/download";
import { parseWcsCoverages } from "../src/capabilities";

const GS = "https://app.example/geoserver";
const q = (url: string) => new URL(url).searchParams;

afterEach(() => vi.unstubAllGlobals());

describe("filtro dello scarico vettoriale", () => {
  it("solo il filtro del layer, tra parentesi", () => {
    expect(downloadFilter("geom", "kind = 'A' OR kind = 'B'", null)).toBe("(kind = 'A' OR kind = 'B')");
  });
  it("solo l'area: BBOX sulla colonna geometrica in EPSG:4326", () => {
    expect(downloadFilter("the_geom", "", [12.4, 41.8, 12.6, 42])).toBe("BBOX(the_geom,12.4,41.8,12.6,42,'EPSG:4326')");
  });
  it("filtro e area insieme, con AND", () => {
    expect(downloadFilter("geom", " area > 10 ", [1, 2, 3, 4])).toBe("(area > 10) AND BBOX(geom,1,2,3,4,'EPSG:4326')");
  });
  it("niente filtro né area: stringa vuota (tutto il layer)", () => {
    expect(downloadFilter("geom", "  ", null)).toBe("");
  });
  it("una colonna geometrica con caratteri speciali va tra virgolette", () => {
    expect(cqlIdent("Geometria 1")).toBe('"Geometria 1"');
    expect(cqlIdent('a"b')).toBe('"a""b"');
    expect(downloadFilter("Geometria 1", "", [0, 0, 1, 1])).toContain('BBOX("Geometria 1",');
  });
  it("l'area della mappa oltre l'antimeridiano viene riportata entro ±180/±90, con al massimo 6 decimali", () => {
    expect(clampBounds([-200, -95, 250, 91])).toEqual([-180, -90, 180, 90]);
    expect(downloadFilter("g", "", [12.123456789, 41.1, 12.2, 41.2])).toContain("12.123457,");
  });
});

describe("URL WFS dello scarico", () => {
  it.each(VECTOR_FORMATS.map((f) => [f.id, f.outputFormat] as const))("%s -> outputFormat=%s", (id, of) => {
    const u = q(wfsDownloadUrl(GS, "iride:parcels", id, { max: 100 }));
    expect(u.get("service")).toBe("WFS");
    expect(u.get("version")).toBe("1.0.0");
    expect(u.get("request")).toBe("GetFeature");
    expect(u.get("typeName")).toBe("iride:parcels");
    expect(u.get("outputFormat")).toBe(of);
    expect(u.get("srsName")).toBe("EPSG:4326");
    expect(u.get("maxFeatures")).toBe("100");
  });
  it("filtro e data codificati, Shapefile in UTF-8", () => {
    const url = wfsDownloadUrl(GS, "iride:parcels", "shp", { filter: "name = 'Città & co' AND BBOX(geom,1,2,3,4,'EPSG:4326')", time: "2026-02-01", max: 5000 });
    expect(url.startsWith(`${GS}/ows?`)).toBe(true);
    const u = q(url);
    expect(u.get("cql_filter")).toBe("name = 'Città & co' AND BBOX(geom,1,2,3,4,'EPSG:4326')");
    expect(u.get("time")).toBe("2026-02-01");
    expect(u.get("format_options")).toBe("CHARSET:UTF-8");
    expect(url).not.toContain("&co'"); // la & nel valore è codificata
  });
  it("senza filtro né data i parametri non compaiono; il tetto è almeno 1 e intero", () => {
    const u = q(wfsDownloadUrl(GS, "a:b", "csv", { filter: " ", time: "", max: 0.5 }));
    expect(u.has("cql_filter")).toBe(false);
    expect(u.has("time")).toBe(false);
    expect(u.has("format_options")).toBe(false);
    expect(u.get("maxFeatures")).toBe("1");
  });
  it("formato sconosciuto: GeoJSON", () => {
    expect(vectorFormat("xyz" as never).id).toBe("geojson");
  });
});

describe("URL WCS dello scarico", () => {
  it("GetCoverage 2.0.1 in GeoTIFF, ritagliata in lon/lat", () => {
    const u = q(wcsDownloadUrl(GS, "iride:ndvi", [12.4, 41.8, 12.6, 42.0]));
    expect(u.get("service")).toBe("WCS");
    expect(u.get("version")).toBe("2.0.1");
    expect(u.get("request")).toBe("GetCoverage");
    expect(u.get("coverageId")).toBe("iride__ndvi");
    expect(u.get("format")).toBe("image/tiff");
    expect(u.getAll("subset")).toEqual(["Long(12.4,12.6)", "Lat(41.8,42)"]);
    expect(u.get("subsettingCRS")).toBe("http://www.opengis.net/def/crs/EPSG/0/4326");
  });
  it("con un istante aggiunge il taglio temporale, con un intervallo no", () => {
    expect(q(wcsDownloadUrl(GS, "a:b", [0, 0, 1, 1], "2026-06-01")).getAll("subset")).toContain('time("2026-06-01")');
    expect(q(wcsDownloadUrl(GS, "a:b", [0, 0, 1, 1], "2026-01-01/2026-02-01")).getAll("subset")).toHaveLength(2);
    expect(singleInstant(" 2026-06-01T10:00:00Z ")).toBe("2026-06-01T10:00:00Z");
    expect(singleInstant("2026-01-01,2026-02-01")).toBeNull();
    expect(singleInstant("")).toBeNull();
  });
  it("id della copertura: solo il primo ':' diventa '__', e ritorno", () => {
    expect(coverageId("iride:S1_01")).toBe("iride__S1_01");
    expect(layerFromCoverageId("iride__S1__x")).toBe("iride:S1__x");
  });
  it("intersezione tra area visibile ed estensione del layer", () => {
    expect(intersect([0, 0, 10, 10], [5, 5, 20, 20])).toEqual([5, 5, 10, 10]);
    expect(intersect([0, 0, 1, 1], [5, 5, 6, 6])).toBeNull();
    expect(intersect([0, 0, 1, 1])).toEqual([0, 0, 1, 1]);
  });
});

describe("elenco delle coperture WCS", () => {
  it("legge i CoverageId (con o senza prefisso) e li riporta a ws:nome", () => {
    const xml = `<?xml version="1.0"?><wcs:Capabilities xmlns:wcs="http://www.opengis.net/wcs/2.0"><wcs:Contents>
      <wcs:CoverageSummary><wcs:CoverageId>iride__ndvi</wcs:CoverageId></wcs:CoverageSummary>
      <wcs:CoverageSummary><CoverageId> dem__srtm </CoverageId></wcs:CoverageSummary></wcs:Contents></wcs:Capabilities>`;
    expect([...parseWcsCoverages(xml)].sort()).toEqual(["dem:srtm", "iride:ndvi"]);
  });
  it("XML non valido: errore", () => {
    expect(() => parseWcsCoverages("<<<")).toThrow();
  });
});

describe("nome del file", () => {
  it("nome del layer senza workspace, data e ora, estensione", () => {
    expect(downloadName("iride:S1 01/bis", "zip", new Date(2026, 9, 20, 8, 5))).toBe("S1_01_bis_20261020-0805.zip");
    expect(downloadName("::", "csv", new Date(2026, 0, 2, 3, 4))).toBe("dati_20260102-0304.csv");
  });
  it("dimensioni leggibili", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2048)).toBe("2,0 KB");
    expect(fmtBytes(3.5 * 1024 * 1024)).toBe("3,5 MB");
  });
});

describe("fetchDownload", () => {
  const respond = (body: BodyInit, type: string, status = 200) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status, headers: { "Content-Type": type } })));

  it("restituisce il file e manda il Bearer dell'utente", async () => {
    respond("a,b\n1,2\n", "text/csv;charset=UTF-8");
    const b = await fetchDownload(`${GS}/ows?x`, { token: "tok" } as never, "text");
    expect(await b.text()).toBe("a,b\n1,2\n");
    expect((fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1].headers).toEqual({ Authorization: "Bearer tok" });
  });
  it("senza Keycloak nessun header", async () => {
    respond(new Uint8Array([80, 75, 3, 4]), "application/zip");
    await fetchDownload("u", null, "binary");
    expect((fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1].headers).toEqual({});
  });
  it("eccezione di GeoServer con status 200: errore con il suo messaggio", async () => {
    respond('<?xml version="1.0"?><ServiceExceptionReport><ServiceException>Illegal property name: nope</ServiceException></ServiceExceptionReport>', "application/vnd.ogc.se_xml");
    await expect(fetchDownload("u", null, "binary")).rejects.toThrow("Illegal property name: nope");
  });
  it("ExceptionReport OWS (WCS 2.0) con status 404", async () => {
    respond('<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/2.0"><ows:Exception><ows:ExceptionText>no coverage</ows:ExceptionText></ows:Exception></ows:ExceptionReport>', "application/xml", 404);
    await expect(fetchDownload("u", null, "binary")).rejects.toThrow("no coverage");
  });
  it("pagina HTML (es. login o errore del proxy) al posto del file: errore", async () => {
    respond("<html>login</html>", "text/html");
    await expect(fetchDownload("u", null, "json")).rejects.toThrow("GeoServer non ha restituito un file");
  });
  it("401 e 403 con messaggi chiari", async () => {
    respond("no", "text/plain", 401);
    await expect(fetchDownload("u", null, "binary")).rejects.toThrow("non autorizzato (HTTP 401)");
    respond("no", "text/plain", 403);
    await expect(fetchDownload("u", null, "binary")).rejects.toThrow("accesso negato (HTTP 403)");
  });
  it("file vuoto: errore", async () => {
    respond("", "application/zip");
    await expect(fetchDownload("u", null, "binary")).rejects.toThrow("file vuoto");
  });
  it("GeoJSON con content-type JSON accettato", async () => {
    respond('{"type":"FeatureCollection","features":[]}', "application/json;charset=UTF-8");
    expect(JSON.parse(await (await fetchDownload("u", null, "json")).text()).type).toBe("FeatureCollection");
  });
});

describe("saveBlob", () => {
  it("crea un link con il nome del file, lo clicca e lo rimuove", () => {
    const urls: string[] = [];
    URL.createObjectURL = vi.fn(() => { urls.push("blob:x"); return "blob:x"; });
    URL.revokeObjectURL = vi.fn();
    const clicks: string[] = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { clicks.push(this.download); };
    try {
      saveBlob(new Blob(["x"]), "f.csv");
    } finally {
      HTMLAnchorElement.prototype.click = orig;
    }
    expect(clicks).toEqual(["f.csv"]);
    expect(urls).toHaveLength(1);
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
  });
});
