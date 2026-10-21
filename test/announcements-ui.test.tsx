// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import AnnouncementBar from "../src/AnnouncementBar";
import { blankAnnouncement, type Announcement } from "../src/announcements";
import { ACC, el, fakeKc, mockFetch, XSD } from "./support";

vi.mock("../src/configStore", async (orig) => ({ ...(await orig<typeof import("../src/configStore")>()), saveAnnouncement: vi.fn(), deleteAnnouncement: vi.fn() }));
import * as store from "../src/configStore";
import AdminAnnouncements from "../src/AdminAnnouncements";

const A = (message: string, extra: Partial<Announcement> = {}): Announcement => ({ ...blankAnnouncement(), fid: `announcements.${message.length}`, message, ...extra });

describe("AnnouncementBar", () => {
  it("niente avvisi = niente barra; link cliccabili in una nuova scheda; manutenzione senza chiusura", () => {
    const { container, rerender } = render(<AnnouncementBar items={[]} onDismiss={() => {}} />);
    expect(container.innerHTML).toBe("");
    const onDismiss = vi.fn();
    rerender(<AnnouncementBar items={[A("Leggi https://x.org/n"), A("Fermo!", { level: "maintenance", dismissible: true })]} onDismiss={onDismiss} />);
    const link = screen.getByRole("link", { name: "https://x.org/n" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(screen.getByRole("alert")).queryByRole("button")).toBeNull();
    fireEvent.click(within(screen.getByRole("status")).getByRole("button", { name: "Chiudi l'avviso" }));
    expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ message: "Leggi https://x.org/n" }));
  });
});

describe("AdminAnnouncements", () => {
  beforeEach(() => {
    vi.mocked(store.saveAnnouncement).mockReset().mockResolvedValue();
    vi.mocked(store.deleteAnnouncement).mockReset().mockResolvedValue();
  });
  const setup = (items: Announcement[] = [], tableError: string | null = null) => {
    const onChanged = vi.fn(async () => {});
    render(<AdminAnnouncements gs="http://gs" kc={fakeKc({ preferred_username: "ada" })} acc={ACC} items={items} tableError={tableError} knownRoles={["ops", ACC.viewerRole]} onChanged={onChanged} />);
    return { onChanged };
  };
  const field = (label: string) => screen.getByText(label, { selector: "span" }).parentElement!.querySelector("input, textarea, select") as HTMLInputElement;

  it("nuovo avviso per alcuni ruoli, con periodo: salva i valori in ISO", async () => {
    const { onChanged } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Nuovo avviso" }));
    expect(screen.getByRole("button", { name: "Salva avviso" })).toBeDisabled();
    fireEvent.change(field("Testo"), { target: { value: "Fermo per manutenzione" } });
    fireEvent.change(field("Tipo"), { target: { value: "maintenance" } });
    expect(screen.getByLabelText(/L'utente lo può chiudere/)).toBeDisabled();
    fireEvent.change(field("Dal (vuoto = subito)"), { target: { value: "2026-10-22T18:00" } });
    fireEvent.change(field("Al (vuoto = finché non lo spegni)"), { target: { value: "2026-10-22T20:00" } });
    fireEvent.click(screen.getByLabelText("Tutti"));
    expect(screen.getByLabelText(ACC.viewerRole)).toBeChecked();
    fireEvent.click(screen.getByLabelText(ACC.viewerRole));
    expect(screen.getByText("Scegli almeno un ruolo, oppure «Tutti».")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("ops"));
    expect(screen.getByRole("alert")).toHaveTextContent("Fermo per manutenzione"); // anteprima
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Salva avviso" })); });
    const a = vi.mocked(store.saveAnnouncement).mock.calls[0][3];
    expect(a).toMatchObject({ message: "Fermo per manutenzione", level: "maintenance", roles: ["ops"], active: true });
    expect(a.startsAt).toMatch(/^2026-10-22T\d{2}:00:00Z$/);
    expect(Date.parse(a.endsAt) - Date.parse(a.startsAt)).toBe(2 * 3600_000);
    expect(onChanged).toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Avviso salvato.");
  });

  it("elenco: stato, modifica, spegni/accendi, elimina", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    setup([A("Uno"), A("Spento da tempo", { active: false }), A("Futuro", { startsAt: "2999-01-01T00:00:00Z" })]);
    const rows = Array.from(document.querySelectorAll(".ann-row")) as HTMLElement[];
    expect(rows.map((r) => r.querySelector(".tag")!.textContent)).toEqual(["in corso", "spento", "programmato"]);
    await act(async () => { fireEvent.click(within(rows[1]).getByRole("button", { name: "Accendi" })); });
    expect(vi.mocked(store.saveAnnouncement).mock.calls[0][3]).toMatchObject({ message: "Spento da tempo", active: true });
    await act(async () => { fireEvent.click(within(rows[0]).getByRole("button", { name: "Elimina" })); });
    expect(store.deleteAnnouncement).toHaveBeenCalledWith("http://gs", expect.anything(), ACC, "announcements.3");
    fireEvent.click(within(rows[2]).getByRole("button", { name: "Modifica" }));
    expect(field("Testo").value).toBe("Futuro");
  });

  it("tabella mancante: errore e 'Nuovo avviso' disattivato; errore di scrittura mostrato", async () => {
    setup([], "Tabella degli avvisi non trovata");
    expect(screen.getByRole("button", { name: "Nuovo avviso" })).toBeDisabled();
  });

  it("errore di scrittura: messaggio e bozza conservata", async () => {
    vi.mocked(store.saveAnnouncement).mockRejectedValue(new Error("scrittura negata (HTTP 403)"));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Nuovo avviso" }));
    fireEvent.change(field("Testo"), { target: { value: "Ciao" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Salva avviso" })); });
    expect(screen.getByText("Operazione non riuscita: scrittura negata (HTTP 403)")).toHaveAttribute("role", "status");
    expect(field("Testo").value).toBe("Ciao");
  });
});

describe("configStore: avvisi", () => {
  it("lettura normalizzata e scrittura con manutenzione mai chiudibile", async () => {
    const { loadAnnouncements, saveAnnouncement } = await vi.importActual<typeof import("../src/configStore")>("../src/configStore");
    const posts: string[] = [];
    mockFetch((url, init) => {
      if (init?.method === "POST") { posts.push(String(init.body)); return { body: "<wfs:SUCCESS/>" }; }
      if (url.includes("DescribeFeatureType")) return { body: XSD("announcements", ["message", "level", "starts_at", "ends_at", "roles"].map((n) => el(n, "xsd:string")).join("") + el("dismissible", "xsd:boolean") + el("active", "xsd:boolean"), "http://x/m") };
      return { body: JSON.stringify({ features: [
        { id: "announcements.1", properties: { message: "Ok", level: "boh", starts_at: "domani", ends_at: "2026-10-22T20:00:00Z", roles: "rotto", dismissible: null, active: false, updated_at: "2026-10-01" } },
        { id: "announcements.2", properties: { message: "  ", level: "info" } },
      ] }) };
    });
    expect(await loadAnnouncements("/gs-ann", null, ACC)).toEqual([
      { fid: "announcements.1", message: "Ok", level: "info", startsAt: "", endsAt: "2026-10-22T20:00:00Z", roles: [], dismissible: true, active: false, updatedBy: undefined, updatedAt: "2026-10-01" },
    ]);
    await saveAnnouncement("/gs-ann", null, ACC, A("Stop", { level: "maintenance", dismissible: true, roles: ["ops"] }));
    expect(posts[0]).toContain("<wfs:Name>dismissible</wfs:Name><wfs:Value>false</wfs:Value>");
    expect(posts[0]).toContain("<wfs:Name>roles</wfs:Name><wfs:Value>[&quot;ops&quot;]</wfs:Value>");
    expect(posts[0]).toContain('fid="announcements.4"');
  });
});
