// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ACC, fakeKc } from "./support";

vi.mock("../src/backup", async (orig) => ({ ...(await orig<typeof import("../src/backup")>()), collect: vi.fn(), applyRestore: vi.fn() }));
vi.mock("../src/download", async (orig) => ({ ...(await orig<typeof import("../src/download")>()), saveBlob: vi.fn() }));
import * as bk from "../src/backup";
import * as dl from "../src/download";
import AdminBackup from "../src/AdminBackup";

const CURRENT = {
  rules: [{ fid: "role_rules.1", role: "ops", layers: ["*"], tools: [] }, { fid: "role_rules.2", role: "old", layers: [], tools: [] }],
  dashboards: [{ fid: "dashboards.1", title: "D", description: "", roles: [], widgets: [] }],
  forms: [],
};
const FILE = JSON.stringify({ format: "gema-config", version: 1, exportedAt: "2026-10-01T10:00:00Z", source: "uat.example", workspace: "altro", sections: {
  rules: [{ role: "ops", layers: ["*"], tools: ["info"] }, { role: "new", layers: ["ws:manca"], tools: [] }],
  dashboards: [{ title: "D", description: "", roles: [], widgets: [] }],
  announcements: [{ message: "Ciao" }],
} });

const setup = () => {
  const onChanged = vi.fn(async () => {});
  render(<AdminBackup gs="g" kc={fakeKc({})} acc={ACC} products={[{ name: "ws:a", title: "A", workspace: "ws" }] as never} onChanged={onChanged} />);
  return { onChanged };
};
const upload = async (text: string) => {
  await act(async () => { fireEvent.change(screen.getByLabelText("File di backup da ripristinare"), { target: { files: [new File([text], "backup.json", { type: "application/json" })] } }); });
};

beforeEach(() => {
  vi.mocked(bk.collect).mockReset().mockResolvedValue({ data: structuredClone(CURRENT) as never, errors: { announcements: "Feature type unknown" } });
  vi.mocked(bk.applyRestore).mockReset().mockResolvedValue(3);
  vi.mocked(dl.saveBlob).mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("AdminBackup", () => {
  it("backup: sezioni con il numero di righe, quelle non lette disattivate; file con le sezioni scelte", async () => {
    setup();
    const card = screen.getByRole("region", { name: "Backup" });
    expect(await within(card).findByText("(2)")).toBeInTheDocument();
    expect(within(card).getByLabelText(/Avvisi/)).toBeDisabled();
    expect(within(card).getByText(/Sezioni non lette .*: Avvisi/)).toBeInTheDocument();
    fireEvent.click(within(card).getByLabelText(/Dashboard/));
    fireEvent.click(within(card).getByRole("button", { name: "Scarica backup (JSON)" }));
    const [blob, name] = vi.mocked(dl.saveBlob).mock.calls[0];
    expect(name).toMatch(/^gema-config-.*\.json$/);
    const json = JSON.parse(await (blob as Blob).text());
    expect(json).toMatchObject({ format: "gema-config", workspace: ACC.workspace });
    expect(Object.keys(json.sections)).toEqual(["rules", "forms"]);
    expect(json.sections.rules[0]).not.toHaveProperty("fid");
  });

  it("ripristino: anteprima, avvisi, sezioni non disponibili, unione o sostituzione, copia di sicurezza", async () => {
    const { onChanged } = setup();
    await screen.findByText("(2)");
    await upload(FILE);
    const card = screen.getByRole("region", { name: "Ripristino" });
    expect(within(card).getByText(/backup del .* da uat\.example \(workspace altro, qui mapp\)/)).toBeInTheDocument();
    expect(within(card).getByLabelText(/^Avvisi/)).toBeDisabled(); // tabella non disponibile qui
    const rows = () => within(card).getAllByRole("row").map((r) => r.textContent);
    expect(rows()).toEqual(["SezioneNuoviModificatiDa eliminareUguali", "Regole dei ruoli1100", "Dashboard0001"]);
    expect(within(card).getByText(/non pubblicati in questo ambiente: ws:manca/)).toBeInTheDocument();
    fireEvent.click(within(card).getByLabelText(/Sostituisci/));
    expect(rows()[1]).toBe("Regole dei ruoli1110");
    fireEvent.click(within(card).getByRole("button", { name: "Ripristina (3 modifiche)" }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("3 modifiche, di cui 1 eliminazioni"));
    await waitFor(() => expect(bk.applyRestore).toHaveBeenCalled());
    const plan = vi.mocked(bk.applyRestore).mock.calls[0][3];
    expect(plan.map((p) => p.id)).toEqual(["rules", "dashboards"]);
    expect(plan[0].remove.map((r) => r.fid)).toEqual(["role_rules.2"]);
    expect(dl.saveBlob).toHaveBeenCalledTimes(1); // copia della configurazione attuale, prima di scrivere
    expect(await screen.findByText(/Ripristino completato: 3 modifiche applicate\. La copia/)).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
    expect(bk.collect).toHaveBeenCalledTimes(2);
  });

  it("senza copia di sicurezza; errore: nessuna modifica applicata", async () => {
    vi.mocked(bk.applyRestore).mockRejectedValueOnce(new Error("duplicate key"));
    setup();
    await screen.findByText("(2)");
    await upload(FILE);
    fireEvent.click(screen.getByLabelText("Scarica prima una copia della configurazione attuale"));
    fireEvent.click(screen.getByRole("button", { name: /^Ripristina \(/ }));
    expect(await screen.findByText("Ripristino non riuscito, nessuna modifica applicata: duplicate key")).toBeInTheDocument();
    expect(dl.saveBlob).not.toHaveBeenCalled();
  });

  it("niente da cambiare; file sbagliato", async () => {
    setup();
    await screen.findByText("(2)");
    await upload(JSON.stringify({ format: "gema-config", version: 1, sections: { dashboards: [{ title: "D", description: "", roles: [], widgets: [] }] } }));
    expect(screen.getByRole("button", { name: "Niente da cambiare" })).toBeDisabled();
    await upload("non json");
    expect(screen.getByText("File non utilizzabile: il file non è JSON valido")).toBeInTheDocument();
  });
});
