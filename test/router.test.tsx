// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Link, navigate, usePath } from "../src/router";

function Path() { return <span data-testid="p">{usePath()}</span>; }
afterEach(() => window.history.replaceState(null, "", "/"));

describe("router", () => {
  it("usePath parte dal pathname corrente", () => {
    window.history.replaceState(null, "", "/admin/roles");
    render(<Path />);
    expect(screen.getByTestId("p")).toHaveTextContent("/admin/roles");
  });
  it("navigate aggiorna URL e componenti", () => {
    render(<Path />);
    act(() => navigate("/dashboards"));
    expect(window.location.pathname).toBe("/dashboards");
    expect(screen.getByTestId("p")).toHaveTextContent("/dashboards");
  });
  it("indietro/avanti del browser (popstate)", () => {
    render(<Path />);
    act(() => { window.history.pushState(null, "", "/d/3"); window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(screen.getByTestId("p")).toHaveTextContent("/d/3");
  });
  it("Link: il clic semplice naviga senza ricaricare la pagina", () => {
    render(<><Path /><Link to="/admin/dashboards" className="x" title="t">Vai</Link></>);
    const a = screen.getByRole("link", { name: "Vai" });
    expect(a).toHaveAttribute("href", "/admin/dashboards");
    expect(fireEvent.click(a)).toBe(false); // preventDefault chiamato
    expect(screen.getByTestId("p")).toHaveTextContent("/admin/dashboards");
  });
  it("Link: Ctrl/Cmd/Shift/clic centrale lasciano il comportamento del browser (nuova scheda)", () => {
    render(<Link to="/x">Vai</Link>);
    const a = screen.getByRole("link");
    expect(fireEvent.click(a, { ctrlKey: true })).toBe(true);
    expect(fireEvent.click(a, { metaKey: true })).toBe(true);
    expect(fireEvent.click(a, { shiftKey: true })).toBe(true);
    expect(fireEvent.click(a, { button: 1 })).toBe(true);
    expect(window.location.pathname).toBe("/");
  });
  it("rimuove i listener allo smontaggio", () => {
    const { unmount } = render(<Path />);
    unmount();
    expect(() => act(() => navigate("/y"))).not.toThrow();
  });
});
