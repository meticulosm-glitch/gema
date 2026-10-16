// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import TimeSlider from "../src/TimeSlider";
import FilterBox from "../src/FilterBox";

const steps = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"];

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("TimeSlider", () => {
  it("non appare con un solo istante", () => {
    const { container } = render(<TimeSlider steps={["2026-01-01"]} value="" onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("parte dalla data predefinita e mostra gli estremi", () => {
    render(<TimeSlider steps={steps} value="" defaultValue="2026-02-01" onChange={() => {}} />);
    expect((screen.getByLabelText("Data") as HTMLInputElement).value).toBe("1");
    expect(screen.getByText("2026-01-01")).toBeInTheDocument();
    expect(screen.getByText("2026-04-01")).toBeInTheDocument();
    expect(screen.getByText("2026-02-01", { selector: "strong" })).toBeInTheDocument();
  });

  it("trascinando aggiorna l'etichetta subito e applica la data solo a trascinamento fermo", () => {
    const onChange = vi.fn();
    render(<TimeSlider steps={steps} value="2026-01-01" onChange={onChange} />);
    const r = screen.getByLabelText("Data");
    fireEvent.change(r, { target: { value: "2" } });
    fireEvent.change(r, { target: { value: "3" } });
    expect(screen.getByText("2026-04-01", { selector: "strong" })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(250); });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("2026-04-01");
  });

  it("i pulsanti precedente/successivo si fermano agli estremi", () => {
    const onChange = vi.fn();
    render(<TimeSlider steps={steps} value="2026-01-01" onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Istante precedente" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Istante successivo" }));
    expect(onChange).toHaveBeenCalledWith("2026-02-01");
  });

  it("play: avanza a ogni scatto, ricomincia dall'inizio e si ferma con pausa", () => {
    const onChange = vi.fn();
    const { rerender } = render(<TimeSlider steps={steps} value="2026-03-01" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Riproduci" }));
    expect(screen.getByRole("button", { name: "Pausa" })).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onChange).toHaveBeenLastCalledWith("2026-04-01");
    rerender(<TimeSlider steps={steps} value="2026-04-01" onChange={onChange} />);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onChange).toHaveBeenLastCalledWith("2026-01-01"); // giro completo
    fireEvent.click(screen.getByRole("button", { name: "Pausa" }));
    const n = onChange.mock.calls.length;
    act(() => { vi.advanceTimersByTime(5000); });
    expect(onChange).toHaveBeenCalledTimes(n);
  });

  it("la velocità cambia l'intervallo", () => {
    const onChange = vi.fn();
    render(<TimeSlider steps={steps} value="2026-01-01" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Velocità"), { target: { value: "2" } }); // 2×: 500 ms
    fireEvent.click(screen.getByRole("button", { name: "Riproduci" }));
    act(() => { vi.advanceTimersByTime(500); });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("segue la data cambiata dall'esterno (menu, link)", () => {
    const { rerender } = render(<TimeSlider steps={steps} value="2026-01-01" onChange={() => {}} />);
    rerender(<TimeSlider steps={steps} value="2026-03-01" onChange={() => {}} />);
    expect((screen.getByLabelText("Data") as HTMLInputElement).value).toBe("2");
  });
});

describe("FilterBox: slider e stile", () => {
  const base = { cql: "", time: "", onApplyCql: () => {}, onApplyTime: () => {}, onClearSelection: () => {} };

  it("lo slider compare anche per un intervallo con periodo, e applica la data", () => {
    const onApplyTime = vi.fn();
    render(<FilterBox {...base} onApplyTime={onApplyTime} timeInfo={{ extent: "2026-01-01/2026-01-05/P1D" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Istante precedente" }));
    expect(onApplyTime).toHaveBeenCalledWith("2026-01-04");
  });

  it("nessuno slider se gli istanti non sono enumerabili", () => {
    render(<FilterBox {...base} timeInfo={{ extent: "2020-01-01/2026-01-01" }} />);
    expect(screen.queryByRole("group", { name: "Slider temporale" })).toBeNull();
  });

  it("selettore di stile solo con più di uno stile; il predefinito è il primo", () => {
    const onApplyStyle = vi.fn();
    const { rerender } = render(<FilterBox {...base} styles={[{ name: "raster", title: "Raster" }]} onApplyStyle={onApplyStyle} />);
    expect(screen.queryByLabelText("Stile")).toBeNull();
    rerender(<FilterBox {...base} styles={[{ name: "ndvi", title: "NDVI classico" }, { name: "ndvi_div", title: "NDVI divergente" }]} onApplyStyle={onApplyStyle} />);
    expect(screen.getByRole("option", { name: /predefinito \(NDVI classico\)/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Stile"), { target: { value: "ndvi_div" } });
    expect(onApplyStyle).toHaveBeenCalledWith("ndvi_div");
    fireEvent.change(screen.getByLabelText("Stile"), { target: { value: "" } });
    expect(onApplyStyle).toHaveBeenLastCalledWith("");
  });
});
