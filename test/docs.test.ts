// La documentazione resta allineata al codice: ogni variabile d'ambiente letta dagli script di avvio e ogni valore del
// chart sono descritti in charts/README.md; i link e le immagini dei README puntano a file che esistono.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const chartDoc = read("charts/README.md");

/** Variabili lette da uno script ma mai assegnate al suo interno: quindi arrivano dall'ambiente. */
export function envVarsOf(source: string): string[] {
  const script = source.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"); // i commenti non contano
  const used = new Set([...script.matchAll(/\$\{([A-Z][A-Z0-9_]*)[:}]/g)].map((m) => m[1]));
  const assigned = new Set([...script.matchAll(/(?:^|[\s;(])([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
  return [...used].filter((v) => !assigned.has(v)).sort();
}

describe("documentazione", () => {
  const scripts = readdirSync(join(ROOT, "docker-entrypoint.d")).filter((f) => f.endsWith(".sh"));

  it("envVarsOf distingue le variabili d'ambiente da quelle interne", () => {
    expect(envVarsOf('# ${NOTA:-x}\nA="${FOO:-1}"\nB=${A}\necho ${BAR:?x} ${B}')).toEqual(["BAR", "FOO"]);
  });

  it.each(scripts)("ogni variabile d'ambiente di %s è descritta in charts/README.md", (f) => {
    const vars = envVarsOf(read(`docker-entrypoint.d/${f}`));
    expect(vars.length).toBeGreaterThan(0);
    expect(vars.filter((v) => !chartDoc.includes("`" + v + "`"))).toEqual([]);
  });

  it("ogni valore di values.yaml è descritto (i gruppi tramite le loro chiavi, resources come blocco)", () => {
    const keys: string[] = [];
    const parents = new Set<string>();
    let parent = "";
    for (const line of read("charts/values.yaml").split("\n")) {
      const top = line.match(/^([a-zA-Z]\w*):/);
      if (top) { parent = top[1]; keys.push(parent); continue; }
      const sub = line.match(/^ {2}([a-zA-Z]\w*):/);
      if (sub && !["env", "resources"].includes(parent)) { parents.add(parent); keys.push(`${parent}.${sub[1]}`); }
    }
    expect(keys.length).toBeGreaterThan(20);
    expect(keys.filter((k) => !parents.has(k) && !chartDoc.includes("`" + k + "`"))).toEqual([]);
  });

  it.each(["README.md", "charts/README.md"])("%s: link e immagini relativi esistono", (doc) => {
    const text = read(doc);
    const base = dirname(join(ROOT, doc));
    const targets = [...text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)|src(?:set)?="([^"]+)"/g)].map((m) => m[1] ?? m[2]).filter((t) => !/^https?:/.test(t));
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter((t) => !existsSync(join(base, decodeURIComponent(t))))).toEqual([]);
  });
});
