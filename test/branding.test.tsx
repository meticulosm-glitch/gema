// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { applyBranding, Brand, PartnerLogos } from "../src/branding";
import type { AppConfig } from "../src/config";

const cfg = (o: Partial<AppConfig> = {}): AppConfig => ({ apiUrl: "", geoserverUrl: "/geoserver", basemapTiles: "", mapCenter: [12, 42], mapZoom: 5, ...o });
const css = (name: string) => document.documentElement.style.getPropertyValue(name);

describe("Brand", () => {
  it("senza logo: lettera iniziale e titolo", () => {
    const { container } = render(<Brand cfg={cfg({ title: "gema" })} />);
    expect(container.querySelector(".logo")).toHaveTextContent("G");
    expect(screen.getByText("gema")).toBeInTheDocument();
  });
  it("senza logo né titolo: M e \"MApp Web\"", () => {
    const { container } = render(<Brand cfg={cfg()} />);
    expect(container.querySelector(".logo")).toHaveTextContent("M");
    expect(screen.getByText("MApp Web")).toBeInTheDocument();
  });
  it("con logo il titolo non si ripete (niente doppione)", () => {
    const { container } = render(<Brand cfg={cfg({ title: "G.E.M.A.", logo: "/logo.png" })} />);
    const img = container.querySelector("img.brand-logo")!;
    expect(img).toHaveAttribute("src", "/logo.png");
    expect(container.querySelector(".logo")).toBeNull();
    expect(container.querySelector(".brand")!.textContent).toBe("");
  });
  it("con logo e LOGO_SHOW_TITLE il titolo compare", () => {
    render(<Brand cfg={cfg({ title: "G.E.M.A.", logo: "/logo.png", logoShowTitle: true })} />);
    expect(screen.getByText("G.E.M.A.")).toBeInTheDocument();
  });
  it("altezza del logo da LOGO_HEIGHT (default 28)", () => {
    const { container, rerender } = render(<Brand cfg={cfg({ logo: "/l.png" })} />);
    expect((container.querySelector("img") as HTMLImageElement).style.height).toBe("28px");
    rerender(<Brand cfg={cfg({ logo: "/l.png", logoHeight: 40 })} />);
    expect((container.querySelector("img") as HTMLImageElement).style.height).toBe("40px");
  });
  it("logo non raggiungibile: ricade su lettera e titolo", () => {
    const { container } = render(<Brand cfg={cfg({ title: "Pippo", logo: "/rotto.png" })} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".logo")).toHaveTextContent("P");
    expect(screen.getByText("Pippo")).toBeInTheDocument();
  });
});

describe("PartnerLogos", () => {
  it("nulla se non configurati", () => {
    const { container } = render(<PartnerLogos cfg={cfg()} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("un'immagine per logo, alt dal nome del file; quelli rotti spariscono", () => {
    const { container } = render(<PartnerLogos cfg={cfg({ partnerLogos: ["/a/esa.png", "/b/asi.svg"] })} />);
    const imgs = container.querySelectorAll("img");
    expect([...imgs].map((i) => i.alt)).toEqual(["esa", "asi"]);
    fireEvent.error(imgs[0]);
    expect(container.querySelectorAll("img")).toHaveLength(1);
    fireEvent.error(container.querySelector("img")!);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("applyBranding", () => {
  it("titolo della pagina", () => {
    applyBranding(cfg({ title: "G.E.M.A." }));
    expect(document.title).toBe("G.E.M.A.");
  });
  it("accent valido imposta il colore base; non valido o assente no", () => {
    applyBranding(cfg({ accent: "#0f766e" }));
    expect(css("--c-accent-base")).toBe("#0f766e");
    document.documentElement.removeAttribute("style");
    applyBranding(cfg({ accent: "red; background:url(x)" }));
    applyBranding(cfg());
    expect(css("--c-accent-base")).toBe("");
  });
  it("colore dell'header: variabili derivate per il tema scuro", () => {
    applyBranding(cfg({ headerColor: "#08181c" }));
    expect(css("--brand-header")).toBe("#08181c");
    for (const v of ["--brand-bg", "--brand-panel", "--brand-border", "--brand-row"]) expect(css(v)).toMatch(/^color-mix\(in srgb, #08181c \d+%, white\)$/);
  });
  it("colore dell'header non valido è ignorato", () => {
    applyBranding(cfg({ headerColor: "javascript:alert(1)" }));
    expect(css("--brand-header")).toBe("");
  });
  it("sfondo dei loghi partner: none, esadecimale, non valido", () => {
    applyBranding(cfg({ partnerLogosBg: "none" }));
    expect(css("--partner-bg")).toBe("transparent");
    expect(css("--partner-pad")).toBe("0px");
    document.documentElement.removeAttribute("style");
    applyBranding(cfg({ partnerLogosBg: "#ffeedd" }));
    expect(css("--partner-bg")).toBe("#ffeedd");
    document.documentElement.removeAttribute("style");
    applyBranding(cfg({ partnerLogosBg: "bianco" }));
    expect(css("--partner-bg")).toBe("");
  });
  it("favicon: crea il link se manca, lo riusa se c'è", () => {
    applyBranding(cfg({ favicon: "/f.png" }));
    const links = document.querySelectorAll('link[rel~="icon"]');
    expect(links).toHaveLength(1);
    expect((links[0] as HTMLLinkElement).href).toMatch(/\/f\.png$/);
    applyBranding(cfg({ favicon: "/g.png" }));
    expect(document.querySelectorAll('link[rel~="icon"]')).toHaveLength(1);
    expect((document.querySelector('link[rel~="icon"]') as HTMLLinkElement).href).toMatch(/\/g\.png$/);
    document.querySelector('link[rel~="icon"]')!.remove();
  });
});
