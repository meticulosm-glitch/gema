import { describe, expect, it } from "vitest";
import {
  distinctValues, formatOptions, isDefaultRule, newValues, parseOptions, resolveForm, sanitizeFields, validateValues, type FieldRule,
} from "../src/editForm";

const SCHEMA = [{ name: "name", type: "string" }, { name: "kind", type: "string" }, { name: "area", type: "double" }, { name: "n", type: "int" }, { name: "surveyed", type: "date" }, { name: "ok", type: "boolean" }];

describe("sanitizeFields", () => {
  it("tiene solo regole valide: nomi unici, flag booleani veri, menu con valore testuale", () => {
    expect(sanitizeFields([
      { name: "kind", alias: " Tipo ", required: true, readonly: "si", options: [{ value: "A" }, { value: 1 }, null, { value: "B", label: "Bosco" }], default: "A", help: "  " },
      { name: "kind", alias: "doppione" },
      { alias: "senza nome" },
      { name: "area", hidden: true, default: "" },
      "x", null,
    ])).toEqual([
      { name: "kind", alias: "Tipo", required: true, options: [{ value: "A", label: "A" }, { value: "B", label: "Bosco" }], default: "A" },
      { name: "area", hidden: true },
    ]);
    expect(sanitizeFields("non array")).toEqual([]);
  });
  it("isDefaultRule", () => {
    expect(isDefaultRule({ name: "x" })).toBe(true);
    expect(isDefaultRule({ name: "x", options: [] })).toBe(true);
    expect(isDefaultRule({ name: "x", help: "h" })).toBe(false);
  });
});

describe("resolveForm", () => {
  const rules: FieldRule[] = [
    { name: "kind", alias: "Tipo", options: [{ value: "A", label: "Agricola" }], default: "A" },
    { name: "gone", alias: "colonna rimossa" },
    { name: "area", readonly: true, required: true },
    { name: "surveyed", hidden: true, required: true, default: "2026-01-01" },
  ];
  it("prima i campi configurati nel loro ordine, poi gli altri nell'ordine dello schema; colonne sparite ignorate", () => {
    expect(resolveForm(SCHEMA, { fields: rules }).map((f) => f.name)).toEqual(["kind", "area", "surveyed", "name", "n", "ok"]);
  });
  it("etichette, flag, menu e predefiniti; un campo nascosto non è mai obbligatorio", () => {
    const f = resolveForm(SCHEMA, { fields: rules });
    expect(f[0]).toEqual({ name: "kind", type: "string", label: "Tipo", required: false, readonly: false, hidden: false, options: [{ value: "A", label: "Agricola" }], default: "A", help: "" });
    expect(f[1]).toMatchObject({ name: "area", label: "area", readonly: true, required: true });
    expect(f[2]).toMatchObject({ name: "surveyed", hidden: true, required: false, default: "2026-01-01" });
  });
  it("senza modulo: schema com'è", () => {
    expect(resolveForm(SCHEMA, null).map((f) => [f.name, f.label, f.required])).toEqual(SCHEMA.map((s) => [s.name, s.name, false]));
  });
  it("newValues: predefiniti, vuoto altrove", () => {
    expect(newValues(resolveForm(SCHEMA, { fields: rules }))).toEqual({ kind: "A", area: "", surveyed: "2026-01-01", name: "", n: "", ok: "" });
  });
});

describe("validateValues", () => {
  const fields = resolveForm(SCHEMA, {
    fields: [{ name: "name", required: true }, { name: "kind", options: [{ value: "A", label: "A" }, { value: "B", label: "B" }] }, { name: "area", readonly: true, required: true }],
  });
  it("obbligatori, numeri, interi, date, booleani, voci del menu", () => {
    expect(validateValues(fields, { name: " ", kind: "Z", area: "", n: "1.5", surveyed: "01/02/2026", ok: "forse" }, true)).toEqual({
      name: "Campo obbligatorio.", kind: "Scegli un valore dall'elenco.", area: "Campo obbligatorio.", n: "Serve un numero intero.",
      surveyed: "Data nel formato AAAA-MM-GG.", ok: "Valore non valido.",
    });
    expect(validateValues(fields, { name: "x", kind: "B", area: "3", n: "-2", surveyed: "2026-02-01T10:00:00Z", ok: "true" }, true)).toEqual({});
    expect(validateValues(fields, { name: "x", area: "abc" }, true)).toEqual({ area: "Serve un numero." });
  });
  it("oggetto esistente: i campi in sola lettura non si validano (l'utente non li può correggere)", () => {
    expect(validateValues(fields, { name: "x", area: "" }, false)).toEqual({});
  });
});

describe("menu: testo e valori", () => {
  it("parseOptions / formatOptions", () => {
    const o = parseOptions("A|Agricola\n\n B \nA|doppione\nC| \n|senza valore");
    expect(o).toEqual([{ value: "A", label: "Agricola" }, { value: "B", label: "B" }, { value: "C", label: "C" }]);
    expect(formatOptions(o)).toBe("A|Agricola\nB\nC");
    expect(parseOptions(formatOptions(o))).toEqual(o);
    expect(formatOptions(undefined)).toBe("");
  });
  it("distinctValues: distinti, senza vuoti, ordine naturale, limite", () => {
    const rows = [{ k: "b" }, { k: "a" }, { k: null }, { k: "" }, { k: "b" }, { k: 10 }, { k: 9 }, {}];
    expect(distinctValues(rows, "k")).toEqual(["9", "10", "a", "b"]);
    expect(distinctValues(rows, "k", 2)).toEqual(["a", "b"]);
  });
});
