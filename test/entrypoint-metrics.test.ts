// 50-metrics-config.sh: file generati per nginx (modulo njs, zona condivisa, server delle metriche, riga di log che registra
// le richieste) con i default e con METRICS, METRICS_PORT, modulo mancante. Il chart Helm: porta separata, mai nella rotta
// APISIX, ServiceMonitor e annotazioni facoltativi.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { runEntrypoint } from "./shell";

const run = (env: Record<string, string> = {}, njsModule = true) => runEntrypoint("50-metrics-config.sh", env, { njsModule });
const notFound = "location = /metrics {\n  access_log off;\n  return 404;\n}\n";

describe("50-metrics-config.sh", () => {
  it("default: modulo njs caricato, zona condivisa, server su :9145 (solo GET /metrics, stub_status, resto 404), log che registra", async () => {
    const r = await run();
    expect(r.code, r.stderr).toBe(0);
    expect(r.metricsMain).toMatch(/^load_module \S+ngx_http_js_module\.so;\n$/);
    const http = r.metricsMap ?? "";
    expect(http).toMatch(/js_import gema_metrics from \S+\/nginx\/metrics\.js;/);
    expect(http).toContain("js_shared_dict_zone zone=gema_metrics:4m type=number;");
    expect(http).toContain("js_set $gema_metrics_record gema_metrics.record;");
    expect(http).toContain("log_format gema_metrics '-';");
    expect(http).toMatch(/server \{\n {2}listen 9145;\n {2}server_name _;\n {2}access_log off;/);
    expect(http).toMatch(/location = \/metrics \{\s+limit_except GET \{ deny all; \}\s+js_fetch_timeout 2s;\s+js_content gema_metrics\.render;\s+\}/);
    expect(http).toMatch(/location = \/stub_status \{\s+stub_status;\s+\}/);
    expect(http).toMatch(/location \/ \{\s+return 404;\s+\}/);
    expect(r.metricsInc).toBe("access_log /dev/null gema_metrics if=$gema_metrics_record;\n");
    expect(r.metricsConf).toBe(notFound); // sulla porta dell'app /metrics non c'è
    expect(r.stdout).toContain("metriche Prometheus su :9145/metrics");
  });

  it("METRICS_PORT: porta o indirizzo:porta; non valida o uguale a quella dell'app: 9145 e avviso", async () => {
    expect((await run({ METRICS_PORT: "9200" })).metricsMap).toContain("listen 9200;");
    expect((await run({ METRICS_PORT: "127.0.0.1:19145" })).metricsMap).toContain("listen 127.0.0.1:19145;");
    for (const bad of ["metriche", "0", "70000", ":9145", "9145; include /etc/passwd", "9145\ninclude /etc/passwd;", "localhost:9145"]) {
      const r = await run({ METRICS_PORT: bad });
      expect([bad, r.code]).toEqual([bad, 0]);
      expect(r.metricsMap).toContain("listen 9145;");
      expect(r.stdout).toContain("METRICS_PORT ignorata");
    }
    const app = await run({ METRICS_PORT: "8080" });
    expect(app.metricsMap).toContain("listen 9145;");
    expect(app.stdout).toContain("8080 è la porta dell'app");
  });

  it.each(["false", "FALSE", "0", "no", "off"])("METRICS=%s: nessun modulo, server o registrazione; /metrics resta 404", async (v) => {
    const r = await run({ METRICS: v });
    expect(r.code, r.stderr).toBe(0);
    expect([r.metricsMain, r.metricsMap, r.metricsInc]).toEqual(["", "", ""]);
    expect(r.metricsConf).toBe(notFound);
    expect(r.stdout).toContain("metriche spente (METRICS=false)");
  });

  it("senza il modulo njs: metriche spente con avviso, nginx parte lo stesso", async () => {
    const r = await run({}, false);
    expect(r.code, r.stderr).toBe(0);
    expect([r.metricsMain, r.metricsMap, r.metricsInc]).toEqual(["", "", ""]);
    expect(r.stdout).toContain("modulo njs di nginx non trovato");
  });

  it("nginx/default.conf include la registrazione nel server dell'app, dopo i log delle richieste", () => {
    const conf = readFileSync(new URL("../nginx/default.conf", import.meta.url), "utf8");
    const server = conf.slice(conf.indexOf("server {"));
    expect(server.indexOf("include /etc/nginx/proxy.d/metrics.inc;")).toBeGreaterThan(server.indexOf("access_log /dev/stdout mapp_json"));
    expect(conf.indexOf("include /etc/nginx/proxy.d/*.map;")).toBeLessThan(conf.indexOf("server {")); // server delle metriche a livello http
  });

  it("Dockerfile: modulo caricabile (verificato in build), script delle metriche e modulo njs copiati, porta esposta", () => {
    const df = readFileSync(new URL("../docker/Dockerfile", import.meta.url), "utf8");
    expect(df).toContain("sed -i '1i include /etc/nginx/proxy.d/*.main;' /etc/nginx/nginx.conf");
    expect(df).toContain("nginx -t -c /tmp/njs-check.conf");
    expect(df).toContain("COPY nginx/metrics.js /etc/nginx/njs/metrics.js");
    expect(df).toContain("COPY docker-entrypoint.d/50-metrics-config.sh /docker-entrypoint.d/50-metrics-config.sh");
    expect(df).toMatch(/chmod \+x [^\n]*50-metrics-config\.sh/);
    expect(df).toMatch(/EXPOSE 8080 9145/);
    // i percorsi usati dallo script sono quelli dell'immagine
    const sh = readFileSync(new URL("../docker-entrypoint.d/50-metrics-config.sh", import.meta.url), "utf8");
    expect(sh).toContain("MODULE=/etc/nginx/modules/ngx_http_js_module.so");
    expect(sh).toContain("NJS=/etc/nginx/njs/metrics.js");
  });
});

describe("chart Helm: metriche", () => {
  const tpl = (f: string) => readFileSync(new URL(`../charts/templates/${f}`, import.meta.url), "utf8");
  const values = parse(readFileSync(new URL("../charts/values.yaml", import.meta.url), "utf8"));

  it("values: attive sulla porta 9145; ServiceMonitor e annotazioni spenti di default", () => {
    expect(values.metrics).toEqual({ enabled: true, port: 9145, podAnnotations: false, serviceMonitor: { enabled: false, interval: "30s", scrapeTimeout: "10s", labels: {} } });
  });

  it("Deployment: porta metrics e variabili METRICS / METRICS_PORT dai values (env ed extraEnv vincono), annotazioni facoltative", () => {
    const d = tpl("deployment.yaml");
    expect(d).toMatch(/\{\{- if \.Values\.metrics\.enabled \}\}\s+- name: metrics\s+containerPort: \{\{ \.Values\.metrics\.port \}\}/);
    const setMetrics = d.indexOf('set $envVars "METRICS"');
    expect(setMetrics).toBeGreaterThan(0);
    expect(setMetrics).toBeLessThan(d.indexOf("range .Values.env"));
    expect(d).toContain('set $envVars "METRICS_PORT"');
    expect(d).toMatch(/if and \.Values\.metrics\.enabled \.Values\.metrics\.podAnnotations \}\}\s+annotations:\s+prometheus\.io\/scrape: "true"\s+prometheus\.io\/port: \{\{ \.Values\.metrics\.port \| quote \}\}\s+prometheus\.io\/path: \/metrics/);
  });

  it("Service: porta metrics verso nginx anche con oauth2-proxy; la rotta APISIX usa solo la porta dell'app", () => {
    const s = tpl("service.yaml");
    expect(s).toMatch(/\{\{- if \.Values\.metrics\.enabled \}\}\s+#[^\n]*\n\s+- name: metrics\s+port: \{\{ \.Values\.metrics\.port \}\}\s+targetPort: metrics/);
    const route = tpl("apisixroute.yaml");
    expect(route).toContain("servicePort: {{ .Values.service.port }}");
    expect(route).not.toContain("metrics");
  });

  it("ServiceMonitor: solo con metrics.enabled e serviceMonitor.enabled, porta metrics, stesse etichette del Service", () => {
    const sm = tpl("servicemonitor.yaml");
    expect(sm.startsWith("{{- if and .Values.metrics.enabled .Values.metrics.serviceMonitor.enabled }}")).toBe(true);
    expect(sm).toContain("kind: ServiceMonitor");
    expect(sm).toMatch(/selector:\s+matchLabels:\s+\{\{- include "geolibre\.selectorLabels" \. \| nindent 6 \}\}/);
    expect(sm).toMatch(/- port: metrics\s+path: \/metrics/);
    expect(sm).toContain("{{- with .Values.metrics.serviceMonitor.labels }}");
  });
});
