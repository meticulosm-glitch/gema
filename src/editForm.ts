import type { Field } from "./api";

/**
 * Modulo di modifica di un layer: come appaiono e come si validano gli attributi nell'editor (WFS-T).
 * Una riga per layer nella tabella edit_forms; i campi non configurati restano come prima (nome della colonna, testo libero).
 * Sono regole dell'interfaccia: i vincoli veri (NOT NULL, CHECK...) restano quelli del database.
 */
export interface FieldOption { value: string; label: string }
export interface FieldRule {
  name: string;          // colonna
  alias?: string;        // etichetta mostrata
  required?: boolean;
  readonly?: boolean;    // visibile ma non modificabile (nei nuovi oggetti prende il valore predefinito)
  hidden?: boolean;      // non mostrato (nei nuovi oggetti prende il valore predefinito)
  options?: FieldOption[]; // menu a tendina
  default?: string;      // valore iniziale dei nuovi oggetti
  help?: string;         // testo d'aiuto sotto il campo
}
export interface FormDef { fid?: string; layer: string; fields: FieldRule[]; updatedBy?: string; updatedAt?: string }

/** Campo come lo mostra l'editor. */
export interface FormField {
  name: string; type: string; label: string; required: boolean; readonly: boolean; hidden: boolean;
  options?: FieldOption[]; default: string; help: string;
}

const NUMERIC = ["int", "integer", "long", "short", "byte", "double", "float", "decimal"];
export const isNumericType = (t: string) => NUMERIC.includes(t.toLowerCase());
export const isDateType = (t: string) => t.toLowerCase().startsWith("date");

const s = (v: unknown) => (typeof v === "string" ? v : "");

/** Definizione letta dal database (JSON scritto a mano o da una versione precedente): solo ciò che ha senso. */
export function sanitizeFields(raw: unknown): FieldRule[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: FieldRule[] = [];
  for (const x of raw as any[]) {
    if (!x || typeof x !== "object" || typeof x.name !== "string" || !x.name || seen.has(x.name)) continue;
    seen.add(x.name);
    const options = Array.isArray(x.options)
      ? (x.options as any[]).filter((o) => o && typeof o.value === "string").map((o) => ({ value: o.value, label: s(o.label) || o.value }))
      : [];
    out.push({
      name: x.name,
      ...(s(x.alias).trim() ? { alias: s(x.alias).trim() } : {}),
      ...(x.required === true ? { required: true } : {}),
      ...(x.readonly === true ? { readonly: true } : {}),
      ...(x.hidden === true ? { hidden: true } : {}),
      ...(options.length ? { options } : {}),
      ...(typeof x.default === "string" && x.default !== "" ? { default: x.default } : {}),
      ...(s(x.help).trim() ? { help: s(x.help).trim() } : {}),
    });
  }
  return out;
}

/** Una regola che non cambia nulla rispetto al comportamento predefinito. */
export const isDefaultRule = (r: FieldRule) => !r.alias && !r.required && !r.readonly && !r.hidden && !r.options?.length && !r.default && !r.help;

/**
 * Campi dell'editor: prima quelli configurati, nell'ordine del modulo; poi gli altri dello schema, nel loro ordine.
 * Le regole di colonne che non esistono più vengono ignorate.
 */
export function resolveForm(schema: Field[], def?: Pick<FormDef, "fields"> | null): FormField[] {
  const rules = new Map((def?.fields ?? []).map((r) => [r.name, r]));
  const byName = new Map(schema.map((f) => [f.name, f]));
  const order = [...(def?.fields ?? []).map((r) => r.name).filter((n) => byName.has(n)), ...schema.map((f) => f.name).filter((n) => !rules.has(n))];
  return order.map((n) => {
    const f = byName.get(n)!;
    const r = rules.get(n);
    return {
      name: n, type: f.type, label: r?.alias || n,
      required: !!r?.required && !r?.hidden, readonly: !!r?.readonly, hidden: !!r?.hidden,
      ...(r?.options?.length ? { options: r.options } : {}),
      default: r?.default ?? "", help: r?.help ?? "",
    };
  });
}

/** Valori iniziali di un nuovo oggetto: i predefiniti, vuoto altrimenti. */
export const newValues = (fields: FormField[]) => Object.fromEntries(fields.map((f) => [f.name, f.default]));

const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Errori del modulo (campo -> messaggio). I campi in sola lettura o nascosti di un oggetto esistente non si validano:
 * l'utente non li può correggere.
 */
export function validateValues(fields: FormField[], values: Record<string, string>, isNew: boolean): Record<string, string> {
  const errs: Record<string, string> = {};
  for (const f of fields) {
    if (!isNew && (f.readonly || f.hidden)) continue;
    const v = (values[f.name] ?? "").trim();
    if (!v) { if (f.required) errs[f.name] = "Campo obbligatorio."; continue; }
    if (isNumericType(f.type) && !Number.isFinite(Number(v))) errs[f.name] = "Serve un numero.";
    else if (/^(int|integer|long|short|byte)$/i.test(f.type) && !Number.isInteger(Number(v))) errs[f.name] = "Serve un numero intero.";
    else if (isDateType(f.type) && !DATE_RE.test(v)) errs[f.name] = "Data nel formato AAAA-MM-GG.";
    else if (f.type.toLowerCase() === "boolean" && !/^(true|false)$/.test(v)) errs[f.name] = "Valore non valido.";
    else if (f.options && !f.options.some((o) => o.value === v)) errs[f.name] = "Scegli un valore dall'elenco.";
  }
  return errs;
}

/** Testo "valore|etichetta" (una voce per riga) <-> voci del menu. Righe vuote ignorate, valori doppi tenuti una volta. */
export function parseOptions(text: string): FieldOption[] {
  const out: FieldOption[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const i = line.indexOf("|");
    const value = (i < 0 ? line : line.slice(0, i)).trim();
    const label = (i < 0 ? "" : line.slice(i + 1)).trim();
    if (value && !out.some((o) => o.value === value)) out.push({ value, label: label || value });
  }
  return out;
}
export const formatOptions = (opts?: FieldOption[]) => (opts ?? []).map((o) => (o.label && o.label !== o.value ? `${o.value}|${o.label}` : o.value)).join("\n");

/** Valori distinti di un attributo (per proporre un menu), ordinati; al massimo `max`. */
export function distinctValues(rows: Record<string, unknown>[], field: string, max = 200): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    const v = r?.[field];
    if (v === null || v === undefined || v === "") continue;
    set.add(String(v));
    if (set.size >= max) break;
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, "it", { numeric: true }));
}
