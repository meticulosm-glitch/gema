// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DashboardDef } from "../src/configStore";
import { ACC, fakeKc } from "./support";

vi.mock("../src/configStore", async (orig) => ({ ...(await orig<typeof import("../src/configStore")>()), saveDashboard: vi.fn() }));
vi.mock("../src/api", async (orig) => ({ ...(await orig<typeof import("../src/api")>()), describeLayer: vi.fn() }));
vi.mock("../src/Widgets", async (orig) => ({
  ...(await orig<typeof import("../src/Widgets")>()),
  WidgetCard: (p: any) => <div data-testid={`w-${p.def.id}`} data-cql={p.filterCql ?? ""}>{p.filterNote}</div>,
}));
import * as api from "../src/api";
import * as store from "../src/configStore";
import { DashboardView } from "../src/DashboardPages";
import AdminDashboards from "../src/AdminDashboards";
import { presetRange } from "../src/dashFilters";

const K = (id: string, layer: string) => ({ id, type: "kpi" as const, title: id, layer, agg: "count" as const, w: 1 as const });
const DASH = (filters: DashboardDef["filters"]): DashboardDef[] => [{
  fid: "dashboards.1", title: "Con filtri", description: "", roles: [],
  widgets: [K("a", "ws:a"), K("b", "ws:raster"), { id: "t", type: "text", title: "", layer: "", agg: "count", w: 1, text: "x" }], filters,
}];
const PERMS = { admin: false, layers: "*" as const, tools: new Set<any>(), roles: [], noRules: false } as any;
const schema = (geomName?: string, fields: [string, string][] = []) => ({ geomName, fields: fields.map(([name, type]) => ({ name, type })) }) as any;
const cql = (id: string) => screen.getByTestId(`w-${id}`).getAttribute("data-cql");

beforeEach(() => {
  window.history.replaceState(null, "", "/d/1");
  vi.mocked(api.describeLayer).mockReset().mockImplementation(async (_g, _k, l) => (l === "ws:a" ? schema("geom", [["d", "date"], ["n", "string"]]) : schema(undefined)));
});

describe("DashboardView: filtri globali", () => {
  it("senza filtri configurati: nessuna barra, nessuna richiesta di schema", () => {
    render(<DashboardView id="1" dashboards={DASH(undefined)} gs="g" kc={fakeKc()} perms={PERMS} />);
    expect(screen.queryByRole("group", { name: "Filtri della dashboard" })).toBeNull();
    expect(cql("a")).toBe("");
    expect(api.describeLayer).not.toHaveBeenCalled();
  });

  it("periodo: preset, date a mano, indirizzo, nota per i layer senza campo data, ripristina", async () => {
    render(<DashboardView id="1" dashboards={DASH({ date: { fields: { "ws:a": "d" }, preset: "7d" } })} gs="g" kc={fakeKc()} perms={PERMS} />);
    const bar = screen.getByRole("group", { name: "Filtri della dashboard" });
    const r7 = presetRange("7d");
    expect(cql("a")).toBe(`d >= '${r7.from}' AND d < '${new Date(Date.parse(r7.to) + 86400000).toISOString().slice(0, 10)}'`);
    expect(screen.getByTestId("w-b")).toHaveTextContent("Non filtrato per data");
    expect(screen.getByTestId("w-t")).toHaveTextContent("");
    expect(window.location.search).toBe(""); // predefinito: indirizzo pulito
    expect(within(bar).queryByRole("button", { name: "Ripristina" })).toBeNull();
    fireEvent.change(within(bar).getByLabelText("Periodo"), { target: { value: "all" } });
    expect(cql("a")).toBe("");
    expect(window.location.search).toBe("?dal=&al=");
    fireEvent.change(within(bar).getByLabelText("Dal"), { target: { value: "2026-02-01" } });
    fireEvent.change(within(bar).getByLabelText("Al"), { target: { value: "2026-02-28" } });
    expect(cql("a")).toBe("d >= '2026-02-01' AND d < '2026-03-01'");
    expect((within(bar).getByLabelText("Periodo") as HTMLSelectElement).value).toBe("custom");
    expect(window.location.search).toBe("?dal=2026-02-01&al=2026-02-28");
    fireEvent.click(within(bar).getByRole("button", { name: "Ripristina" }));
    expect((within(bar).getByLabelText("Dal") as HTMLInputElement).value).toBe(r7.from);
    expect(window.location.search).toBe("");
    expect(api.describeLayer).not.toHaveBeenCalled(); // senza area non serve la geometria
  });

  it("riapre lo stato dell'indirizzo", () => {
    window.history.replaceState(null, "", "/d/1?dal=2026-03-01&area=1,2,3,4");
    render(<DashboardView id="1" dashboards={DASH({ date: { fields: { "ws:a": "d" } }, area: true })} gs="g" kc={fakeKc()} perms={PERMS} />);
    expect((screen.getByLabelText("Dal") as HTMLInputElement).value).toBe("2026-03-01");
    expect(screen.getByText("1.00, 2.00, 3.00, 4.00")).toBeInTheDocument();
  });

  it("area: la mia area, geometria del layer, nota per i raster; tutta l'area", async () => {
    render(<DashboardView id="1" dashboards={DASH({ area: true })} gs="g" kc={fakeKc()} perms={PERMS} roleBbox={[12, 41, 13, 42]} />);
    const bar = screen.getByRole("group", { name: "Filtri della dashboard" });
    expect(within(bar).getByText("tutta")).toBeInTheDocument();
    expect(within(bar).queryByRole("button", { name: "Tutta l'area" })).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: "La mia area" }));
    await waitFor(() => expect(cql("a")).toBe("BBOX(geom, 12, 41, 13, 42)"));
    expect(screen.getByTestId("w-b")).toHaveTextContent("Non filtrato per area: il layer non ha una geometria.");
    expect(window.location.search).toBe("?area=12%2C41%2C13%2C42");
    expect(vi.mocked(api.describeLayer).mock.calls.map((c) => c[2]).sort()).toEqual(["ws:a", "ws:raster"]);
    fireEvent.click(within(bar).getByRole("button", { name: "Tutta l'area" }));
    expect(cql("a")).toBe("");
    expect(window.location.search).toBe("");
  });

  it("nessuna nota finché le geometrie non sono note", () => {
    vi.mocked(api.describeLayer).mockImplementation(() => new Promise(() => {}));
    window.history.replaceState(null, "", "/d/1?area=1,2,3,4");
    render(<DashboardView id="1" dashboards={DASH({ area: true })} gs="g" kc={fakeKc()} perms={PERMS} />);
    expect(screen.getByTestId("w-b")).toHaveTextContent("");
  });

  it("senza area del ruolo: niente 'La mia area'", () => {
    render(<DashboardView id="1" dashboards={DASH({ area: true })} gs="g" kc={fakeKc()} perms={PERMS} />);
    expect(screen.queryByRole("button", { name: "La mia area" })).toBeNull();
    expect(screen.getByRole("button", { name: "Scegli sulla mappa" })).toHaveAttribute("aria-expanded", "false");
  });
});

describe("AdminDashboards: configurazione dei filtri", () => {
  const PRODUCTS = [{ name: "ws:a", title: "A", workspace: "ws", vector: true }, { name: "ws:raster", title: "R", workspace: "ws", vector: false }];
  const setup = (dashboards: DashboardDef[]) =>
    render(<AdminDashboards gs="g" kc={fakeKc({ preferred_username: "ada" })} acc={ACC} rules={[]} dashboards={dashboards} products={PRODUCTS} storeError={null} onChanged={async () => {}} />);

  beforeEach(() => vi.mocked(store.saveDashboard).mockReset().mockResolvedValue());

  it("periodo: campo data proposto, scelta per layer, preset, area; salvati nella dashboard", async () => {
    setup(DASH(undefined));
    fireEvent.click(screen.getByRole("button", { name: /Con filtri/ }));
    await waitFor(() => expect(api.describeLayer).toHaveBeenCalledWith("g", expect.anything(), "ws:raster"));
    await act(async () => {});
    fireEvent.click(screen.getByLabelText("Periodo (date)"));
    const a = screen.getByLabelText("Campo data di ws:a") as HTMLSelectElement;
    expect(a.value).toBe("d");
    expect(Array.from(a.options).map((o) => o.value)).toEqual(["", "d"]); // solo campi data
    expect((screen.getByLabelText("Campo data di ws:raster") as HTMLSelectElement).value).toBe("");
    expect(screen.queryByLabelText("Campo data di")).toBeNull(); // il testo non ha layer
    fireEvent.change(screen.getByLabelText("Periodo iniziale"), { target: { value: "ytd" } });
    fireEvent.click(screen.getByLabelText("Area (riquadro scelto sulla mappa)"));
    fireEvent.click(screen.getByRole("button", { name: "Salva dashboard" }));
    await waitFor(() => expect(store.saveDashboard).toHaveBeenCalled());
    expect(vi.mocked(store.saveDashboard).mock.calls[0][3].filters).toEqual({ date: { fields: { "ws:a": "d" }, preset: "ytd" }, area: true });
  });

  it("periodo senza nessun campo data: non si salva; togliendo tutto i filtri spariscono", async () => {
    setup(DASH({ date: { fields: { "ws:a": "d" } } }));
    fireEvent.click(screen.getByRole("button", { name: /Con filtri/ }));
    expect(screen.getByLabelText("Periodo (date)")).toBeChecked();
    fireEvent.change(screen.getByLabelText("Campo data di ws:a"), { target: { value: "" } });
    expect(screen.getByText("Filtro per periodo: indica il campo data di almeno un layer.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salva dashboard" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Periodo (date)"));
    fireEvent.click(screen.getByRole("button", { name: "Salva dashboard" }));
    await waitFor(() => expect(store.saveDashboard).toHaveBeenCalled());
    expect(vi.mocked(store.saveDashboard).mock.calls[0][3]).not.toHaveProperty("filters");
  });
});
