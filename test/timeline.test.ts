import { describe, expect, it } from "vitest";
import { expandRange, MAX_STEPS, parsePeriod, sampleSteps, shortTime, stepIndex, timeSteps } from "../src/timeline";

describe("parsePeriod", () => {
  it("giorni, settimane, ore, mesi e anni", () => {
    expect(parsePeriod("P1D")).toEqual({ months: 0, ms: 86_400_000 });
    expect(parsePeriod("P2W")).toEqual({ months: 0, ms: 14 * 86_400_000 });
    expect(parsePeriod("PT6H")).toEqual({ months: 0, ms: 6 * 3_600_000 });
    expect(parsePeriod("P1M")).toEqual({ months: 1, ms: 0 });
    expect(parsePeriod("P1Y")).toEqual({ months: 12, ms: 0 });
  });
  it("rifiuta periodi nulli, vuoti, misti o non ISO", () => {
    for (const p of ["P", "PT", "P0D", "P1DT", "P1M1D", "boh", ""]) expect(parsePeriod(p), p).toBeNull();
  });
});

describe("expandRange", () => {
  it("espande un intervallo giornaliero mantenendo il formato solo-data", () => {
    expect(expandRange("2026-01-30/2026-02-02/P1D")).toEqual(["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"]);
  });
  it("espande mesi e anni", () => {
    expect(expandRange("2026-01-01/2026-04-01/P1M")).toEqual(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"]);
    expect(expandRange("2020/2023/P1Y")).toEqual(["2020", "2021", "2022", "2023"]);
  });
  it("sotto il giorno usa l'ISO completo", () => {
    expect(expandRange("2026-01-01T00:00:00Z/2026-01-01T12:00:00Z/PT6H")).toEqual([
      "2026-01-01T00:00:00.000Z", "2026-01-01T06:00:00.000Z", "2026-01-01T12:00:00.000Z",
    ]);
  });
  it("null se manca il periodo, le date non sono valide, fine < inizio o i passi sono troppi", () => {
    expect(expandRange("2026-01-01/2026-02-01")).toBeNull();
    expect(expandRange("boh/2026-02-01/P1D")).toBeNull();
    expect(expandRange("2026-02-01/2026-01-01/P1D")).toBeNull();
    expect(expandRange("2000-01-01/2026-01-01/P1D")).toBeNull();
    expect(MAX_STEPS).toBeGreaterThan(500);
  });
});

describe("timeSteps", () => {
  it("elenco discreto: ordine cronologico (le capabilities lo tengono dalla più recente)", () => {
    expect(timeSteps({ extent: "", values: ["2026-03-01", "2026-02-01", "2026-01-01"] })).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
  });
  it("intervallo con periodo: espanso", () => {
    expect(timeSteps({ extent: "2026-01-01/2026-01-03/P1D" })).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
  });
  it("misto discreto + intervallo", () => {
    expect(timeSteps({ extent: "2025-12-01,2026-01-01/2026-01-02/P1D" })).toEqual(["2025-12-01", "2026-01-01", "2026-01-02"]);
  });
  it("non enumerabile -> vuoto", () => {
    expect(timeSteps({ extent: "2026-01-01/2026-02-01" })).toEqual([]);
    expect(timeSteps({ extent: "2000-01-01/2026-01-01/P1D" })).toEqual([]);
    expect(timeSteps(undefined)).toEqual([]);
  });
  it("valori non-data: mantiene l'ordine originale del catalogo", () => {
    expect(timeSteps({ extent: "", values: ["c", "b", "a"] })).toEqual(["a", "b", "c"]);
  });
});

describe("stepIndex", () => {
  const steps = ["2026-01-01", "2026-02-01", "2026-03-01"];
  it("vuoto = predefinito del layer, altrimenti l'ultimo", () => {
    expect(stepIndex(steps, "", "2026-02-01")).toBe(1);
    expect(stepIndex(steps, "")).toBe(2);
  });
  it("esatto, più vicino, intervallo libero, nessun istante", () => {
    expect(stepIndex(steps, "2026-01-01")).toBe(0);
    expect(stepIndex(steps, "2026-02-10")).toBe(1);
    expect(stepIndex(steps, "2026-01-01/2026-02-01")).toBe(-1);
    expect(stepIndex(steps, "boh")).toBe(-1);
    expect(stepIndex([], "2026-01-01")).toBe(-1);
  });
});

describe("sampleSteps / shortTime", () => {
  const steps = Array.from({ length: 101 }, (_, i) => String(i));
  it("equidistanti, con primo e ultimo", () => {
    const s = sampleSteps(steps, 5);
    expect(s).toEqual(["0", "25", "50", "75", "100"]);
  });
  it("sotto il massimo restituisce tutto", () => {
    expect(sampleSteps(["a", "b"], 5)).toEqual(["a", "b"]);
  });
  it("toglie l'ora solo a mezzanotte", () => {
    expect(shortTime("2026-01-01T00:00:00.000Z")).toBe("2026-01-01");
    expect(shortTime("2026-01-01T06:00:00.000Z")).toBe("2026-01-01T06:00:00.000Z");
  });
});
