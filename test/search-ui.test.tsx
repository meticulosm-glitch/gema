// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SearchBox from "../src/SearchBox";
import BasemapSwitcher from "../src/BasemapSwitcher";
import { defaultBasemaps } from "../src/basemaps";
import { el, mockFetch, XSD } from "./support";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const NOM = { type: "nominatim" as const, url: "/geocode", lang: "it" };
const PHO = { type: "photon" as const, url: "/geocode", lang: "it" };
const NOM_BODY = JSON.stringify([{ display_name: "Bari, Puglia, Italia", name: "Bari", lat: "41.1", lon: "16.8", boundingbox: ["41.0", "41.2", "16.7", "16.9"] }]);
const SCHEMA = XSD("citta", el("nome", "xsd:string") + el("g", "gml:PointPropertyType"), "http://x/t");

function routes(opts: { places?: string; features?: unknown[]; placeStatus?: number } = {}) {
  return mockFetch((u) => {
    if (u.startsWith("/geocode")) return { status: opts.placeStatus ?? 200, body: opts.places ?? NOM_BODY, type: "application/json" };
    if (u.includes("DescribeFeatureType")) return { type: "text/xml", body: SCHEMA };
    return { type: "application/json", body: JSON.stringify({ features: opts.features ?? [] }) };
  });
}
const base = { gsUrl: "http://gs/geoserver", kc: null, onPlace: () => {}, onHit: () => {} };
const input = () => screen.getByRole("searchbox", { name: "Cerca luoghi e oggetti" });

describe("SearchBox", () => {
  it("Nominatim: non cerca mentre si scrive, ma con Invio; il luogo trovato arriva a onPlace", async () => {
    const f = routes();
    const onPlace = vi.fn();
    render(<SearchBox {...base} geocoder={NOM} attrLayers={[]} onPlace={onPlace} />);
    fireEvent.change(input(), { target: { value: "Bari" } });
    await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
    expect(f).not.toHaveBeenCalled();
    expect(screen.getByText("Premi Invio per cercare.")).toBeInTheDocument();
    fireEvent.keyDown(input(), { key: "Enter" });
    const item = await screen.findByRole("option", { name: /Bari/ });
    expect(item).toHaveTextContent("Puglia, Italia");
    fireEvent.click(item);
    expect(onPlace).toHaveBeenCalledWith(expect.objectContaining({ label: "Bari", lng: 16.8, lat: 41.1, bbox: [16.7, 41, 16.9, 41.2] }));
    expect(screen.queryByRole("listbox")).toBeNull(); // si chiude dopo la scelta
  });

  it("Photon: cerca da solo dopo una pausa e solo da 3 caratteri", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const f = routes({ places: JSON.stringify({ features: [{ geometry: { coordinates: [9.19, 45.46] }, properties: { name: "Milano" } }] }) });
    render(<SearchBox {...base} geocoder={PHO} attrLayers={[]} />);
    fireEvent.change(input(), { target: { value: "Mi" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(f).not.toHaveBeenCalled();
    fireEvent.change(input(), { target: { value: "Milan" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(await screen.findByRole("option", { name: /Milano/ })).toBeInTheDocument();
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0][0])).toContain("/geocode/api?q=Milan");
  });

  it("cerca anche negli attributi dei layer attivi; il risultato arriva a onHit con layer e oggetto", async () => {
    routes({ features: [{ id: "citta.1", geometry: { type: "Point", coordinates: [1, 2] }, properties: { nome: "Bari vecchia" } }] });
    const onHit = vi.fn();
    render(<SearchBox {...base} geocoder={NOM} attrLayers={[{ name: "t:citta", title: "Città" }]} onHit={onHit} />);
    fireEvent.change(input(), { target: { value: "bari" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: /Bari vecchia/ }));
    expect(onHit).toHaveBeenCalledWith(expect.objectContaining({ layer: "t:citta", title: "Città", label: "Bari vecchia" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("senza geocoder cerca solo negli attributi (con ricerca automatica) e suggerisce di accendere un layer", async () => {
    routes();
    render(<SearchBox {...base} attrLayers={[]} />);
    expect(input()).toHaveAttribute("placeholder", expect.stringContaining("attributi"));
    fireEvent.change(input(), { target: { value: "abc" } });
    expect(await screen.findByText(/Accendi un layer vettoriale/)).toBeInTheDocument();
  });

  it("nessun risultato e errori del servizio sono mostrati senza rompere la ricerca negli attributi", async () => {
    routes({ places: "[]" });
    const { unmount } = render(<SearchBox {...base} geocoder={NOM} attrLayers={[]} />);
    fireEvent.change(input(), { target: { value: "zzzz" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(await screen.findByText(/Nessun risultato per «zzzz»/)).toBeInTheDocument();
    unmount();

    routes({ placeStatus: 429, features: [{ id: "c.1", geometry: null, properties: { nome: "Zzzz" } }] });
    render(<SearchBox {...base} geocoder={NOM} attrLayers={[{ name: "t:citta", title: "Città" }]} />);
    fireEvent.change(input(), { target: { value: "zzzz" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(await screen.findByText(/troppe richieste/)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Zzzz/ })).toBeInTheDocument();
  });

  it("una ricerca più recente scarta la risposta di quella vecchia", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    mockFetch(async (u) => {
      if (u.includes("q=lenta")) { await gate; return { type: "application/json", body: JSON.stringify([{ display_name: "Vecchia", lat: "1", lon: "1" }]) }; }
      return { type: "application/json", body: JSON.stringify([{ display_name: "Nuova", lat: "2", lon: "2" }]) };
    });
    render(<SearchBox {...base} geocoder={NOM} attrLayers={[]} />);
    fireEvent.change(input(), { target: { value: "lenta" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.change(input(), { target: { value: "veloce" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(await screen.findByRole("option", { name: /Nuova/ })).toBeInTheDocument();
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByRole("option", { name: /Vecchia/ })).toBeNull();
    expect(screen.getByRole("option", { name: /Nuova/ })).toBeInTheDocument();
  });

  it("Escape chiude l'elenco, la X cancella la ricerca; ArrowDown porta sul primo risultato", async () => {
    routes();
    render(<SearchBox {...base} geocoder={NOM} attrLayers={[]} />);
    fireEvent.change(input(), { target: { value: "Bari" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    const item = await screen.findByRole("option", { name: /Bari/ });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(item).toHaveFocus();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancella la ricerca" }));
    expect(input()).toHaveValue("");
  });
});

describe("BasemapSwitcher", () => {
  const list = defaultBasemaps("https://t/{z}/{x}/{y}.png");
  it("un pulsante per sfondo, quello attivo è selezionato e la scelta arriva a onChange", () => {
    const onChange = vi.fn();
    render(<BasemapSwitcher list={list} value="osm" onChange={onChange} />);
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Mappa", "Satellite", "Scuro", "Nessuno"]);
    expect(screen.getByRole("radio", { name: "Mappa" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Satellite" }));
    expect(onChange).toHaveBeenCalledWith("sat");
  });
  it("con un solo sfondo non mostra nulla", () => {
    const { container } = render(<BasemapSwitcher list={list.slice(0, 1)} value="osm" onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("SearchBox: risultati e testo", () => {
  it("Nominatim: cambiando il testo i risultati della ricerca precedente spariscono e torna l invito a premere Invio", async () => {
    routes();
    render(<SearchBox {...base} geocoder={NOM} attrLayers={[]} />);
    fireEvent.change(input(), { target: { value: "Bari" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await screen.findByRole("option", { name: /Bari/ });
    fireEvent.change(input(), { target: { value: "Torino" } });
    expect(screen.queryByRole("option", { name: /Bari/ })).toBeNull();
    expect(screen.getByText("Premi Invio per cercare.")).toBeInTheDocument();
  });

  it("Nominatim: una ricerca ancora in corso non porta risultati del testo vecchio", async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => { release = r; });
    vi.stubGlobal("fetch", vi.fn(async (u: RequestInfo | URL) => {
      if (String(u).startsWith("/geocode")) { await gate; return new Response(NOM_BODY, { status: 200, headers: { "Content-Type": "application/json" } }); }
      return new Response("{}", { status: 200 });
    }));
    render(<SearchBox {...base} geocoder={NOM} attrLayers={[]} />);
    fireEvent.change(input(), { target: { value: "Bari" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.change(input(), { target: { value: "Torino" } });
    await act(async () => { release(null); await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByRole("option", { name: /Bari/ })).toBeNull();
  });
});
