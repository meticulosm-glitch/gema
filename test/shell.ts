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
  configJson: string | null;
}

/** Esegue uno script di entrypoint con i path di sistema riscritti su una dir temporanea. */
export async function runEntrypoint(
  scriptName: string,
  env: Record<string, string> = {},
  opts: { preexistingConfig?: string } = {},
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
    configJson: await read(confPath),
  };
  await rm(dir, { recursive: true, force: true });
  return result;
}
