// Esegue tutti gli scenari end-to-end: avvia il GeoServer/Keycloak/geocoder finto e lancia gli script uno dopo l'altro.
//
//   node e2e/run.mjs                 tutti gli scenari
//   node e2e/run.mjs e2e-search      solo quelli indicati (nome del file senza .mjs)
//
// Requisiti: build in dist/ (npm run build), nginx installato, Chromium di Playwright (npx playwright install chromium).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { E2E, MOCK, RUN, prepare, sleep } from "./lib.mjs";

const ALL = ["e2e", "e2e-access", "e2e-search", "e2e-download", "e2e-catalog", "e2e-roleview", "e2e-forms", "e2e-announce", "e2e-dashio", "e2e-widgets", "e2e-filters", "e2e-drafts", "e2e-viewas", "e2e-diag", "e2e-changes", "e2e-usage", "e2e-backup", "e2e-tiles", "e2e-vectortiles", "e2e-security", "e2e-metrics"];
const chosen = process.argv.slice(2).map((s) => s.replace(/\.mjs$/, ""));
const scenarios = chosen.length ? chosen : ALL;
for (const s of scenarios) if (!ALL.includes(s)) { console.error(`scenario sconosciuto: ${s} (disponibili: ${ALL.join(", ")})`); process.exit(2); }

prepare();
fs.mkdirSync(RUN, { recursive: true });
const mockLog = fs.openSync(path.join(RUN, "mock.log"), "w");
const mock = spawn(process.execPath, [path.join(E2E, "mock-gs.mjs")], { stdio: ["ignore", mockLog, mockLog], env: process.env });
const stopMock = () => { try { mock.kill(); } catch { /* già fermo */ } };
process.on("exit", stopMock);

async function waitMock() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(MOCK + "/__reset")).ok) return true; } catch { /* non ancora pronto */ }
    await sleep(100);
  }
  return false;
}

const run = (name) => new Promise((resolve) => {
  console.log(`\n######## ${name}`);
  const p = spawn(process.execPath, [path.join(E2E, `${name}.mjs`)], { stdio: "inherit", env: process.env });
  p.on("exit", (code) => resolve(code ?? 1));
});

if (!(await waitMock())) {
  console.error(`il server finto non risponde su ${MOCK}: vedi ${path.join(RUN, "mock.log")}`);
  process.exit(2);
}
const outcome = [];
for (const s of scenarios) outcome.push([s, await run(s)]);
stopMock();

console.log("\n######## riepilogo");
for (const [s, code] of outcome) console.log(`${code === 0 ? "OK  " : "KO  "} ${s}${code === 0 ? "" : ` (uscita ${code})`}`);
console.log(`\nScreenshot e log in ${RUN}`);
process.exit(outcome.some(([, c]) => c !== 0) ? 1 : 0);
