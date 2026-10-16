// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ViewsPanel from "../src/ViewsPanel";
import LayerInfoPanel, { safeHref } from "../src/LayerInfoPanel";
import type { Product } from "../src/capabilities";
import type { ViewState } from "../src/viewState";
import { ACC, el, fakeKc, mockFetch, XSD } from "./support";

afterEach(() => vi.unstubAllGlobals());
const A = { ...ACC, workspace: "test" };
const VIEWS_XSD = XSD("saved_views", el("owner", "xsd:string") + el("name", "xsd:string") + el("definition", "xsd:string") + el("created_at", "xsd:string"), "http://x/test");
const STATE: ViewState = { v: [12, 42, 7, 0, 0], l: [["a:b", 1, "x=1", "", ""], ["c:d", 0.5, "", "", ""]], b: "sat" };
const NOW: ViewState = { v: [1, 2, 3, 0, 0], l: [["z:z", 1, "", "", ""]] };
const kc = fakeKc({ preferred_username: "pippo" });

/** Server finto: tiene le righe in memoria e applica le transazioni WFS-T. */
function fakeServer(initial: { id: number; name: string }[] = [], opts: { missing?: boolean; denyWrite?: boolean } = {}) {
  const rows = [...initial];
  const bodies: string[] = [];
  mockFetch((u, init) => {
    if (opts.missing) return { status: 400, body: "<ServiceException>Feature type test:saved_views unknown</ServiceException>" };
    if (u.includes("DescribeFeatureType")) return { type: "text/xml", body: VIEWS_XSD };
    if (init?.method === "POST") {
      const b = String(init.body);
      bodies.push(b);
      if (opts.denyWrite) return { status: 403 };
      if (b.includes("<wfs:Insert>")) rows.push({ id: rows.length + 100, name: /<test:name>(.*?)<\/test:name>/.exec(b)![1] });
      if (b.includes("<wfs:Delete")) { const id = Number(/fid="saved_views\.(\d+)"/.exec(b)![1]); rows.splice(rows.findIndex((r) => r.id === id), 1); }
      return { type: "text/xml", body: "<wfs:SUCCESS/>" };
    }
    return {
      type: "application/json",
      body: JSON.stringify({ features: rows.map((r, i) => ({ id: `saved_views.${r.id}`, geometry: null, properties: { owner: "pippo", name: r.name, definition: JSON.stringify(STATE), created_at: `2026-01-0${i + 1}T00:00:00Z` } })) }),
    };
  });
  return { rows, bodies };
}
const mount = (over: Partial<Parameters<typeof ViewsPanel>[0]> = {}) => {
  const props = { gsUrl: "http://gs/geoserver", kc, access: A, capture: () => NOW, onApply: vi.fn(), onClose: vi.fn(), ...over };
  return { ...render(<ViewsPanel {...props} />), props };
};

describe("ViewsPanel con controllo accessi (PostGIS)", () => {
  it("elenca le viste, apre quella scelta con il suo stato", async () => {
    fakeServer([{ id: 1, name: "Puglia" }, { id: 2, name: "Lazio" }]);
    const { props } = mount();
    const open = await screen.findByRole("button", { name: /^Lazio/ });
    expect(open).toHaveTextContent("2 layer");
    fireEvent.click(open);
    expect(props.onApply).toHaveBeenCalledWith(STATE);
  });
  it("nessuna vista: lo dice; salvare richiede un nome e scrive lo stato attuale", async () => {
    const srv = fakeServer();
    mount();
    expect(await screen.findByText("Nessuna vista salvata.")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Salva" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Nome della vista"), { target: { value: "  Mia vista  " } });
    fireEvent.click(save);
    expect(await screen.findByRole("button", { name: /^Mia vista/ })).toBeInTheDocument();
    expect(srv.bodies[0]).toContain("<test:name>Mia vista</test:name>");   // nome ripulito dagli spazi
    expect(srv.bodies[0]).toContain("z:z");                                  // lo stato è quello catturato al momento
    expect(screen.getByLabelText("Nome della vista")).toHaveValue("");
  });
  it("Aggiorna sostituisce lo stato (Update sullo stesso fid, nome invariato)", async () => {
    const srv = fakeServer([{ id: 7, name: "Vecchia" }]);
    mount();
    await screen.findByRole("button", { name: /^Vecchia/ });
    fireEvent.click(screen.getByRole("button", { name: "Aggiorna" }));
    await waitFor(() => expect(srv.bodies.length).toBe(1));
    expect(srv.bodies[0]).toContain("<wfs:Update");
    expect(srv.bodies[0]).toContain('fid="saved_views.7"');
    expect(srv.bodies[0]).toContain("<wfs:Name>name</wfs:Name><wfs:Value>Vecchia</wfs:Value>");
  });
  it("eliminare chiede conferma (due clic) e poi toglie la riga", async () => {
    const srv = fakeServer([{ id: 1, name: "Una" }, { id: 2, name: "Due" }]);
    mount();
    await screen.findByRole("button", { name: /^Una/ });
    fireEvent.click(screen.getByRole("button", { name: "Elimina Una" }));
    expect(srv.bodies.length).toBe(0);
    fireEvent.click(await screen.findByRole("button", { name: "Conferma" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Una/ })).toBeNull());
    expect(srv.bodies[0]).toContain("<wfs:Delete");
    expect(screen.getByRole("button", { name: /^Due/ })).toBeInTheDocument();
  });
  it("tabella non pubblicata: messaggio con il nome esatto", async () => {
    fakeServer([], { missing: true });
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("test:saved_views non trovata");
  });
  it("scrittura negata da GeoServer (403): errore leggibile, la lista resta com'era", async () => {
    fakeServer([{ id: 1, name: "Una" }], { denyWrite: true });
    mount();
    await screen.findByRole("button", { name: /^Una/ });
    fireEvent.change(screen.getByLabelText("Nome della vista"), { target: { value: "Nuova" } });
    fireEvent.click(screen.getByRole("button", { name: "Salva" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/403/);
    expect(screen.queryByRole("button", { name: /^Nuova/ })).toBeNull();
  });
  it("chiude con la X", async () => {
    fakeServer();
    const { props } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Chiudi le viste salvate" }));
    expect(props.onClose).toHaveBeenCalled();
    await screen.findByText("Nessuna vista salvata.");
  });
});

describe("ViewsPanel senza controllo accessi (browser)", () => {
  beforeEach(() => localStorage.clear());
  it("salva, riapre ed elimina in localStorage, senza chiamate di rete", async () => {
    const f = mockFetch(() => ({ body: "" }));
    const { props } = mount({ access: undefined, kc: null });
    expect(await screen.findByText(/solo in questo browser/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Nome della vista"), { target: { value: "Locale" } });
    fireEvent.click(screen.getByRole("button", { name: "Salva" }));
    const open = await screen.findByRole("button", { name: /^Locale/ });
    fireEvent.click(open);
    expect(props.onApply).toHaveBeenCalledWith(expect.objectContaining({ l: NOW.l }));
    fireEvent.click(screen.getByRole("button", { name: "Elimina Locale" }));
    fireEvent.click(await screen.findByRole("button", { name: "Conferma" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Locale/ })).toBeNull());
    expect(f).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- scheda del layer
const VEC: Product = {
  name: "test:citta", title: "Città", workspace: "test", vector: true, bbox: [6, 36, 18, 47], abstract: "Capoluoghi italiani", keywords: ["istat", "comuni"],
  attribution: { title: "ISTAT", url: "https://istat.it" }, metadataUrl: "javascript:alert(1)",
  styles: [{ name: "a", title: "Predefinito" }, { name: "b", title: "Per popolazione" }],
};
const RAS: Product = { name: "iride:ndvi", title: "NDVI", workspace: "iride", vector: false, time: { extent: "2026-01-01/2026-01-31/P1D", default: "2026-01-31" } };
const infoProps = { gsUrl: "http://gs/geoserver", kc: null, active: false, onClose: vi.fn(), onZoom: vi.fn(), onToggle: vi.fn() };

describe("LayerInfoPanel", () => {
  it("vettoriale: descrizione, parole chiave, conteggio, geometria, attributi, stili e fonte; link non http scartato", async () => {
    mockFetch((u) => {
      if (u.includes("DescribeFeatureType")) return { type: "text/xml", body: XSD("citta", el("nome", "xsd:string") + el("pop", "xsd:int") + el("g", "gml:MultiPolygonPropertyType"), "http://x/t") };
      return { type: "text/xml", body: `<wfs:FeatureCollection numberMatched="12345"/>` };
    });
    render(<LayerInfoPanel {...infoProps} product={VEC} />);
    expect(screen.getByText("Capoluoghi italiani")).toBeInTheDocument();
    expect(screen.getByText("istat")).toBeInTheDocument();
    expect(screen.getByText("Vettoriale")).toBeInTheDocument();
    expect(await screen.findByText("12.345")).toBeInTheDocument();
    expect(await screen.findByText("MultiPolygon")).toBeInTheDocument();
    expect(screen.getByText("nome, pop")).toBeInTheDocument();
    expect(screen.getByText("Predefinito, Per popolazione")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ISTAT" })).toHaveAttribute("href", "https://istat.it");
    expect(screen.queryByRole("link", { name: /metadati/i })).toBeNull();      // javascript: non diventa un link
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref(" https://x.it/a ")).toBe("https://x.it/a");
  });
  it("raster con TIME: niente conteggio né attributi, niente richieste WFS; mostra date e ultimo dato", () => {
    const f = mockFetch(() => ({ body: "" }));
    render(<LayerInfoPanel {...infoProps} product={RAS} />);
    expect(screen.getByText("Raster / gruppo")).toBeInTheDocument();
    expect(screen.getByText(/31 date/)).toBeInTheDocument();
    expect(screen.getByText(/Ultimo dato disponibile/)).toBeInTheDocument();
    expect(screen.queryByText("Oggetti")).toBeNull();
    expect(screen.getByText(/Nessuna descrizione/)).toBeInTheDocument();
    expect(f).not.toHaveBeenCalled();
  });
  it("conteggio non disponibile: lo dice; zoom e aggiungi/rimuovi chiamano i callback", async () => {
    mockFetch((u) => (u.includes("DescribeFeatureType") ? { status: 400, body: "<ServiceException>x</ServiceException>" } : { status: 500 }));
    const onZoom = vi.fn(), onToggle = vi.fn();
    const { rerender } = render(<LayerInfoPanel {...infoProps} product={VEC} onZoom={onZoom} onToggle={onToggle} />);
    expect(await screen.findByText("non disponibile")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Zoom/ }));
    expect(onZoom).toHaveBeenCalledWith(VEC);
    fireEvent.click(screen.getByRole("button", { name: "Aggiungi alla mappa" }));
    expect(onToggle).toHaveBeenCalledWith("test:citta");
    rerender(<LayerInfoPanel {...infoProps} product={VEC} active onToggle={onToggle} />);
    expect(screen.getByRole("button", { name: "Rimuovi dalla mappa" })).toBeInTheDocument();
  });
});
