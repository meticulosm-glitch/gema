// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// maplibre-gl finto: serve solo a verificare come il confronto lo usa (in jsdom non c'è WebGL)
const created: any[] = [];
vi.mock("maplibre-gl", () => {
  class FakeMap {
    opts: any; handlers: Record<string, Function[]> = {}; layers = new Set(["base", "wms-b"]); setTiles = vi.fn(); removed = false;
    paint: Record<string, unknown> = {}; jumps: any[] = [];
    constructor(opts: any) { this.opts = opts; created.push(this); }
    once(ev: string, fn: Function) { (this.handlers[ev] ??= []).push(fn); }
    fire(ev: string) { (this.handlers[ev] ?? []).forEach((f) => f()); }
    getSource(id: string) { return id === "wms-b" ? { setTiles: this.setTiles } : undefined; }
    getLayer(id: string) { return this.layers.has(id) ? {} : undefined; }
    setPaintProperty(_l: string, k: string, v: unknown) { this.paint[k] = v; }
    jumpTo(o: any) { this.jumps.push(o); }
    resize() {}
    remove() { this.removed = true; }
  }
  return { Map: FakeMap };
});

const { CompareView, ComparePanel } = await import("../src/Compare");

function fakeMain() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const handlers: Record<string, Function[]> = {};
  const state = { center: { lng: 12, lat: 42 }, zoom: 8, bearing: 0, pitch: 0 };
  return {
    container, handlers, state,
    getContainer: () => container,
    getCenter: () => state.center, getZoom: () => state.zoom, getBearing: () => state.bearing, getPitch: () => state.pitch,
    on: (ev: string, fn: Function) => { (handlers[ev] ??= []).push(fn); },
    off: (ev: string, fn: Function) => { handlers[ev] = (handlers[ev] ?? []).filter((f) => f !== fn); },
  } as any;
}

beforeEach(() => {
  created.length = 0;
  (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
});
afterEach(cleanup);

const baseProps = (map: any) => ({
  map, gsUrl: "https://h/geoserver", kc: null, basemapTiles: "https://t/{z}/{x}/{y}.png",
  layer: "iride:ndvi", params: { time: "2026-01-01" }, opacity: 0.8, labelA: "NDVI · 2026-03-01", labelB: "NDVI · 2026-01-01",
});

describe("CompareView", () => {
  it("crea una seconda mappa nel contenitore della principale, con base e layer B, senza interazione", () => {
    const main = fakeMain();
    render(<CompareView {...baseProps(main)} />);
    expect(created).toHaveLength(1);
    const o = created[0].opts;
    expect(o.interactive).toBe(false);
    expect(o.container.parentElement).toBe(main.container);
    expect(o.container.className).toContain("compare-host");
    expect(o.style.sources["wms-b"].tiles[0]).toContain("layers=iride%3Andvi");
    expect(o.style.sources["wms-b"].tiles[0]).toContain("&time=2026-01-01");
    expect(o.style.layers.map((l: any) => l.id)).toEqual(["base", "wms-b"]);
    expect(o.style.layers[1].paint["raster-opacity"]).toBe(0.8);
  });

  it("ritaglia il lato destro in base al cursore", () => {
    const main = fakeMain();
    render(<CompareView {...baseProps(main)} />);
    const host = created[0].opts.container as HTMLElement;
    expect(host.style.clipPath).toBe("inset(0 0 0 50%)");
    const h = screen.getByRole("slider", { name: "Cursore di confronto" });
    fireEvent.keyDown(h, { key: "ArrowRight" });
    expect(host.style.clipPath).toBe("inset(0 0 0 52%)");
    fireEvent.keyDown(h, { key: "End" });
    expect(host.style.clipPath).toBe("inset(0 0 0 97%)");
    fireEvent.keyDown(h, { key: "Home" });
    expect(host.style.clipPath).toBe("inset(0 0 0 3%)");
    expect(h).toHaveAttribute("aria-valuenow", "3");
  });

  it("segue la mappa principale e smette quando il confronto si chiude", () => {
    const main = fakeMain();
    const { unmount } = render(<CompareView {...baseProps(main)} />);
    main.state.zoom = 11; main.state.bearing = 30;
    act(() => { main.handlers.move.forEach((f: Function) => f()); });
    expect(created[0].jumps.at(-1)).toMatchObject({ zoom: 11, bearing: 30 });
    const host = created[0].opts.container;
    unmount();
    expect(created[0].removed).toBe(true);
    expect(main.container.contains(host)).toBe(false);
    expect(main.handlers.move).toHaveLength(0);
  });

  it("cambio di data o layer a destra: nuovi tile, senza ricreare la mappa; opacità aggiornata", () => {
    const main = fakeMain();
    const { rerender } = render(<CompareView {...baseProps(main)} />);
    act(() => created[0].fire("load"));
    rerender(<CompareView {...baseProps(main)} params={{ time: "2026-02-01" }} />);
    expect(created).toHaveLength(1);
    expect(created[0].setTiles.mock.calls.at(-1)[0][0]).toContain("&time=2026-02-01");
    rerender(<CompareView {...baseProps(main)} layer="iride:evi" params={{ time: "" }} opacity={0.4} />);
    expect(created[0].setTiles.mock.calls.at(-1)[0][0]).toContain("layers=iride%3Aevi");
    expect(created[0].paint["raster-opacity"]).toBe(0.4);
  });

  it("un cambio prima che lo stile sia pronto non va perso", () => {
    const main = fakeMain();
    const { rerender } = render(<CompareView {...baseProps(main)} />);
    rerender(<CompareView {...baseProps(main)} params={{ time: "2026-02-01" }} />);
    expect(created[0].setTiles).not.toHaveBeenCalled();
    act(() => created[0].fire("load"));
    expect(created[0].setTiles.mock.calls.at(-1)[0][0]).toContain("&time=2026-02-01");
  });

  it("il token Keycloak viaggia solo verso GeoServer", () => {
    const main = fakeMain();
    render(<CompareView {...baseProps(main)} kc={{ token: "tok" } as any} />);
    const tr = created[0].opts.transformRequest;
    expect(tr("https://h/geoserver/wms?x=1")).toEqual({ url: "https://h/geoserver/wms?x=1", headers: { Authorization: "Bearer tok" } });
    expect(tr("https://t/1/2/3.png")).toEqual({ url: "https://t/1/2/3.png" });
  });

  it("le etichette A e B seguono i due lati", () => {
    render(<CompareView {...baseProps(fakeMain())} />);
    expect(screen.getByText("NDVI · 2026-03-01")).toBeInTheDocument();
    expect(screen.getByText("NDVI · 2026-01-01")).toBeInTheDocument();
  });
});

describe("ComparePanel", () => {
  const products: any[] = [
    { name: "iride:ndvi", title: "NDVI", workspace: "iride", time: { extent: "", default: "2026-03-01" } },
    { name: "iride:evi", title: "EVI", workspace: "iride", time: { extent: "" } },
    { name: "iride:dem", title: "DEM", workspace: "iride" },
  ];
  const stepsOf = (n: string) => (n === "iride:dem" ? [] : ["2026-01-01", "2026-02-01", "2026-03-01"]);
  const mk = (over: Partial<Parameters<typeof ComparePanel>[0]> = {}) => {
    const fns = { onState: vi.fn(), onATime: vi.fn(), onClose: vi.fn() };
    render(<ComparePanel state={{ a: "iride:ndvi", b: "iride:ndvi", bTime: "2026-01-01" }} products={products} activeNames={["iride:ndvi", "iride:dem"]} stepsOf={stepsOf} aTime="" aDefault="2026-03-01" {...fns} {...over} />);
    return fns;
  };

  it("A solo tra i layer attivi, B tra tutti; le date appaiono solo per i layer con TIME", () => {
    mk();
    expect(screen.getByLabelText("Layer A").querySelectorAll("option")).toHaveLength(2);
    expect(screen.getByLabelText("Layer B").querySelectorAll("option")).toHaveLength(3);
    expect((screen.getByLabelText("Data A") as HTMLSelectElement).value).toBe("2026-03-01");
    expect((screen.getByLabelText("Data B") as HTMLSelectElement).value).toBe("2026-01-01");
  });

  it("scegliere la data cambia il lato giusto", () => {
    const { onState, onATime } = mk();
    fireEvent.change(screen.getByLabelText("Data B"), { target: { value: "2026-02-01" } });
    expect(onState).toHaveBeenCalledWith({ a: "iride:ndvi", b: "iride:ndvi", bTime: "2026-02-01" });
    fireEvent.change(screen.getByLabelText("Data A"), { target: { value: "2026-01-01" } });
    expect(onATime).toHaveBeenCalledWith("2026-01-01");
  });

  it("cambiando layer B: parte dall'ultima data se ne ha, nessuna data se non ha TIME", () => {
    const { onState } = mk();
    fireEvent.change(screen.getByLabelText("Layer B"), { target: { value: "iride:evi" } });
    expect(onState).toHaveBeenLastCalledWith({ a: "iride:ndvi", b: "iride:evi", bTime: "2026-03-01" });
    fireEvent.change(screen.getByLabelText("Layer B"), { target: { value: "iride:dem" } });
    expect(onState).toHaveBeenLastCalledWith({ a: "iride:ndvi", b: "iride:dem", bTime: "" });
  });

  it("uscita", () => {
    const { onClose } = mk();
    fireEvent.click(screen.getByRole("button", { name: "Esci dal confronto" }));
    expect(onClose).toHaveBeenCalled();
  });
});
