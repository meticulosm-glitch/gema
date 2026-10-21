// Chart Helm: controlli statici sui template (sempre) e, se helm è installato, il chart reso con i values degli ambienti
// e con le combinazioni principali (oauth2-proxy, override dei ruoli e del workspace). HELM_BIN sceglie l'eseguibile.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, parseAllDocuments } from "yaml";

const CHART = resolve(dirname(fileURLToPath(import.meta.url)), "../charts");
const tpl = (p: string) => readFileSync(join(CHART, "templates", p), "utf8");
const values = parse(readFileSync(join(CHART, "values.yaml"), "utf8"));
const envOf = (list: { name: string; value: string }[] = []) => Object.fromEntries(list.map((e) => [e.name, e.value]));

describe("chart: controlli statici", () => {
  it("l'app legge GeoServer con un utente di sola lettura, non con l'amministratore del Job", () => {
    const app = (values.eso.secrets as (string | { key: string; property?: string })[]).map((s) => (typeof s === "string" ? { key: s, property: s } : { key: s.key, property: s.property ?? s.key }));
    const jobAdmin = [...tpl("geoserver-configuration/external-secret.yaml").matchAll(/property: (GEOSERVER_\w+)/g)].map((m) => m[1]);
    expect(jobAdmin).toEqual(["GEOSERVER_USER", "GEOSERVER_PASSWORD"]);
    for (const k of ["GEOSERVER_USER", "GEOSERVER_PASSWORD"]) {
      const s = app.find((x) => x.key === k);
      expect(s, k).toBeDefined();
      expect(jobAdmin).not.toContain(s!.property);
    }
    expect(app.map((s) => s.key)).not.toContain("OIDC_CLIENT_SECRET"); // i segreti di oauth2-proxy non arrivano a nginx
    expect(app.map((s) => s.key)).not.toContain("OAUTH2_PROXY_COOKIE_SECRET");
  });

  it("con il controllo accessi le scritture passano con il token dell'utente", () => {
    const env = envOf(values.env);
    expect(env.ACCESS_CONTROL).toBe("true");
    expect(env.GEOSERVER_WRITE_PASSTHROUGH).toBe("true");
  });

  it("porte: nginx su 8080, oauth2-proxy inoltra a 8080, il Service passa da oauth2-proxy quando è attivo", () => {
    const dep = tpl("deployment.yaml");
    expect(dep).toMatch(/containerPort: 8080/);
    expect(dep).not.toMatch(/containerPort: 80\b/);
    expect(dep).toContain("--upstream=http://127.0.0.1:8080");
    expect(dep).toMatch(/--redirect-url=https:\/\//);
    expect(dep).toMatch(/required "auth\.issuerUrl/);
    expect(tpl("service.yaml")).toMatch(/targetPort: \{\{ if \.Values\.auth\.enabled \}\}4180\{\{ else \}\}\{\{ \.Values\.service\.targetPort \}\}\{\{ end \}\}/);
    expect(values.service.targetPort).toBe(8080);
    expect("issuerUrl" in values.auth).toBe(true);
  });

  it("nessun nome fisso: Job, ConfigMap e secret del Job dipendono dal rilascio", () => {
    for (const f of readdirSync(join(CHART, "templates/geoserver-configuration")))
      expect(tpl(`geoserver-configuration/${f}`).replaceAll("mapp-config.sql", ""), f).not.toMatch(/name: mapp-config|app\.kubernetes\.io\/name: mapp-web/);
    expect(tpl("geoserver-configuration/job.yaml")).not.toContain("mapp-enterprise-lot1-geoserver");
    expect(tpl("geoserver-configuration/job.yaml")).not.toMatch(/ROLE_FSS-ETL/);
    expect(values.image.repository).not.toContain("registy");
  });
});

// ---------------------------------------------------------------- reso con helm
const HELM = process.env.HELM_BIN || "helm";
const hasHelm = spawnSync(HELM, ["version"], { encoding: "utf8" }).status === 0;
type Doc = { kind: string; metadata: { name: string; labels?: Record<string, string> }; spec: any };

function render(extra: object = {}, envFile = "environments/dev/values.yaml"): { docs: Doc[]; code: number; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "gema-chart-"));
  try {
    const over = join(dir, "over.yaml");
    writeFileSync(over, JSON.stringify(extra));
    const r = spawnSync(HELM, ["template", "gema", CHART, "-f", join(CHART, envFile), "-f", over, "--namespace", "gema"], { encoding: "utf8" });
    const docs = r.status === 0 ? parseAllDocuments(r.stdout).map((d) => d.toJS()).filter(Boolean) : [];
    return { docs, code: r.status ?? 1, err: r.stderr };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const one = (docs: Doc[], kind: string, name?: string) => docs.find((d) => d.kind === kind && (!name || d.metadata.name === name))!;
const jobEnv = (docs: Doc[]) => Object.fromEntries(one(docs, "Job").spec.template.spec.containers.flatMap((c: any) => c.env).map((e: any) => [e.name, e.value ?? e.valueFrom]));

describe.skipIf(!hasHelm)("chart reso con helm", () => {
  it.each(readdirSync(join(CHART, "environments")))("ambiente %s: lint e template senza errori", (envName) => {
    const lint = spawnSync(HELM, ["lint", CHART, "-f", join(CHART, "environments", envName, "values.yaml")], { encoding: "utf8" });
    expect(lint.status, lint.stdout + lint.stderr).toBe(0);
    const { docs, code, err } = render({}, `environments/${envName}/values.yaml`);
    expect(code, err).toBe(0);
    expect(docs.map((d) => d.kind).sort()).toEqual(["ApisixRoute", "ConfigMap", "Deployment", "ExternalSecret", "ExternalSecret", "ExternalSecret", "Job", "Service"]);
  });

  it("default: nginx su 8080 senza sidecar, Service verso 8080, nomi del Job legati al rilascio, regole dai ruoli dell'app", () => {
    const { docs } = render();
    const dep = one(docs, "Deployment");
    expect(dep.spec.template.spec.containers).toHaveLength(1);
    expect(dep.spec.template.spec.containers[0].ports).toEqual([{ name: "http", containerPort: 8080 }]);
    expect(one(docs, "Service").spec.ports[0].targetPort).toBe(8080);
    const job = one(docs, "Job");
    expect(job.metadata.name).toBe("gema-geolibre-config-init");
    expect(job.spec.template.metadata.labels["app.kubernetes.io/name"]).not.toBe(dep.spec.selector.matchLabels["app.kubernetes.io/name"]); // il Service non seleziona i pod del Job
    expect(job.spec.template.spec.volumes.find((v: any) => v.name === "scripts").configMap.name).toBe(one(docs, "ConfigMap").metadata.name);
    const secrets = docs.filter((d) => d.kind === "ExternalSecret").map((d) => d.metadata.name);
    expect(secrets).toEqual(expect.arrayContaining(["gema-geolibre-config-db", "gema-geolibre-config-geoserver"]));
    const env = jobEnv(docs);
    const app = envOf(dep.spec.template.spec.containers[0].env);
    expect(env.ACL_READ_ROLES).toBe(`ROLE_${app.VIEWER_ROLE.toUpperCase()},ROLE_${app.ADMIN_ROLE.toUpperCase()}`); // KNOWN_ROLES = viewer: nessun doppione
    expect(env.ACL_WRITE_ROLES).toBe(`ROLE_${app.ADMIN_ROLE.toUpperCase()}`);
    expect(env.CONFIG_WORKSPACE).toBe(app.CONFIG_WORKSPACE);
    expect(env.GEOSERVER_URL).toBe(values.configJob.geoserverUrl);
    expect("ACL_VIEWS_WRITE_ROLES" in env).toBe(false);
  });

  it("oauth2-proxy: issuer obbligatorio; con l'issuer il Service passa dal login e il proxy inoltra a nginx", () => {
    const missing = render({ auth: { enabled: true } });
    expect(missing.code).not.toBe(0);
    expect(missing.err).toContain("auth.issuerUrl");
    const { docs } = render({ auth: { enabled: true, issuerUrl: "https://auth.example.it/realms/r" } });
    const proxy = one(docs, "Deployment").spec.template.spec.containers[1];
    expect(proxy.args).toEqual(expect.arrayContaining(["--oidc-issuer-url=https://auth.example.it/realms/r", "--upstream=http://127.0.0.1:8080", "--redirect-url=https://gema.example.it/oauth2/callback"]));
    expect(one(docs, "Service").spec.ports[0].targetPort).toBe(4180);
    const oidc = one(docs, "ExternalSecret", values.auth.existingSecret);
    expect(oidc.spec.data.map((d: any) => d.secretKey)).toEqual(["OIDC_CLIENT_SECRET", "OAUTH2_PROXY_COOKIE_SECRET"]);
    expect(render({ auth: { enabled: true, issuerUrl: "https://x/realms/r", createSecret: false } }).docs.some((d) => d.metadata.name === values.auth.existingSecret)).toBe(false);
  });

  it("override: ruoli espliciti, workspace in extraEnv vale anche per il Job, secret dell'app come stringhe", () => {
    const { docs } = render({
      configJob: { aclReadRoles: "ROLE_A,ROLE_B", aclViewsWriteRoles: "ROLE_X" },
      extraEnv: [{ name: "KEYCLOAK_URL", value: "https://auth.example.it" }, { name: "CONFIG_WORKSPACE", value: "ws2" }, { name: "ADMIN_ROLE", value: "capo" }],
      eso: { secrets: ["GEOSERVER_USER", { key: "GEOSERVER_PASSWORD", property: "LETTORE_PWD" }] },
    });
    const env = jobEnv(docs);
    expect([env.ACL_READ_ROLES, env.ACL_WRITE_ROLES, env.ACL_VIEWS_WRITE_ROLES, env.CONFIG_WORKSPACE]).toEqual(["ROLE_A,ROLE_B", "ROLE_CAPO", "ROLE_X", "ws2"]);
    expect(one(docs, "ExternalSecret", values.eso.existingSecret).spec.data.map((d: any) => [d.secretKey, d.remoteRef.property])).toEqual([["GEOSERVER_USER", "GEOSERVER_USER"], ["GEOSERVER_PASSWORD", "LETTORE_PWD"]]);
  });
});
