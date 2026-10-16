// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { LegendPanel } from "../src/Legend";
import SeriesPanel, { SeriesChart } from "../src/SeriesPanel";
import { mockFetch } from "./support";

afterEach(cleanup);

describe("LegendPanel", () => {
  beforeEach(() => {
    (URL as any).createObjectURL = vi.fn(() => "blob:x");
    (URL as any).revokeObjectURL = vi.fn();
  });

  it("niente pannello senza layer; con i layer è aperto di default e usa lo stile scelto", async () => {
    const { container, rerender } = render(<LegendPanel gsUrl="/g" kc={null} entries={[]} />);
    expect(container).toBeEmptyDOMElement();
    const f = mockFetch(() => ({ body: "png", type: "image/png" }));
    rerender(<LegendPanel gsUrl="/g" kc={null} entries={[{ key: "a", layer: "iride:ndvi", title: "NDVI", style: "ndvi_div" }]} />);
    expect(screen.getByText("NDVI")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByAltText("Legenda iride:ndvi")).toBeInTheDocument());
    expect(String(f.mock.calls[0][0])).toContain("&style=ndvi_div");
  });

  it("cambiando stile la legenda si ricarica", async () => {
    const f = mockFetch(() => ({ body: "png", type: "image/png" }));
    const e = (style: string) => [{ key: "a", layer: "x:y", title: "Y", style }];
    const { rerender } = render(<LegendPanel gsUrl="/g" kc={null} entries={e("s1")} />);
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    rerender(<LegendPanel gsUrl="/g" kc={null} entries={e("s2")} />);
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
    expect(String(f.mock.calls[1][0])).toContain("&style=s2");
  });

  it("si può comprimere e riaprire; legenda non disponibile -> messaggio", async () => {
    mockFetch(() => ({ status: 404 }));
    render(<LegendPanel gsUrl="/g" kc={null} entries={[{ key: "a", layer: "x:y", title: "Y", tag: "A" }]} />);
    await waitFor(() => expect(screen.getByText("Legenda non disponibile.")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Legenda/ }));
    expect(screen.queryByText("Y")).toBeNull();
    expect(screen.getByRole("button", { name: /Legenda/ })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: /Legenda/ }));
    expect(screen.getByText("Y")).toBeInTheDocument();
  });
});

describe("SeriesChart", () => {
  const pts = (vals: (number | null)[]) => vals.map((v, i) => ({ t: `2026-0${i + 1}-01`, x: Date.UTC(2026, i, 1), values: { v } }));

  it("interrompe la linea sui dati mancanti", () => {
    const { container } = render(<SeriesChart points={pts([1, 2, null, 4, 5])} field="v" />);
    const d = container.querySelector("path.sc-line")!.getAttribute("d")!;
    expect(d.match(/M/g)).toHaveLength(2);
    expect(container.querySelectorAll("circle.sc-dot")).toHaveLength(4);
  });

  it("nessun valore -> messaggio", () => {
    render(<SeriesChart points={pts([null, null])} field="v" />);
    expect(screen.getByText(/Nessun valore in questo punto/)).toBeInTheDocument();
  });

  it("un solo punto o serie costante non rompono la scala", () => {
    const { container } = render(<SeriesChart points={pts([3, 3, 3])} field="v" />);
    expect(container.querySelector("path.sc-line")!.getAttribute("d")).not.toMatch(/NaN|Infinity/);
    cleanup();
    const one = render(<SeriesChart points={pts([3])} field="v" />);
    expect(one.container.querySelector("path.sc-line")!.getAttribute("d")).not.toMatch(/NaN|Infinity/);
  });
});

describe("SeriesPanel", () => {
  const map: any = { project: ([x, y]: number[]) => ({ x, y }), unproject: ([x, y]: number[]) => ({ lng: x, lat: y }) };
  const steps = ["2026-01-01", "2026-02-01", "2026-03-01"];
  const cand = [{ name: "iride:ndvi", title: "NDVI", steps }];
  const props = { map, gsUrl: "/g", kc: null, paramsFor: () => ({}), onClose: () => {} };

  it("senza layer con TIME spiega cosa fare", () => {
    render(<SeriesPanel {...props} candidates={[]} point={null} />);
    expect(screen.getByText(/Accendi un layer con dimensione TIME/)).toBeInTheDocument();
  });

  it("senza punto chiede il clic; con il punto legge una richiesta per data e disegna il grafico", async () => {
    const { rerender } = render(<SeriesPanel {...props} candidates={cand} point={null} />);
    expect(screen.getByText(/Clicca sulla mappa/)).toBeInTheDocument();
    const f = mockFetch((url) => ({ body: JSON.stringify({ features: [{ geometry: null, properties: { GRAY_INDEX: Number(/time=2026-0(\d)/.exec(url)![1]) } }] }) }));
    rerender(<SeriesPanel {...props} candidates={cand} point={{ lng: 12.5, lat: 42.1 }} />);
    await waitFor(() => expect(screen.getByRole("img", { name: /Serie storica di GRAY_INDEX/ })).toBeInTheDocument(), { timeout: 3000 });
    expect(f).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("button", { name: "Scarica CSV" })).toBeEnabled();
  });

  it("più bande: scelta del valore da tracciare", async () => {
    mockFetch(() => ({ body: JSON.stringify({ features: [{ geometry: null, properties: { b1: 1, b2: 2 } }] }) }));
    render(<SeriesPanel {...props} candidates={cand} point={{ lng: 1, lat: 1 }} />);
    await waitFor(() => expect(screen.getByLabelText("Valore")).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.change(screen.getByLabelText("Valore"), { target: { value: "b2" } });
    expect(screen.getByRole("img", { name: /Serie storica di b2/ })).toBeInTheDocument();
  });

  it("oltre il massimo campiona le date e lo dichiara", () => {
    const many = Array.from({ length: 200 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
    render(<SeriesPanel {...props} candidates={[{ name: "a:b", title: "B", steps: many }]} point={null} />);
    expect(screen.getByText(/200 date nell'intervallo: ne vengono lette 60/)).toBeInTheDocument();
  });

  it("un cambio ripetuto delle date non lancia due serie complete (attesa prima di leggere)", async () => {
    vi.useFakeTimers();
    try {
      const f = mockFetch(() => ({ body: JSON.stringify({ features: [] }) }));
      render(<SeriesPanel {...props} candidates={cand} point={{ lng: 1, lat: 1 }} />);
      fireEvent.change(screen.getByLabelText(/^a/), { target: { value: "1" } });
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(f).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(f).toHaveBeenCalledTimes(2); // solo gli istanti 0..1 dell'ultimo intervallo
    } finally { vi.useRealTimers(); }
  });
});
