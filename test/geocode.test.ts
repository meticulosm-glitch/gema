import { afterEach, describe, expect, it, vi } from "vitest";
import { geocodeUrl, parseNominatim, parsePhoton, searchPlaces, type GeocoderConfig } from "../src/geocode";
import { mockFetch } from "./support";

afterEach(() => vi.unstubAllGlobals());
const NOM: GeocoderConfig = { type: "nominatim", url: "/geocode", country: "IT", lang: "it" };
const PHO: GeocoderConfig = { type: "photon", url: "/geocode/", lang: "it" };

describe("geocodeUrl", () => {
  it("Nominatim: jsonv2, lingua, paese in minuscolo, query codificata", () => {
    const u = geocodeUrl(NOM, "via Roma 1, Bari & co");
    expect(u).toBe("/geocode/search?q=via%20Roma%201%2C%20Bari%20%26%20co&format=jsonv2&limit=6&accept-language=it&countrycodes=it");
  });
  it("Nominatim senza paese", () => {
    expect(geocodeUrl({ type: "nominatim", url: "/g" }, "x")).not.toContain("countrycodes");
  });
  it("Photon: /api, lingua e bias sulla posizione della mappa", () => {
    const u = geocodeUrl(PHO, "Bari", { lng: 16.87, lat: 41.12 });
    expect(u).toBe("/geocode/api?q=Bari&limit=6&lang=it&lat=41.1200&lon=16.8700");
    expect(geocodeUrl(PHO, "Bari")).not.toContain("lat=");
  });
});

describe("parseNominatim", () => {
  it("etichetta, dettaglio e riquadro (da [sud,nord,ovest,est] a [ovest,sud,est,nord])", () => {
    const r = parseNominatim([{ display_name: "Bari, Città metropolitana di Bari, Puglia, Italia", name: "Bari", lat: "41.1", lon: "16.8", boundingbox: ["41.0", "41.2", "16.7", "16.9"] }]);
    expect(r).toEqual([{ label: "Bari", sub: "Città metropolitana di Bari, Puglia, Italia", lng: 16.8, lat: 41.1, bbox: [16.7, 41.0, 16.9, 41.2] }]);
  });
  it("senza name usa il primo pezzo di display_name; scarta righe senza coordinate; input non array -> []", () => {
    const r = parseNominatim([{ display_name: "Via Roma, Bari", lat: "1", lon: "2" }, { display_name: "x", lat: "abc", lon: "2" }, {}]);
    expect(r.length).toBe(1);
    expect(r[0].label).toBe("Via Roma");
    expect(r[0].bbox).toBeUndefined();
    expect(parseNominatim({ error: "x" })).toEqual([]);
    expect(parseNominatim(null)).toEqual([]);
  });
});

describe("parsePhoton", () => {
  it("nome, indirizzo e riquadro (extent [ovest,nord,est,sud])", () => {
    const r = parsePhoton({ features: [
      { geometry: { coordinates: [16.8, 41.1] }, properties: { name: "Bari", state: "Puglia", country: "Italia", extent: [16.7, 41.2, 16.9, 41.0] } },
      { geometry: { coordinates: [9.19, 45.46] }, properties: { street: "Via Dante", housenumber: "5", city: "Milano", postcode: "20121", country: "Italia" } },
      { geometry: { coordinates: ["x", 1] }, properties: { name: "rotto" } },
    ] });
    expect(r.length).toBe(2);
    expect(r[0]).toMatchObject({ label: "Bari", lng: 16.8, lat: 41.1, bbox: [16.7, 41.0, 16.9, 41.2] });
    expect(r[0].sub).toBe("Puglia, Italia");
    expect(r[1].label).toBe("Via Dante 5");
    expect(r[1].sub).toBe("20121, Milano, Italia");
    expect(parsePhoton({})).toEqual([]);
  });
});

describe("searchPlaces", () => {
  it("meno di 3 caratteri: nessuna richiesta", async () => {
    const f = mockFetch(() => ({ body: "[]" }));
    expect(await searchPlaces(NOM, " ab ")).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
  it("richiesta e parsing, senza mandare Authorization", async () => {
    const f = mockFetch(() => ({ body: JSON.stringify([{ display_name: "Roma, Lazio", lat: "41.9", lon: "12.5" }]) }));
    const r = await searchPlaces(NOM, "Roma");
    expect(r[0].label).toBe("Roma");
    const init = f.mock.calls[0][1] as RequestInit;
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization/i);
  });
  it("429 -> messaggio chiaro; altri errori -> HTTP; risposta non JSON -> errore", async () => {
    mockFetch(() => ({ status: 429 }));
    await expect(searchPlaces(NOM, "Roma")).rejects.toThrow(/troppe richieste/);
    mockFetch(() => ({ status: 502 }));
    await expect(searchPlaces(NOM, "Roma")).rejects.toThrow(/HTTP 502/);
    mockFetch(() => ({ body: "<html>" }));
    await expect(searchPlaces(NOM, "Roma")).rejects.toThrow(/non valida/);
  });
  it("con Photon usa il parser GeoJSON", async () => {
    mockFetch(() => ({ body: JSON.stringify({ features: [{ geometry: { coordinates: [1, 2] }, properties: { name: "P" } }] }) }));
    expect((await searchPlaces(PHO, "abc"))[0]).toMatchObject({ label: "P", lng: 1, lat: 2 });
  });
});
