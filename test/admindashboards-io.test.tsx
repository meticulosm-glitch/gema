// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DashboardDef } from "../src/configStore";
import { ACC, fakeKc } from "./support";

vi.mock("../src/configStore", async (orig) => ({ ...(await orig<typeof import("../src/configStore")>()), saveDashboard: vi.fn(), importDashboards: vi.fn() }));
vi.mock("../src/Widgets", async (orig) => ({ ...(await orig<typeof import("../src/Widgets")>()), WidgetCard: () => <div data-testid="widget" /> }));
vi.mock("../src/api", async (orig) => ({ ...(await orig<typeof import("../src/api")>()), describeLayer: vi.fn(() => new Promise(() => {})) }));
vi.mock("../src/download", async (orig) => ({ ...(await orig<typeof import("../src/download")>()), saveBlob: vi.fn() }));
import * as store from "../src/configStore";
import * as dl from "../src/download";
import AdminDashboards from "../src/AdminDashboards";

const W = { id: "a", type: "kpi" as const, title: "K", layer: "iride:parcels", agg: "count" as const, w: 1 as const };
const DASH: DashboardDef[] = [{ fid: "dashboards.1", title: "Particelle", description: "d", roles: ["fss-etl-viewer"], widgets: [W] }];
const PRODUCTS = [{ name: "iride:parcels", title: "Particelle", workspace: "iride", vector: true }, { name: "iride:other", title: "Altro", workspace: "iride", vector: true }];

const setup = () => {
  const onChanged = vi.fn(async () => {});
  render(<AdminDashboards gs="http://gs" kc={fakeKc({ preferred_username: "ada" })} acc={ACC} rules={[]} dashboards={DASH} products={PRODUCTS} storeError={null} onChanged={onChanged} />);
  return { onChanged };
};
const upload = async (content: string) => {
  const input = screen.getByLabelText("Importa dashboard da un file JSON");
  await act(async () => { fireEvent.change(input, { target: { files: [new File([content], "d.json", { type: "application/json" })] } }); });
};

beforeEach(() => { vi.mocked(store.importDashboards).mockReset().mockResolvedValue(1); vi.mocked(store.saveDashboard).mockReset().mockResolvedValue(); vi.mocked(dl.saveBlob).mockReset(); });

describe("AdminDashboards: duplica, esporta, importa", () => {
  it("duplica: nuova bozza con '(copia)'", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /Particelle/ }));
    fireEvent.click(screen.getByRole("button", { name: "Duplica" }));
    expect((screen.getAllByLabelText("Titolo")[0] as HTMLInputElement).value).toBe("Particelle (copia)");
    expect(screen.queryByRole("button", { name: "Duplica" })).toBeNull();
  });

  it("esporta una e tutte: file JSON con il formato", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Esporta tutte (JSON)" }));
    const [blob, name] = vi.mocked(dl.saveBlob).mock.calls[0];
    expect(name).toMatch(/^dashboard-.*\.json$/);
    const json = JSON.parse(await (blob as Blob).text());
    expect(json).toMatchObject({ format: "gema-dashboards", version: 1, dashboards: [{ title: "Particelle", roles: ["fss-etl-viewer"] }] });
    fireEvent.click(screen.getByRole("button", { name: /Particelle/ }));
    fireEvent.click(screen.getByRole("button", { name: "Esporta (JSON)" }));
    expect(vi.mocked(dl.saveBlob).mock.calls[1][1]).toBe("dashboard-particelle.json");
  });

  it("importa: anteprima, rimappatura, sostituzione, una chiamata sola", async () => {
    const { onChanged } = setup();
    await upload(JSON.stringify({ format: "gema-dashboards", version: 1, dashboards: [
      { title: "Particelle", description: "", roles: [], widgets: [{ ...W, layer: "uat:x" }] },
      { title: "Nuova", description: "", roles: ["ruolo-uat"], widgets: [W] },
    ] }));
    const panel = await screen.findByRole("region", { name: "Importazione" });
    expect(within(panel).getByText(/Ruoli non ancora usati in questo ambiente: ruolo-uat/)).toBeInTheDocument();
    fireEvent.change(within(panel).getByLabelText("Sostituisci uat:x"), { target: { value: "iride:other" } });
    fireEvent.click(within(panel).getByLabelText(/Esiste già/));
    await act(async () => { fireEvent.click(within(panel).getByRole("button", { name: "Importa 2 dashboard (1 sostituite)" })); });
    const plan = vi.mocked(store.importDashboards).mock.calls[0][3];
    expect(plan.update).toEqual([expect.objectContaining({ fid: "dashboards.1", widgets: [expect.objectContaining({ layer: "iride:other" })] })]);
    expect(plan.insert.map((d) => d.title)).toEqual(["Nuova"]);
    expect(onChanged).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Importazione" })).toBeNull());
    expect(screen.getByRole("status")).toHaveTextContent("Importate 2 dashboard.");
  });

  it("file non valido: errore e nessuna anteprima", async () => {
    setup();
    await upload("non json");
    expect(await screen.findByText("Importazione non possibile: il file non è JSON valido")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Importazione" })).toBeNull();
  });

  it("errore di scrittura: l'anteprima resta per riprovare", async () => {
    vi.mocked(store.importDashboards).mockRejectedValue(new Error("duplicate key"));
    setup();
    await upload(JSON.stringify({ title: "Una", widgets: [W] }));
    const panel = await screen.findByRole("region", { name: "Importazione" });
    await act(async () => { fireEvent.click(within(panel).getByRole("button", { name: "Importa 1 dashboard" })); });
    expect(screen.getByRole("status")).toHaveTextContent("Operazione non riuscita: duplicate key");
    expect(screen.getByRole("region", { name: "Importazione" })).toBeInTheDocument();
  });
});
