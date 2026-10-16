// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WidgetCard } from "../src/Widgets";
import type { WidgetDef } from "../src/configStore";

vi.mock("../src/api", () => ({ getWfsFeatures: vi.fn(), describeLayer: vi.fn() }));
import * as api from "../src/api";

const W = (o: Partial<WidgetDef>): WidgetDef => ({ id: "w", type: "kpi", title: "T", layer: "iride:a", agg: "count", w: 1, ...o });

describe("WidgetCard", () => {
  beforeEach(() => {
    vi.mocked(api.describeLayer).mockResolvedValue({ prefix: "i", ns: "", typeName: "a", geomName: "g", geomType: "Point", fields: [{ name: "cls", type: "string" }] });
    vi.mocked(api.getWfsFeatures).mockResolvedValue([
      { properties: { cls: "A" }, geometry: null }, { properties: { cls: "A" }, geometry: null }, { properties: { cls: "B" }, geometry: null },
    ]);
  });

  it("KPI: mostra il conteggio e chiede solo gli attributi necessari", async () => {
    render(<WidgetCard def={W({ type: "kpi", field: "cls", cql: "x > 1" })} gs="/geoserver" kc={null} canOpen onOpenMap={() => {}} />);
    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(screen.getByText("oggetti")).toBeInTheDocument();
    expect(api.getWfsFeatures).toHaveBeenCalledWith("/geoserver", null, "iride:a", "x > 1", 5000, ["cls"]);
  });

  it("barre: il clic apre la mappa combinando il filtro del widget e quello della barra", async () => {
    const open = vi.fn();
    render(<WidgetCard def={W({ type: "bar", field: "cls", cql: "anno = 2026" })} gs="/g" kc={null} canOpen onOpenMap={open} />);
    const bar = await screen.findByTitle("A: 2");
    fireEvent.click(bar);
    expect(open).toHaveBeenCalledWith("iride:a", "(anno = 2026) AND (cls = 'A')");
  });

  it("senza filtro del widget il CQL è solo quello della barra", async () => {
    const open = vi.fn();
    render(<WidgetCard def={W({ type: "bar", field: "cls" })} gs="/g" kc={null} canOpen onOpenMap={open} />);
    fireEvent.click(await screen.findByTitle("B: 1"));
    expect(open).toHaveBeenCalledWith("iride:a", "cls = 'B'");
  });

  it("layer non permesso: barre e link disabilitati", async () => {
    render(<WidgetCard def={W({ type: "bar", field: "cls" })} gs="/g" kc={null} canOpen={false} onOpenMap={() => {}} />);
    expect(await screen.findByTitle("A: 2")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Apri sulla mappa" })).toBeDisabled();
  });

  it("errore di GeoServer mostrato nella scheda", async () => {
    vi.mocked(api.getWfsFeatures).mockRejectedValue(new Error("Could not find type"));
    render(<WidgetCard def={W({ type: "kpi" })} gs="/g" kc={null} canOpen onOpenMap={() => {}} />);
    expect(await screen.findByText(/Could not find type/)).toBeInTheDocument();
  });

  it("layer non scelto", async () => {
    render(<WidgetCard def={W({ layer: "" })} gs="/g" kc={null} canOpen onOpenMap={() => {}} />);
    expect(await screen.findByText(/layer non scelto/)).toBeInTheDocument();
    expect(api.getWfsFeatures).not.toHaveBeenCalled();
  });

  it("senza campi usa il primo attributo dello schema; con 5000 righe segnala il limite", async () => {
    vi.mocked(api.describeLayer).mockResolvedValue({ prefix: "i", ns: "", typeName: "a", geomName: "g", geomType: "Point", fields: [{ name: "primo", type: "string" }] });
    vi.mocked(api.getWfsFeatures).mockResolvedValue(Array.from({ length: 5000 }, () => ({ properties: {}, geometry: null })));
    render(<WidgetCard def={W({ type: "kpi" })} gs="/g" kc={null} canOpen onOpenMap={() => {}} />);
    await waitFor(() => expect(screen.getByText(/primi 5000 oggetti/)).toBeInTheDocument());
    expect(api.getWfsFeatures).toHaveBeenCalledWith("/g", null, "iride:a", undefined, 5000, ["primo"]);
  });
});
