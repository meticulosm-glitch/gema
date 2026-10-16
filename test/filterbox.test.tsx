// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import FilterBox from "../src/FilterBox";

const base = { cql: "", time: "", onApplyCql: () => {}, onApplyTime: () => {}, onClearSelection: () => {} };

describe("FilterBox", () => {
  it("applica il CQL con il pulsante e con Invio", () => {
    const onApplyCql = vi.fn();
    render(<FilterBox {...base} onApplyCql={onApplyCql} />);
    const input = screen.getByPlaceholderText(/Filtro CQL/);
    fireEvent.change(input, { target: { value: "anno = 2026" } });
    fireEvent.click(screen.getByRole("button", { name: "Applica" }));
    expect(onApplyCql).toHaveBeenLastCalledWith("anno = 2026");
    fireEvent.change(input, { target: { value: "x > 1" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onApplyCql).toHaveBeenLastCalledWith("x > 1");
  });
  it("\"Togli\" compare solo con un filtro attivo e lo svuota", () => {
    const onApplyCql = vi.fn();
    const { rerender } = render(<FilterBox {...base} onApplyCql={onApplyCql} />);
    expect(screen.queryByRole("button", { name: "Togli" })).toBeNull();
    rerender(<FilterBox {...base} cql="a=1" onApplyCql={onApplyCql} />);
    expect(screen.getByPlaceholderText(/Filtro CQL/)).toHaveValue("a=1");
    fireEvent.click(screen.getByRole("button", { name: "Togli" }));
    expect(onApplyCql).toHaveBeenCalledWith("");
  });
  it("layer raster (noCql): niente filtro CQL, resta la data", () => {
    render(<FilterBox {...base} noCql timeInfo={{ extent: "2026-01-01/2026-12-31/P1D" }} />);
    expect(screen.queryByPlaceholderText(/Filtro CQL/)).toBeNull();
    expect(screen.getByPlaceholderText(/Data o intervallo/)).toBeInTheDocument();
  });
  it("TIME con elenco di date: menu che applica subito la scelta", () => {
    const onApplyTime = vi.fn();
    render(<FilterBox {...base} onApplyTime={onApplyTime} timeInfo={{ extent: "", default: "2026-03-01", values: ["2026-03-01", "2026-02-01"] }} />);
    expect(screen.getByRole("option", { name: /predefinita \(2026-03-01\)/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Data del layer" }), { target: { value: "2026-02-01" } });
    expect(onApplyTime).toHaveBeenCalledWith("2026-02-01");
  });
  it("TIME a testo libero: Invio applica", () => {
    const onApplyTime = vi.fn();
    render(<FilterBox {...base} onApplyTime={onApplyTime} timeInfo={{ extent: "a/b/P1D", default: "2026-12-31" }} />);
    const input = screen.getByPlaceholderText(/predef\. 2026-12-31/);
    fireEvent.change(input, { target: { value: "2026-06-01" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onApplyTime).toHaveBeenCalledWith("2026-06-01");
  });
  it("selezione dal grafico rimovibile; errore mostrato", () => {
    const onClearSelection = vi.fn();
    render(<FilterBox {...base} selectionLabel="classe A" error="Filtro non valido" onClearSelection={onClearSelection} />);
    expect(screen.getByText(/Dal grafico: classe A/)).toBeInTheDocument();
    expect(screen.getByText("Filtro non valido")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Rimuovi"));
    expect(onClearSelection).toHaveBeenCalled();
  });
  it("si risincronizza quando il filtro cambia dall'esterno", () => {
    const { rerender } = render(<FilterBox {...base} cql="a=1" />);
    rerender(<FilterBox {...base} cql="b=2" />);
    expect(screen.getByPlaceholderText(/Filtro CQL/)).toHaveValue("b=2");
  });
});
