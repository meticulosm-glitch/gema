import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runEntrypoint } from "./shell";

const cfgOf = async (env: Record<string, string>) => {
  const r = await runEntrypoint("40-runtime-config.sh", { AUTH_ENABLED: "false", ...env });
  expect(r.code, r.stderr).toBe(0);
  return { cfg: JSON.parse(r.configJson ?? ""), out: r.stdout };
};

describe("config.json: USAGE_STATS", () => {
  it("di default anonymous", async () => expect((await cfgOf({})).cfg.usageStats).toBe("anonymous"));
  it.each(["off", "named", "NAMED", "Anonymous"])("%s accettato", async (v) => expect((await cfgOf({ USAGE_STATS: v })).cfg.usageStats).toBe(v.toLowerCase()));
  it("valore non valido: anonymous e avviso", async () => {
    const { cfg, out } = await cfgOf({ USAGE_STATS: "tutto" });
    expect(cfg.usageStats).toBe("anonymous");
    expect(out).toContain("USAGE_STATS ignorato");
  });
});

describe("nginx: ACCESS_LOG_FORMAT", () => {
  const logMap = async (env: Record<string, string>) => {
    const r = await runEntrypoint("35-proxy-config.sh", env);
    expect(r.code, r.stderr).toBe(0);
    return { map: r.logMap ?? "", out: r.stdout };
  };
  it("di default testo", async () => {
    expect((await logMap({})).map).toBe("map $host $mapp_log_text { default 1; }\nmap $host $mapp_log_json { default 0; }\n");
  });
  it("json per Loki", async () => {
    const { map, out } = await logMap({ ACCESS_LOG_FORMAT: "JSON" });
    expect(map).toContain("$mapp_log_json { default 1; }");
    expect(map).toContain("$mapp_log_text { default 0; }");
    expect(out).toContain("log delle richieste in JSON");
  });
  it("valore non valido: testo e avviso", async () => {
    const { map, out } = await logMap({ ACCESS_LOG_FORMAT: "xml" });
    expect(map).toContain("$mapp_log_text { default 1; }");
    expect(out).toContain("ACCESS_LOG_FORMAT ignorato");
  });
  it("default.conf: due access_log condizionati e il formato JSON senza header né token", () => {
    const conf = readFileSync(new URL("../nginx/default.conf", import.meta.url), "utf8");
    expect(conf).toContain("access_log /dev/stdout mapp if=$mapp_log_text;");
    expect(conf).toContain("access_log /dev/stdout mapp_json if=$mapp_log_json;");
    const json = conf.slice(conf.indexOf("log_format mapp_json"), conf.indexOf("';", conf.indexOf("log_format mapp_json")));
    expect(json).toContain("escape=json");
    for (const f of ['"layers":"$arg_layers$arg_layer"', '"request":"$arg_request"', '"status":$status']) expect(json).toContain(f);
    expect(json).not.toMatch(/http_authorization|cookie|\$args|\$request_uri|\$query_string/);
  });
});
