import type Keycloak from "keycloak-js";
import { describeLayer, getWfsFeatures, type Feature, type Schema } from "./api";

/** Ricerca per attributo nei layer vettoriali attivi: un solo termine, confrontato (senza distinguere maiuscole) con gli attributi di testo. */
export const MAX_TEXT_FIELDS = 8;
export const MAX_TERM = 80;

const SIMPLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUMERIC = new Set(["int", "integer", "long", "short", "byte", "double", "float", "decimal"]);
const NAME_LIKE = ["nome", "name", "denominazione", "title", "titolo", "label", "etichetta", "descrizione", "description", "comune", "codice", "code", "id"];

/** Attributi interrogabili: testo (ILIKE) e numeri (uguaglianza, solo se il termine è un numero). Nomi non semplici sono scartati, per non rompere il CQL. */
export function searchableFields(schema: Pick<Schema, "fields">): { text: string[]; num: string[] } {
  const ok = schema.fields.filter((f) => SIMPLE_NAME.test(f.name));
  const text = ok.filter((f) => f.type === "string").map((f) => f.name);
  // gli attributi "tipo nome" per primi: se ce ne sono troppi, restano i più utili
  text.sort((a, b) => nameRank(a) - nameRank(b));
  return { text: text.slice(0, MAX_TEXT_FIELDS), num: ok.filter((f) => NUMERIC.has(f.type)).map((f) => f.name) };
}
const nameRank = (n: string) => {
  const i = NAME_LIKE.indexOf(n.toLowerCase());
  return i < 0 ? NAME_LIKE.length : i;
};

/** Filtro CQL: attributi di testo ILIKE '%termine%' in OR (più uguaglianza sui numeri se il termine è numerico); null se non c'è nulla da cercare. */
export function buildSearchCql(termRaw: string, fields: { text: string[]; num: string[] }): string | null {
  const term = termRaw.trim().slice(0, MAX_TERM);
  if (!term) return null;
  const parts = fields.text.map((f) => `${f} ILIKE '%${term.replace(/'/g, "''")}%'`);
  if (/^-?\d+(\.\d+)?$/.test(term)) for (const f of fields.num) parts.push(`${f} = ${term}`);
  return parts.length > 0 ? parts.join(" OR ") : null;
}

export interface AttrHit { layer: string; title: string; feature: Feature; label: string; match?: string }

const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/** Etichetta leggibile di un oggetto: attributo "nome" se c'è, altrimenti il primo testo non vuoto, altrimenti l'id. */
export function featureLabel(f: Feature): string {
  const p = f.properties ?? {};
  const keys = Object.keys(p);
  for (const n of NAME_LIKE) {
    const k = keys.find((x) => x.toLowerCase() === n);
    if (k && str(p[k])) return str(p[k]);
  }
  const first = keys.find((k) => typeof p[k] === "string" && str(p[k]));
  return first ? str(p[first]) : (f.id ?? "(oggetto)");
}

/** Attributo in cui compare il termine, se diverso dall'etichetta ("comune: Bari"). */
export function matchedField(f: Feature, term: string, label: string): string | undefined {
  const t = term.trim().toLowerCase();
  for (const [k, v] of Object.entries(f.properties ?? {})) {
    if (typeof v === "string" && v.toLowerCase().includes(t) && v !== label) return `${k}: ${v}`;
  }
  return undefined;
}

export interface SearchOutcome {
  hits: AttrHit[];
  skipped: string[];                         // layer non vettoriali o senza attributi di testo
  errors: { layer: string; message: string }[];
}

/** Cerca il termine in ciascun layer (in parallelo). I layer raster vengono saltati, gli errori sono per layer e non bloccano gli altri. */
export async function searchLayers(
  gsUrl: string,
  kc: Keycloak | null,
  layers: { name: string; title: string }[],
  term: string,
  perLayer = 5,
): Promise<SearchOutcome> {
  const out: SearchOutcome = { hits: [], skipped: [], errors: [] };
  await Promise.all(
    layers.map(async (l) => {
      let schema: Schema;
      try {
        schema = await describeLayer(gsUrl, kc, l.name);
      } catch {
        out.skipped.push(l.title);
        return;
      }
      const cql = buildSearchCql(term, searchableFields(schema));
      if (!cql) { out.skipped.push(l.title); return; }
      try {
        const fs = await getWfsFeatures(gsUrl, kc, l.name, cql, perLayer);
        for (const feature of fs) {
          const label = featureLabel(feature);
          out.hits.push({ layer: l.name, title: l.title, feature, label, match: matchedField(feature, term, label) });
        }
      } catch (e: any) {
        out.errors.push({ layer: l.title, message: e?.message ?? String(e) });
      }
    }),
  );
  // ordine stabile: come l'elenco dei layer passato
  const order = new Map(layers.map((l, i) => [l.name, i]));
  out.hits.sort((a, b) => (order.get(a.layer)! - order.get(b.layer)!));
  return out;
}
