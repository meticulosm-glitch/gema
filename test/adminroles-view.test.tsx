// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { Product } from "../src/capabilities";
import type { RoleView } from "../src/roleView";
import { ACC, fakeKc } from "./support";

vi.mock("../src/configStore", async (orig) => ({ ...(await orig<typeof import("../src/configStore")>()), saveRoleSettings: vi.fn(), deleteRoleSettings: vi.fn() }));
// la mini-mappa usa maplibre: qui basta un sostituto che "sceglie" un'area fissa
vi.mock("../src/BboxPicker", () => ({
  default: (p: any) => <div data-testid="picker">iniziale={String(p.initial)}<button onClick={() => p.onPick([10.1234567, 44, 11, 45])}>Usa questa inquadratura</button><button onClick={p.onCancel}>Annulla</button></div>,
}));
import * as store from "../src/configStore";
import AdminRoles from "../src/AdminRoles";

const P = (name: string, title: string): Product => ({ name, title, workspace: name.split(":")[0] });
const PRODUCTS = [P("iride:ndvi", "NDVI"), P("iride:parcels", "Particelle"), P("demo:roads", "Strade")];
const BASEMAPS = [{ id: "osm", label: "Mappa" }, { id: "grigio", label: "Grigio" }];

const setup = (views: RoleView[] = [], roleViewsError: string | null = null) => {
  const onChanged = vi.fn(async () => {});
  render(
    <AdminRoles
      gs="http://gs" kc={fakeKc({ preferred_username: "ada" })} acc={ACC} rules={[{ fid: "role_rules.1", role: ACC.viewerRole, layers: ["iride:ndvi", "demo:roads"], tools: ["info"] }]}
      dashboards={[]} products={PRODUCTS} storeError={null} onChanged={onChanged}
      roleViews={views} roleViewsError={roleViewsError} basemaps={BASEMAPS} mapStart={{ center: [12, 42], zoom: 6 }}
    />,
  );
  const card = document.querySelector(`.role-card[data-role="${ACC.viewerRole}"]`) as HTMLElement;
  return { card, onChanged, q: within(card) };
};
const bbox = (q: ReturnType<typeof within>, l: string) => q.getByLabelText(`${l} (gradi)`) as HTMLInputElement;

beforeEach(() => { vi.mocked(store.saveRoleSettings).mockReset().mockResolvedValue(); vi.mocked(store.deleteRoleSettings).mockReset().mockResolvedValue(); });

describe("AdminRoles: vista iniziale per ruolo", () => {
  it("mostra la vista salvata: area, sfondo, layer; i layer proposti sono solo quelli visibili al ruolo", () => {
    const { q } = setup([{ fid: "role_views.3", role: ACC.viewerRole, bbox: [12.45, 41.85, 12.55, 41.95], basemap: "grigio", layers: ["demo:roads"] }]);
    expect(bbox(q, "Ovest").value).toBe("12.45");
    expect(bbox(q, "Nord").value).toBe("41.95");
    expect((q.getByLabelText("Sfondo iniziale") as HTMLSelectElement).value).toBe("grigio");
    const list = q.getByLabelText("Cerca tra i layer da accendere").nextElementSibling as HTMLElement;
    expect(within(list).getAllByRole("checkbox").map((c) => (c.closest("label") as HTMLElement).title)).toEqual(["iride:ndvi", "demo:roads"]);
    expect((within(list).getByTitle("demo:roads").querySelector("input") as HTMLInputElement).checked).toBe(true);
  });

  it("salva regola e vista con una sola chiamata", async () => {
    const { q, onChanged } = setup();
    fireEvent.change(bbox(q, "Ovest"), { target: { value: "12,45" } });
    fireEvent.change(bbox(q, "Sud"), { target: { value: "41.85" } });
    fireEvent.change(bbox(q, "Est"), { target: { value: "12.55" } });
    fireEvent.change(bbox(q, "Nord"), { target: { value: "41.95" } });
    fireEvent.change(q.getByLabelText("Sfondo iniziale"), { target: { value: "grigio" } });
    fireEvent.click(within(q.getByLabelText("Cerca tra i layer da accendere").nextElementSibling as HTMLElement).getByTitle("iride:ndvi").querySelector("input")!);
    await act(async () => { fireEvent.click(q.getByRole("button", { name: "Salva regola" })); });
    expect(store.saveRoleSettings).toHaveBeenCalledTimes(1);
    const [, , , rule, view] = vi.mocked(store.saveRoleSettings).mock.calls[0];
    expect(rule).toMatchObject({ fid: "role_rules.1", role: ACC.viewerRole, layers: ["iride:ndvi", "demo:roads"] });
    expect(view).toEqual({ role: ACC.viewerRole, bbox: [12.45, 41.85, 12.55, 41.95], basemap: "grigio", layers: ["iride:ndvi"] });
    expect(onChanged).toHaveBeenCalled();
  });

  it("area incompleta o sbagliata: errore e salvataggio bloccato; 'Togli l'area' la svuota", () => {
    const { q } = setup();
    fireEvent.change(bbox(q, "Ovest"), { target: { value: "13" } });
    expect(q.getByText(/Area non valida/)).toBeInTheDocument();
    expect(q.getByRole("button", { name: "Salva regola" })).toBeDisabled();
    fireEvent.change(bbox(q, "Sud"), { target: { value: "41" } });
    fireEvent.change(bbox(q, "Est"), { target: { value: "12" } }); // est < ovest
    fireEvent.change(bbox(q, "Nord"), { target: { value: "42" } });
    expect(q.getByText(/Area non valida/)).toBeInTheDocument();
    fireEvent.click(q.getByRole("button", { name: "Togli l'area" }));
    expect(q.queryByText(/Area non valida/)).toBeNull();
    expect(bbox(q, "Ovest").value).toBe("");
  });

  it("'Scegli sulla mappa': l'area scelta riempie i campi (arrotondata) e il selettore si chiude", async () => {
    const { q } = setup();
    fireEvent.click(q.getByRole("button", { name: "Scegli sulla mappa" }));
    const picker = await q.findByTestId("picker");
    expect(picker).toHaveTextContent("iniziale=undefined");
    fireEvent.click(within(picker).getByRole("button", { name: "Usa questa inquadratura" }));
    expect([bbox(q, "Ovest").value, bbox(q, "Sud").value, bbox(q, "Est").value, bbox(q, "Nord").value]).toEqual(["10.123457", "44", "11", "45"]);
    expect(q.queryByTestId("picker")).toBeNull();
  });

  it("layer da accendere che il ruolo non vede più: segnalati e non salvati", async () => {
    const { q } = setup([{ fid: "role_views.3", role: ACC.viewerRole, basemap: "", layers: ["iride:parcels", "iride:ndvi"] }]);
    expect(q.getByText(/Non verranno accesi perché il ruolo non li vede: iride:parcels/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(q.getByRole("button", { name: "Salva regola" })); });
    expect(vi.mocked(store.saveRoleSettings).mock.calls[0][4]?.layers).toEqual(["iride:ndvi"]);
  });

  it("elimina regola: anche la vista del ruolo", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { q } = setup([{ fid: "role_views.3", role: ACC.viewerRole, basemap: "grigio", layers: [] }]);
    await act(async () => { fireEvent.click(q.getByRole("button", { name: "Elimina regola" })); });
    expect(store.deleteRoleSettings).toHaveBeenCalledWith("http://gs", expect.anything(), ACC, "role_rules.1", "role_views.3");
  });

  it("ruolo con sola vista (senza regola) compare nell'elenco", () => {
    setup([{ fid: "role_views.9", role: "solo-vista", basemap: "osm", layers: [] }]);
    expect(document.querySelector('.role-card[data-role="solo-vista"]')).not.toBeNull();
  });

  it("tabella delle viste mancante: avviso, campi disattivati, si salva solo la regola", async () => {
    const { q } = setup([], "Tabella delle viste iniziali non trovata");
    expect(screen.getByText("Tabella delle viste iniziali non trovata")).toBeInTheDocument();
    expect(bbox(q, "Ovest")).toBeDisabled();
    expect(q.getByLabelText("Sfondo iniziale")).toBeDisabled();
    await act(async () => { fireEvent.click(q.getByRole("button", { name: "Salva regola" })); });
    expect(vi.mocked(store.saveRoleSettings).mock.calls[0][4]).toBeUndefined();
  });
});

describe("AdminRoles: visualizza come ruolo", () => {
  it("pulsante su ogni ruolo; senza callback non compare", () => {
    const onViewAs = vi.fn();
    render(<AdminRoles gs="http://gs" kc={fakeKc({})} acc={ACC} rules={[{ fid: "role_rules.1", role: ACC.viewerRole, layers: ["*"], tools: [] }]} dashboards={[]} products={PRODUCTS} storeError={null} onChanged={async () => {}} onViewAs={onViewAs} />);
    fireEvent.click(screen.getByRole("button", { name: `Visualizza come ${ACC.viewerRole}` }));
    expect(onViewAs).toHaveBeenCalledWith(ACC.viewerRole);
  });
  it("senza callback nessun pulsante", () => {
    setup();
    expect(screen.queryByRole("button", { name: /Visualizza come/ })).toBeNull();
  });
});
