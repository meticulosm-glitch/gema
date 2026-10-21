// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  blankAnnouncement, dismissKey, fromLocalInput, linkify, loadDismissed, phaseOf, sanitizeLevel, storeDismissed, toLocalInput,
  validateAnnouncement, visibleAnnouncements, type Announcement,
} from "../src/announcements";

const NOW = Date.parse("2026-10-20T10:00:00Z");
const A = (message: string, extra: Partial<Announcement> = {}): Announcement => ({ ...blankAnnouncement(), fid: `a.${message}`, message, updatedAt: "2026-10-01T00:00:00Z", ...extra });

afterEach(() => localStorage.clear());

describe("phaseOf", () => {
  it("spento, programmato, in corso, scaduto; date non valide ignorate", () => {
    expect(phaseOf(A("x", { active: false }), NOW)).toBe("off");
    expect(phaseOf(A("x", { startsAt: "2026-10-20T11:00:00Z" }), NOW)).toBe("scheduled");
    expect(phaseOf(A("x", { startsAt: "2026-10-20T09:00:00Z", endsAt: "2026-10-20T10:00:00Z" }), NOW)).toBe("ended");
    expect(phaseOf(A("x", { startsAt: "2026-10-20T10:00:00Z", endsAt: "2026-10-20T10:00:01Z" }), NOW)).toBe("live");
    expect(phaseOf(A("x", { startsAt: "domani" }), NOW)).toBe("live");
    expect(phaseOf(A("x", { endsAt: "2026-10-20T12:00:00+02:00" }), NOW)).toBe("ended");
  });
});

describe("visibleAnnouncements", () => {
  const list = [
    A("info vecchia", { updatedAt: "2026-01-01T00:00:00Z" }),
    A("info nuova", { updatedAt: "2026-09-01T00:00:00Z" }),
    A("solo ops", { roles: ["ops"] }),
    A("manutenzione", { level: "maintenance", dismissible: false }),
    A("attenzione", { level: "warning" }),
    A("programmata", { startsAt: "2026-10-21T00:00:00Z" }),
    A("spenta", { active: false }),
  ];
  it("in corso, per tutti o per i miei ruoli; manutenzione, poi attenzione, poi informazioni (più recenti prima)", () => {
    expect(visibleAnnouncements(list, ["viewer"], NOW).map((a) => a.message)).toEqual(["manutenzione", "attenzione", "info nuova", "info vecchia"]);
    expect(visibleAnnouncements(list, ["ops"], NOW).map((a) => a.message)).toContain("solo ops");
  });
  it("chiusi: spariscono, tranne quelli non chiudibili; una nuova versione ricompare", () => {
    const closed = new Set([dismissKey(list[1]), dismissKey(list[3])]);
    const shown = visibleAnnouncements(list, [], NOW, closed).map((a) => a.message);
    expect(shown).toContain("manutenzione");
    expect(shown).not.toContain("info nuova");
    expect(visibleAnnouncements([{ ...list[1], updatedAt: "2026-10-19T00:00:00Z" }], [], NOW, closed)).toHaveLength(1);
  });
  it("chiusure ricordate nel browser (al massimo 200), storage non valido = nessuna", () => {
    storeDismissed(new Set(Array.from({ length: 250 }, (_, i) => `k${i}`)));
    const d = loadDismissed();
    expect(d.size).toBe(200);
    expect(d.has("k249")).toBe(true);
    localStorage.setItem("mapp.dismissedAnnouncements", "{rotto");
    expect(loadDismissed().size).toBe(0);
  });
});

describe("validateAnnouncement / sanitizeLevel", () => {
  it("testo obbligatorio e non troppo lungo, date valide e in ordine", () => {
    expect(validateAnnouncement(A("ok"))).toEqual([]);
    expect(validateAnnouncement(A("  "))).toEqual(["Scrivi il testo dell'avviso."]);
    expect(validateAnnouncement(A("x".repeat(1001)))).toEqual(["Il testo è troppo lungo (massimo 1000 caratteri)."]);
    expect(validateAnnouncement(A("x", { startsAt: "ieri", endsAt: "2026-13-01" }))).toEqual(["Data di inizio non valida.", "Data di fine non valida."]);
    expect(validateAnnouncement(A("x", { startsAt: "2026-10-20T10:00:00Z", endsAt: "2026-10-20T10:00:00Z" }))).toEqual(["La fine deve venire dopo l'inizio."]);
  });
  it("livello sconosciuto = informazione", () => {
    expect(sanitizeLevel("maintenance")).toBe("maintenance");
    expect(sanitizeLevel("panic")).toBe("info");
    expect(sanitizeLevel(undefined)).toBe("info");
  });
});

describe("date e link", () => {
  it("datetime-local (ora locale) <-> ISO in UTC, andata e ritorno", () => {
    const iso = fromLocalInput("2026-10-20T12:30");
    expect(iso).toMatch(/^2026-10-20T\d{2}:30:00Z$/);
    expect(toLocalInput(iso)).toBe("2026-10-20T12:30");
    expect(fromLocalInput("")).toBe("");
    expect(fromLocalInput("20/10/2026")).toBe("");
    expect(toLocalInput("")).toBe("");
  });
  it("linkify: solo http/https, punteggiatura finale fuori dal link, nessun HTML", () => {
    expect(linkify("Vedi https://x.org/a?b=1. Oppure http://y.it, e <b>")).toEqual([
      { text: "Vedi " }, { text: "https://x.org/a?b=1", href: "https://x.org/a?b=1" }, { text: ". Oppure " },
      { text: "http://y.it", href: "http://y.it" }, { text: ", e <b>" },
    ]);
    expect(linkify("javascript:alert(1)")).toEqual([{ text: "javascript:alert(1)" }]);
    expect(linkify("")).toEqual([]);
  });
});
