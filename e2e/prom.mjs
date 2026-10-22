// Lettura e controllo del formato testuale di Prometheus (0.0.4), per i test di /metrics: unitari, integrazione ed e2e.
// Rigoroso quanto basta a scoprire ciò che Prometheus rifiuterebbe: righe malformate, campioni senza TYPE, nomi o
// etichette non validi, serie duplicate, istogrammi con bucket non cumulativi o senza +Inf, _count diverso da +Inf.

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const TYPES = new Set(["counter", "gauge", "histogram", "summary", "untyped"]);

/** Etichette `a="x",b="y"` -> oggetto (con gli escape \\ \" \n). */
function parseLabels(s, line) {
  const out = {};
  let i = 0;
  while (i < s.length) {
    const eq = s.indexOf("=", i);
    if (eq < 0) throw new Error(`etichette non valide: ${line}`);
    const k = s.slice(i, eq).trim();
    if (!LABEL.test(k)) throw new Error(`nome di etichetta non valido "${k}": ${line}`);
    if (s[eq + 1] !== '"') throw new Error(`valore di etichetta senza virgolette: ${line}`);
    let j = eq + 2, v = "";
    for (; j < s.length && s[j] !== '"'; j++) {
      if (s[j] === "\\") { j++; v += s[j] === "n" ? "\n" : s[j]; } else v += s[j];
    }
    if (j >= s.length) throw new Error(`virgolette non chiuse: ${line}`);
    if (k in out) throw new Error(`etichetta ripetuta "${k}": ${line}`);
    out[k] = v;
    i = j + 1;
    if (s[i] === ",") i++;
    else if (i < s.length) throw new Error(`separatore mancante tra le etichette: ${line}`);
  }
  return out;
}

const familyOf = (name, families) => {
  for (const suf of ["_bucket", "_sum", "_count"]) {
    if (name.endsWith(suf)) {
      const base = name.slice(0, -suf.length);
      if (families.get(base)?.type === "histogram" || families.get(base)?.type === "summary") return base;
    }
  }
  return name;
};
const key = (labels) => JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));

/**
 * Legge l'esposizione e la controlla. Restituisce Map nome-famiglia -> { type, help, samples: [{ name, labels, value }] }.
 * Lancia un Error con la riga incriminata al primo problema.
 */
export function parsePrometheus(text) {
  if (!text.endsWith("\n")) throw new Error("l'esposizione deve finire con un a capo");
  const families = new Map();
  const seen = new Set();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("#")) {
      const m = line.match(/^# (HELP|TYPE) (\S+) ?(.*)$/);
      if (!m) continue; // commento libero
      if (!NAME.test(m[2])) throw new Error(`nome di metrica non valido: ${line}`);
      const f = families.get(m[2]) ?? { type: "untyped", help: "", samples: [] };
      if (m[1] === "TYPE") {
        if (!TYPES.has(m[3])) throw new Error(`tipo sconosciuto: ${line}`);
        if (f.samples.length) throw new Error(`TYPE dopo i campioni: ${line}`);
        f.type = m[3];
      } else f.help = m[3];
      families.set(m[2], f);
      continue;
    }
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)(?: (-?[0-9]+))?$/);
    if (!m) throw new Error(`riga non valida: ${line}`);
    const value = m[3] === "+Inf" ? Infinity : m[3] === "-Inf" ? -Infinity : m[3] === "NaN" ? NaN : Number(m[3]);
    if (!/^(?:[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|[+-]Inf|NaN)$/.test(m[3])) throw new Error(`valore non numerico: ${line}`);
    const labels = m[2] ? parseLabels(m[2], line) : {};
    const fam = familyOf(m[1], families);
    const f = families.get(fam);
    if (!f || f.type === "untyped") throw new Error(`campione senza TYPE: ${line}`);
    const id = m[1] + key(labels);
    if (seen.has(id)) throw new Error(`serie duplicata: ${line}`);
    seen.add(id);
    if (f.type === "counter" && !(value >= 0)) throw new Error(`contatore negativo: ${line}`);
    f.samples.push({ name: m[1], labels, value });
  }
  for (const [name, f] of families) if (f.type === "histogram") checkHistogram(name, f);
  return families;
}

function checkHistogram(name, f) {
  const groups = new Map();
  for (const s of f.samples) {
    const { le, ...rest } = s.labels;
    const k = key(rest);
    const g = groups.get(k) ?? { buckets: [], sum: null, count: null };
    if (s.name === name + "_bucket") {
      if (le === undefined) throw new Error(`${name}: bucket senza le`);
      g.buckets.push([le === "+Inf" ? Infinity : Number(le), s.value]);
    } else if (s.name === name + "_sum") g.sum = s.value;
    else if (s.name === name + "_count") g.count = s.value;
    else throw new Error(`${name}: campione inatteso ${s.name}`);
    groups.set(k, g);
  }
  for (const [k, g] of groups) {
    if (!g.buckets.length || g.buckets[g.buckets.length - 1][0] !== Infinity) throw new Error(`${name}${k}: manca il bucket +Inf (in fondo)`);
    for (let i = 1; i < g.buckets.length; i++) {
      if (!(g.buckets[i][0] > g.buckets[i - 1][0])) throw new Error(`${name}${k}: limiti dei bucket non crescenti`);
      if (g.buckets[i][1] < g.buckets[i - 1][1]) throw new Error(`${name}${k}: bucket non cumulativi`);
    }
    if (g.sum === null || g.count === null) throw new Error(`${name}${k}: mancano _sum o _count`);
    if (g.count !== g.buckets[g.buckets.length - 1][1]) throw new Error(`${name}${k}: _count diverso dal bucket +Inf`);
  }
}

const matches = (labels, want) => Object.entries(want).every(([k, v]) => labels[k] === v);

/** Somma dei campioni `name` (anche _bucket/_sum/_count) con le etichette indicate (le altre libere); 0 se nessuno. */
export function sample(families, name, want = {}) {
  let tot = 0;
  for (const f of families.values()) for (const s of f.samples) if (s.name === name && matches(s.labels, want)) tot += s.value;
  return tot;
}

/** Istogramma `family` con le etichette indicate: { buckets: {le: conteggio cumulativo}, sum, count }, sommando le serie. */
export function histogram(families, family, want = {}) {
  const buckets = {};
  for (const s of families.get(family)?.samples ?? []) {
    if (s.name !== family + "_bucket" || !matches(s.labels, want)) continue;
    buckets[s.labels.le] = (buckets[s.labels.le] ?? 0) + s.value;
  }
  return { buckets, sum: sample(families, family + "_sum", want), count: sample(families, family + "_count", want) };
}
