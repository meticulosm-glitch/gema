import type { TimeInfo } from "./capabilities";

/** Oltre questo numero di istanti un intervallo non viene espanso (slider e serie restano disattivati). */
export const MAX_STEPS = 2000;

const DAY = 86_400_000;
const DUR = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** Durata ISO 8601 -> mesi interi oppure millisecondi; null se non supportata o nulla. */
export function parsePeriod(p: string): { months: number; ms: number } | null {
  const m = DUR.exec(p.trim());
  if (!m || p.trim() === "P" || p.trim().endsWith("T")) return null;
  const n = (i: number) => (m[i] ? Number(m[i]) : 0);
  const months = n(1) * 12 + n(2);
  const ms = n(3) * 7 * DAY + n(4) * DAY + n(5) * 3_600_000 + n(6) * 60_000 + n(7) * 1000;
  if ((months > 0 && ms > 0) || (months === 0 && ms === 0)) return null; // miste o nulle: non espandibili
  return { months, ms };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Formatta un istante nello stile dell'estremo iniziale (solo anno, solo data, oppure ISO completo). */
function fmt(t: number, like: string, months: number): string {
  const d = new Date(t);
  if (/^\d{4}$/.test(like) && months % 12 === 0) return pad(d.getUTCFullYear(), 4);
  if (/^\d{4}-\d{2}-\d{2}$/.test(like)) return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return d.toISOString();
}

/** Espande "inizio/fine/periodo" in istanti discreti; null se non è possibile o sono troppi. */
export function expandRange(part: string): string[] | null {
  const [a, b, per] = part.split("/").map((x) => x.trim());
  if (!a || !b || !per) return null;
  const dur = parsePeriod(per);
  const t0 = Date.parse(a);
  const t1 = Date.parse(b);
  if (!dur || !Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0) return null;
  const out: string[] = [];
  const start = new Date(t0);
  for (let k = 0; out.length <= MAX_STEPS; k++) {
    const t = dur.months
      ? Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + k * dur.months, start.getUTCDate(), start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds())
      : t0 + k * dur.ms;
    if (t > t1) break;
    out.push(fmt(t, a, dur.months));
  }
  return out.length > MAX_STEPS ? null : out;
}

/**
 * Istanti disponibili di un layer, in ordine cronologico.
 * Elenchi discreti: usati così come sono; intervalli con periodo (es. 2026-01-01/2026-12-31/P1D): espansi.
 * Elenco vuoto se non si riesce a enumerarli (allora resta il campo libero).
 */
export function timeSteps(info?: TimeInfo): string[] {
  if (!info) return [];
  let steps: string[];
  if (info.values) {
    steps = info.values.slice().reverse(); // capabilities.ts le tiene dalla più recente
  } else {
    steps = [];
    for (const part of info.extent.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (part.includes("/")) {
        const ex = expandRange(part);
        if (!ex) return [];
        steps.push(...ex);
      } else steps.push(part);
      if (steps.length > MAX_STEPS) return [];
    }
  }
  const ms = steps.map((s) => Date.parse(s));
  if (ms.every(Number.isFinite)) {
    return steps.map((s, i) => ({ s, t: ms[i] })).sort((x, y) => x.t - y.t).map((x) => x.s);
  }
  return steps;
}

/** Posizione di `value` tra gli istanti; vuoto = predefinito del layer, altrimenti l'ultimo. -1 se non corrisponde a nessuno. */
export function stepIndex(steps: string[], value: string, def?: string): number {
  if (steps.length === 0) return -1;
  const v = value.trim() || def?.trim() || "";
  if (!v) return steps.length - 1;
  const exact = steps.indexOf(v);
  if (exact >= 0) return exact;
  const t = Date.parse(v);
  if (!Number.isFinite(t) || v.includes("/")) return -1;
  let best = -1;
  let bestD = Infinity;
  steps.forEach((s, i) => {
    const d = Math.abs(Date.parse(s) - t);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

/** Al massimo `max` istanti, equidistanti per posizione, compresi il primo e l'ultimo. */
export function sampleSteps(steps: string[], max: number): string[] {
  if (steps.length <= max || max < 2) return steps.length <= max ? steps : steps.slice(0, 1);
  const out: string[] = [];
  for (let i = 0; i < max; i++) out.push(steps[Math.round((i * (steps.length - 1)) / (max - 1))]);
  return out;
}

/** Etichetta breve: toglie la parte oraria se è mezzanotte. */
export function shortTime(s: string): string {
  return s.replace(/T00:00:00(?:\.0+)?Z$/, "");
}
