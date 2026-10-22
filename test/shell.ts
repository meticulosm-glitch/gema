import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ScriptResult {
  code: number;
  stdout: string;
  stderr: string;
  proxyConf: string | null;
  authMap: string | null;
  geocodeMap: string | null;
  logMap: string | null;
  tilesMap: string | null;
  rateMap: string | null;
  securityInc: string | null;
  securityMap: string | null;
  securityConf: string | null;
  metricsMain: string | null;
  metricsMap: string | null;
  metricsInc: string | null;
  metricsConf: string | null;
  configJson: string | null;
}

/** Esegue uno script di entrypoint con i path di sistema riscritti su una dir temporanea. */
export async function runEntrypoint(
  scriptName: string,
  env: Record<string, string> = {},
  opts: { preexistingConfig?: string; njsModule?: boolean } = {},
): Promise<ScriptResult> {
  const dir = await mkdtemp(join(tmpdir(), "mapp-entrypoint-"));
  const proxyDir = join(dir, "proxy.d");
  const htmlDir = join(dir, "html");
  await mkdir(proxyDir);
  await mkdir(htmlDir);
  const confPath = join(htmlDir, "config.json");
  if (opts.preexistingConfig !== undefined) await writeFile(confPath, opts.preexistingConfig);

  const srcPath = new URL(`../docker-entrypoint.d/${scriptName}`, import.meta.url);
  let src = await readFile(srcPath, "utf8");
  src = src.replace("DIR=/etc/nginx/proxy.d", `DIR=${proxyDir}`);
  src = src.replace("CONF=/usr/share/nginx/html/config.json", `CONF=${confPath}`);
  // modulo njs e script delle metriche: file finti, presenti salvo njsModule: false (come in un nginx senza njs)
  const njsModule = join(dir, "ngx_http_js_module.so");
  if (opts.njsModule !== false) await writeFile(njsModule, "");
  src = src.replace("MODULE=/etc/nginx/modules/ngx_http_js_module.so", `MODULE=${njsModule}`);
  src = src.replace("NJS=/etc/nginx/njs/metrics.js", `NJS=${new URL("../nginx/metrics.js", import.meta.url).pathname}`);
  const scriptPath = join(dir, "run.sh");
  await writeFile(scriptPath, src, { mode: 0o755 });

  const clean: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir };
  let code = 0;
  let stdout = "";
  let stderr = "";
  try {
    const out = await execFileAsync("sh", [scriptPath], { env: { ...clean, ...env } });
    stdout = out.stdout;
    stderr = out.stderr;
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    code = typeof err.code === "number" ? err.code : 1;
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
  }

  const read = async (p: string) => {
    try {
      return await readFile(p, "utf8");
    } catch {
      return null;
    }
  };
  const result: ScriptResult = {
    code,
    stdout,
    stderr,
    proxyConf: await read(join(proxyDir, "proxy.conf")),
    authMap: await read(join(proxyDir, "auth.map")),
    geocodeMap: await read(join(proxyDir, "geocode.map")),
    logMap: await read(join(proxyDir, "log.map")),
    tilesMap: await read(join(proxyDir, "tiles.map")),
    rateMap: await read(join(proxyDir, "rate.map")),
    securityInc: await read(join(proxyDir, "security.inc")),
    securityMap: await read(join(proxyDir, "security.map")),
    securityConf: await read(join(proxyDir, "security.conf")),
    metricsMain: await read(join(proxyDir, "metrics.main")),
    metricsMap: await read(join(proxyDir, "metrics.map")),
    metricsInc: await read(join(proxyDir, "metrics.inc")),
    metricsConf: await read(join(proxyDir, "metrics.conf")),
    configJson: await read(confPath),
  };
  await rm(dir, { recursive: true, force: true });
  return result;
}
