// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { WidgetDef } from "../src/configStore";
import { Markdown, safeHref } from "../src/markdown";

vi.mock("../src/api", async (orig) => ({ ...(await orig<typeof import("../src/api")>()), getWfsFeatures: vi.fn(), describeLayer: vi.fn() }));
vi.mock("../src/WidgetMap", () => ({ default: (p: any) => <div data-testid="wmap">{p.def.layer}|{p.def.cql}|{p.basemaps.map((b: any) => b.id).join(",")}</div> }));
import * as api from "../src/api";
import { WidgetCard, WidgetEnv } from "../src/Widgets";

const W = (extra: Partial<WidgetDef>): WidgetDef => ({ id: "w", type: "kpi", title: "T", layer: "ws:l", agg: "count", w: 1, ...extra });
const rows = (list: Record<string, unknown>[]) => list.map((properties) => ({ geometry: null, properties }));

beforeEach(() => vi.mocked(api.getWfsFeatures).mockReset());

describe("Markdown", () => {
  it("titoli, paragrafi, elenchi, grassetto, corsivo, codice, link sicuri; niente HTML", () => {
    const { container } = render(<Markdown text={"# Uno\n## Due\ntesto **forte** e *lieve* con `x`\nstessa riga\n\n- a\n- b\n1. c\n<b>no</b> [ok](https://e.org/a_(b)) [male](javascript:alert(1)) [mail](mailto:a@b.it) [interno](/d/1) [esterno?](//evil.org)"} />);
    expect(container.querySelector("h4")!.textContent).toBe("Uno");
    expect(container.querySelector("h5")!.textContent).toBe("Due");
    expect(container.querySelector("p")!.textContent).toBe("testo forte e lieve con x stessa riga");
    expect(container.querySelector("strong")!.textContent).toBe("forte");
    expect(container.querySelector("em")!.textContent).toBe("lieve");
    expect(container.querySelector("code")!.textContent).toBe("x");
    expect(container.querySelectorAll("ul li")).toHaveLength(2);
    expect(container.querySelectorAll("ol li")).toHaveLength(1);
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByRole("link", { name: "ok" })).toHaveAttribute("href", "https://e.org/a_(b)");
    expect(screen.getByRole("link", { name: "ok" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("link", { name: "male" })).toBeNull();
    expect(screen.getByText("male").tagName).toBe("SPAN");
    expect(screen.getByRole("link", { name: "mail" })).not.toHaveAttribute("target");
    expect(screen.getByRole("link", { name: "interno" })).toHaveAttribute("href", "/d/1");
    expect(screen.queryByRole("link", { name: "esterno?" })).toBeNull();
  });
  it("safeHref", () => {
    expect(safeHref(" https://x ")).toBe("https://x");
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("//x.org")).toBeNull();
  });
});

describe("WidgetCard: nuovi tipi", () => {
  it("indicatore: valore, livello con icona e testo, scala e soglie", async () => {
    vi.mocked(api.getWfsFeatures).mockResolvedValue(rows([{ v: 40 }, { v: 45 }]));
    render(<WidgetCard def={W({ type: "gauge", agg: "sum", valueField: "v", warn: 50, crit: 80 })} gs="g" kc={null} canOpen onOpenMap={() => {}} />);
    const meter = await screen.findByRole("meter");
    expect(meter).toHaveAttribute("aria-valuetext", "85: critico");
    expect(screen.getByText("critico")).toBeInTheDocument();
    expect(screen.getByText("soglie 50 / 80")).toBeInTheDocument();
  });

  it("torta: spicchi, legenda con percentuali, clic che apre la mappa con il filtro", async () => {
    vi.mocked(api.getWfsFeatures).mockResolvedValue(rows([{ k: "A" }, { k: "A" }, { k: "B" }, { k: "C" }]));
    const onOpenMap = vi.fn();
    const { container } = render(<WidgetCard def={W({ type: "pie", field: "k", cql: "x > 1" })} gs="g" kc={null} canOpen onOpenMap={onOpenMap} />);
    await waitFor(() => expect(container.querySelectorAll(".pie-slice")).toHaveLength(3));
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "Torta: A 50%, B 25%, C 25%");
    fireEvent.click(screen.getByRole("button", { name: /^B/ }));
    expect(onOpenMap).toHaveBeenCalledWith("ws:l", "(x > 1) AND (k = 'B')");
  });

  it("torta senza permesso sul layer: legenda non cliccabile", async () => {
    vi.mocked(api.getWfsFeatures).mockResolvedValue(rows([{ k: "A" }]));
    render(<WidgetCard def={W({ type: "pie", field: "k" })} gs="g" kc={null} canOpen={false} onOpenMap={() => {}} />);
    expect(await screen.findByRole("button", { name: /^A/ })).toBeDisabled();
  });

  it("linea: assi con primo e ultimo periodo; passando sopra compare il valore", async () => {
    vi.mocked(api.getWfsFeatures).mockResolvedValue(rows([{ d: "2026-01-01" }, { d: "2026-02-01" }, { d: "2026-02-03" }]));
    const { container } = render(<WidgetCard def={W({ type: "line", field: "d" })} gs="g" kc={null} canOpen onOpenMap={() => {}} />);
    await waitFor(() => expect(container.querySelector(".line-axis")).toHaveTextContent("2026-012026-02"));
    const svg = container.querySelector(".line-plot svg")!;
    svg.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.mouseMove(svg, { clientX: 99 });
    expect(screen.getByRole("status")).toHaveTextContent("2026-02 2");
    fireEvent.mouseLeave(svg);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("tabella: colonne, ordine, limite; chiede solo gli attributi necessari", async () => {
    vi.mocked(api.getWfsFeatures).mockResolvedValue(rows([{ n: "a", v: 1 }, { n: "b", v: 3 }, { n: "c", v: 2 }]));
    render(<WidgetCard def={W({ type: "table", columns: ["n", "v"], sortField: "v", sortDesc: true, limit: 2 })} gs="g" kc={null} canOpen onOpenMap={() => {}} />);
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row").slice(1).map((r) => r.textContent)).toEqual(["b3", "c2"]);
    expect(screen.getByText("prime 2 righe di 3")).toBeInTheDocument();
    expect(vi.mocked(api.getWfsFeatures).mock.calls[0][5]).toEqual(["n", "v"]);
  });

  it("testo e mini-mappa: nessuna richiesta WFS dal widget; la mini-mappa riceve layer, filtro e sfondi", async () => {
    render(
      <WidgetEnv.Provider value={{ basemaps: [{ id: "osm", label: "Mappa" }] }}>
        <WidgetCard def={W({ id: "t", type: "text", layer: "", text: "**ciao**" })} gs="g" kc={null} canOpen={false} onOpenMap={() => {}} />
        <WidgetCard def={W({ id: "m", type: "map", cql: "a = 1" })} gs="g" kc={null} canOpen onOpenMap={() => {}} />
      </WidgetEnv.Provider>,
    );
    expect(screen.getByText("ciao").tagName).toBe("STRONG");
    expect(await screen.findByTestId("wmap")).toHaveTextContent("ws:l|a = 1|osm");
    expect(screen.getAllByRole("button", { name: "Apri sulla mappa" })).toHaveLength(1); // il testo non ce l'ha
    await new Promise((r) => setTimeout(r, 400));
    expect(api.getWfsFeatures).not.toHaveBeenCalled();
  });
});
