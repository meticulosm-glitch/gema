// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { WidgetDef } from "../src/configStore";

vi.mock("../src/api", async (orig) => ({ ...(await orig<typeof import("../src/api")>()), getWfsFeatures: vi.fn(), getWfsCount: vi.fn(), describeLayer: vi.fn() }));
import * as api from "../src/api";
import { WidgetCard } from "../src/Widgets";

const W = (extra: Partial<WidgetDef>): WidgetDef => ({ id: "w", type: "kpi", title: "T", layer: "ws:l", agg: "count", w: 1, ...extra });
const many = (n: number) => Array.from({ length: n }, (_, i) => ({ geometry: null, properties: { v: i } }));

beforeEach(() => { vi.mocked(api.getWfsFeatures).mockReset(); vi.mocked(api.getWfsCount).mockReset(); vi.mocked(api.describeLayer).mockResolvedValue({ fields: [{ name: "v", type: "int" }] } as never); });

describe("widget oltre il limite di 5000 oggetti", () => {
  it("conteggio: il totale esatto lo dà GeoServer (resultType=hits), con il filtro del widget", async () => {
    vi.mocked(api.getWfsFeatures).mockResolvedValue(many(5000));
    vi.mocked(api.getWfsCount).mockResolvedValue(123456);
    render(<WidgetCard def={W({ cql: "a = 1" })} gs="g" kc={null} canOpen onOpenMap={() => {}} />);
    await waitFor(() => expect(screen.getByText("123.456")).toBeInTheDocument());
    expect(api.getWfsCount).toHaveBeenCalledWith("g", null, "ws:l", "a = 1");
  });
  it("se il server non lo dice: '5000+' come prima", async () => {
    vi.mocked(api.getWfsFeatures).mockResolvedValue(many(5000));
    vi.mocked(api.getWfsCount).mockResolvedValue(null);
    render(<WidgetCard def={W({})} gs="g" kc={null} canOpen onOpenMap={() => {}} />);
    await waitFor(() => expect(screen.getByText("5000+")).toBeInTheDocument());
  });
  it("sotto il limite o somma: nessuna richiesta di conteggio", async () => {
    vi.mocked(api.getWfsFeatures).mockResolvedValue(many(10));
    render(<WidgetCard def={W({})} gs="g" kc={null} canOpen onOpenMap={() => {}} />);
    await waitFor(() => expect(screen.getByText("10")).toBeInTheDocument());
    vi.mocked(api.getWfsFeatures).mockResolvedValue(many(5000));
    render(<WidgetCard def={W({ id: "s", agg: "sum", valueField: "v" })} gs="g" kc={null} canOpen onOpenMap={() => {}} />);
    await new Promise((r) => setTimeout(r, 500));
    expect(api.getWfsCount).not.toHaveBeenCalled();
  });
});
