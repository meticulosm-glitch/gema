import type Keycloak from "keycloak-js";
import type { AccessConfig, AppConfig } from "./config";
import { describeTableFresh, getWfsFeatures, wfsTransaction } from "./api";
import { CONFIG_COLUMNS, CONFIG_TABLES, RULES_TABLE, isMissingTable } from "./configStore";
import { resolveBasemaps } from "./basemaps";

/**
 * Pagina di diagnostica: controlli fatti dal browser dell'amministratore, con lo stesso token e lo stesso proxy
 * dell'applicazione. Ogni controllo dice cosa ha visto e, se qualcosa non va, dove intervenire.
 */
export type CheckStatus = "ok" | "warn" | "fail" | "info" | "skip";
export interface CheckResult { id: string; group: string; label: string; status: CheckStatus; detail: string; hint?: string; ms?: number }

export interface DiagContext {
  cfg: AppConfig;
  acc: AccessConfig;
  gs: string;                  // URL assoluto del proxy GeoServer
  kc: Keycloak;
  origin: string;              // origine della pagina (window.location.origin)
  now?: () => number;
  loadImage?: (url: string) => Promise<void>;
  timeoutMs?: number;
}

export const GROUPS = ["Configurazione", "GeoServer", "Tabelle di configurazione", "Keycloak e token", "Sfondi"] as const;
export const STATUS_LABEL: Record<CheckStatus, string> = { ok: "OK", warn: "Attenzione", fail: "Errore", info: "Info", skip: "Saltato" };

const msg = (e: unknown) => String((e as Error)?.message ?? e);
const auth = (kc: Keycloak): Record<string, string> => (kc.token ? { Authorization: `Bearer ${kc.token}` } : {});

/** Esegue `fn` con un tempo massimo; il risultato porta la durata. */
async function timed<T>(fn: () => Promise<T>, timeoutMs: number): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`nessuna risposta in ${Math.round(timeoutMs / 1000)} s`)), timeoutMs); });
  try { return { value: await Promise.race([fn(), timeout]), ms: Math.round(performance.now() - t0) }; }
  finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------- configurazione
export function configSummary(ctx: DiagContext): CheckResult {
  const { cfg, acc } = ctx;
  const kcCfg = cfg.keycloak;
  const lines = [
    `GeoServer: ${ctx.gs}`,
    kcCfg ? `Keycloak: ${kcCfg.url} · realm ${kcCfg.realm} · client ${kcCfg.clientId}` : "Keycloak: non configurato",
    `Workspace delle tabelle: ${acc.workspace}`,
    `Ruoli: amministratore ${acc.adminRole}, visualizzatore ${acc.viewerRole}, letti dal client ${acc.rolesClient}`,
    `Ruoli proposti: ${acc.knownRoles.length ? acc.knownRoles.join(", ") : "nessuno"}`,
    `Sfondi: ${resolveBasemaps(cfg).length}; ricerca luoghi: ${cfg.geocoder ? cfg.geocoder.type : "spenta"}; modifica: ${cfg.editEnabled ? "attiva" : "spenta"}`,
  ];
  return { id: "config", group: "Configurazione", label: "Configurazione letta da config.json", status: "info", detail: lines.join("\n") };
}

// ---------------------------------------------------------------- GeoServer
export async function checkGeoServer(ctx: DiagContext): Promise<CheckResult[]> {
  const t = ctx.timeoutMs ?? 10_000;
  const caps = async (service: "WFS" | "WMS", version: string, count: RegExp) => {
    const r = await fetch(`${ctx.gs}/ows?service=${service}&version=${version}&request=GetCapabilities`, { headers: auth(ctx.kc) });
    const body = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (/ServiceException|ExceptionReport/.test(body)) throw new Error("GeoServer ha risposto con un'eccezione");
    return (body.match(count) ?? []).length;
  };
  const one = async (service: "WFS" | "WMS", version: string, count: RegExp, what: string): Promise<CheckResult> => {
    const base = { id: `gs-${service.toLowerCase()}`, group: "GeoServer", label: `${service} GetCapabilities` };
    try {
      const { value, ms } = await timed(() => caps(service, version, count), t);
      return { ...base, status: value > 0 ? "ok" : "warn", ms, detail: `${value} ${what} visibili con il tuo token`, ...(value > 0 ? {} : { hint: "Nessun layer: controlla le regole dati di GeoServer per i tuoi ruoli." }) };
    } catch (e) {
      return { ...base, status: "fail", detail: msg(e), hint: "Controlla GEOSERVER_PROXY_URL nel deployment e che GeoServer sia avviato; con 401/403 controlla l'autenticazione OIDC di GeoServer." };
    }
  };
  return Promise.all([one("WMS", "1.3.0", /<Layer\b[^>]*queryable/g, "layer WMS"), one("WFS", "1.0.0", /<FeatureType\b/g, "tipi WFS")]);
}

// ---------------------------------------------------------------- tabelle di configurazione
export async function checkTable(ctx: DiagContext, table: string): Promise<CheckResult> {
  const name = `${ctx.acc.workspace}:${table}`;
  const base = { id: `table-${table}`, group: "Tabelle di configurazione", label: name };
  const t = ctx.timeoutMs ?? 10_000;
  try {
    const { value: schema, ms } = await timed(() => describeTableFresh(ctx.gs, ctx.kc, name), t);
    const have = new Set(schema.fields.map((f) => f.name));
    const missing = (CONFIG_COLUMNS[table] ?? []).filter((c) => !have.has(c));
    try { await timed(() => getWfsFeatures(ctx.gs, ctx.kc, name, "", 1), t); }
    catch (e) { return { ...base, status: "fail", ms, detail: `Pubblicata ma non leggibile: ${msg(e)}`, hint: "Regole dati di GeoServer: la lettura va concessa ai ruoli applicativi (SET_ACL nel Job)." }; }
    if (missing.length) return { ...base, status: "warn", ms, detail: `Colonne mancanti: ${missing.join(", ")}`, hint: "Riesegui il Job di configurazione; se la tabella esisteva già, ricarica il tipo in GeoServer (Layer → Ricarica attributi) per vedere le colonne nuove." };
    return { ...base, status: "ok", ms, detail: `${schema.fields.length} colonne, lettura consentita` };
  } catch (e) {
    return isMissingTable(e)
      ? { ...base, status: "fail", detail: "Non pubblicata in GeoServer.", hint: "Riesegui il Job di configurazione (mapp-config.sql e publish-geoserver.sh). Finché manca, la funzione che la usa resta spenta." }
      : { ...base, status: "fail", detail: msg(e), hint: "Controlla che il workspace esista e che il datastore raggiunga PostgreSQL." };
  }
}

/** Prova di scrittura che non cambia nulla: un Update con un filtro che non trova righe. */
export function writeProbe(prefix: string, ns: string, typeName: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><wfs:Transaction service="WFS" version="1.0.0" xmlns:wfs="http://www.opengis.net/wfs" xmlns:ogc="http://www.opengis.net/ogc" xmlns:${prefix}="${ns.replace(/"/g, "&quot;")}">` +
    `<wfs:Update typeName="${prefix}:${typeName}"><wfs:Property><wfs:Name>updated_by</wfs:Name><wfs:Value>diagnostica</wfs:Value></wfs:Property>` +
    `<ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>role</ogc:PropertyName><ogc:Literal>__gema_diagnostica__</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter></wfs:Update></wfs:Transaction>`;
}

export async function checkWrite(ctx: DiagContext): Promise<CheckResult> {
  const name = `${ctx.acc.workspace}:${RULES_TABLE}`;
  const base = { id: "write", group: "Tabelle di configurazione", label: "Scrittura (WFS-T)" };
  try {
    const { ms } = await timed(async () => {
      const s = await describeTableFresh(ctx.gs, ctx.kc, name);
      await wfsTransaction(ctx.gs, ctx.kc, writeProbe(s.prefix, s.ns, s.typeName));
    }, ctx.timeoutMs ?? 10_000);
    return { ...base, status: "ok", ms, detail: `Transazione di prova su ${name} accettata (nessuna riga cambiata).` };
  } catch (e) {
    return { ...base, status: "fail", detail: msg(e), hint: "Servono GEOSERVER_WRITE_PASSTHROUGH (o le credenziali di scrittura del proxy) e la regola dati di scrittura per il ruolo amministratore (ACL_WRITE_ROLES nel Job)." };
  }
}

// ---------------------------------------------------------------- Keycloak e token
export function checkToken(ctx: DiagContext): CheckResult[] {
  const t = (ctx.kc.tokenParsed ?? {}) as Record<string, any>;
  const now = (ctx.now ?? Date.now)();
  const clientRoles: string[] = t.resource_access?.[ctx.acc.rolesClient]?.roles ?? [];
  const realmRoles: string[] = t.realm_access?.roles ?? [];
  const otherClients = Object.keys(t.resource_access ?? {}).filter((c) => c !== ctx.acc.rolesClient);
  const out: CheckResult[] = [];
  const roles: CheckResult = {
    id: "token-roles", group: "Keycloak e token", label: "Ruoli nel token",
    status: clientRoles.includes(ctx.acc.adminRole) || realmRoles.includes(ctx.acc.adminRole) ? "ok" : "warn",
    detail: [`Utente: ${t.preferred_username ?? t.sub ?? "?"}`, `Client role di ${ctx.acc.rolesClient}: ${clientRoles.join(", ") || "nessuno"}`, `Realm role: ${realmRoles.join(", ") || "nessuno"}`,
      ...(otherClients.length ? [`Ruoli di altri client (ignorati): ${otherClients.join(", ")}`] : [])].join("\n"),
  };
  if (roles.status === "warn") roles.hint = `Il ruolo ${ctx.acc.adminRole} non è nel token: deve essere un client role del client ${ctx.acc.rolesClient} (o un realm role) assegnato all'utente, e il client scope "roles" deve essere incluso nel token.`;
  out.push(roles);
  const clientId = ctx.cfg.keycloak?.clientId;
  if (clientId && t.azp && t.azp !== clientId) out.push({ id: "token-azp", group: "Keycloak e token", label: "Client del token", status: "warn", detail: `Token emesso per ${t.azp}, l'app è configurata per ${clientId}.`, hint: "KEYCLOAK_CLIENT_ID deve essere il client con cui gli utenti fanno l'accesso." });
  if (typeof t.exp === "number") {
    const left = Math.round((t.exp * 1000 - now) / 60_000);
    out.push({ id: "token-exp", group: "Keycloak e token", label: "Scadenza del token", status: left > 0 ? "ok" : "warn", detail: left > 0 ? `Scade tra ${left} min (si rinnova da solo).` : "Scaduto: il rinnovo non è riuscito." });
  }
  if (typeof t.iat === "number") {
    const skew = Math.round((now - t.iat * 1000) / 1000);
    if (skew < -60) out.push({ id: "clock", group: "Keycloak e token", label: "Orologio", status: "warn", detail: `Il token risulta emesso ${-skew} s nel futuro rispetto all'orologio di questo computer.`, hint: "Orologio del computer o del server Keycloak fuori sincronia: i token possono sembrare non ancora validi o già scaduti." });
  }
  return out;
}

export async function checkDiscovery(ctx: DiagContext): Promise<CheckResult> {
  const k = ctx.cfg.keycloak;
  const base = { id: "kc-discovery", group: "Keycloak e token", label: "Keycloak raggiungibile dal browser" };
  if (!k) return { ...base, status: "skip", detail: "Keycloak non configurato." };
  const url = `${k.url.replace(/\/$/, "")}/realms/${encodeURIComponent(k.realm)}/.well-known/openid-configuration`;
  try {
    const { value, ms } = await timed(async () => { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }, ctx.timeoutMs ?? 10_000);
    const iss = (ctx.kc.tokenParsed as any)?.iss;
    if (iss && value.issuer && iss !== value.issuer) return { ...base, status: "warn", ms, detail: `Issuer del realm: ${value.issuer}\nIssuer del token: ${iss}`, hint: "KEYCLOAK_URL deve essere l'indirizzo pubblico di Keycloak (lo stesso del frontend URL del realm), altrimenti GeoServer può rifiutare i token." };
    return { ...base, status: "ok", ms, detail: `Issuer ${value.issuer ?? "?"}` };
  } catch (e) {
    return { ...base, status: "fail", detail: `${url}: ${msg(e)}`, hint: "Se Keycloak risponde da un altro dominio, \"Web origins\" del client deve includere l'origine dell'app (CORS)." };
  }
}

export async function checkRefresh(ctx: DiagContext): Promise<CheckResult> {
  const base = { id: "kc-refresh", group: "Keycloak e token", label: "Rinnovo del token (CORS)" };
  try {
    const { ms } = await timed(() => ctx.kc.updateToken(-1), ctx.timeoutMs ?? 10_000);
    return { ...base, status: "ok", ms, detail: "Token rinnovato: \"Web origins\" del client accetta questa origine." };
  } catch (e) {
    return { ...base, status: "fail", detail: msg(e) === "undefined" || !msg(e) ? "Rinnovo rifiutato." : msg(e), hint: `Aggiungi ${ctx.origin} a "Web origins" del client Keycloak: senza CORS il token scade e l'utente viene rimandato al login.` };
  }
}

export function redirectInfo(ctx: DiagContext): CheckResult {
  return {
    id: "kc-redirect", group: "Keycloak e token", label: "Indirizzi da configurare nel client Keycloak", status: "info",
    detail: `Valid redirect URIs: ${ctx.origin}/*\nValid post logout redirect URIs: ${ctx.origin}/*\nWeb origins: ${ctx.origin}`,
  };
}

// ---------------------------------------------------------------- sfondi
export const sampleTile = (tpl: string) => tpl.replace("{z}", "0").replace("{x}", "0").replace("{y}", "0").replace("{-y}", "0").replace(/\{s\}/g, "a").replace(/\{r\}/g, "");

const loadImageDefault = (url: string) => new Promise<void>((res, rej) => { const i = new Image(); i.onload = () => res(); i.onerror = () => rej(new Error("tile non caricato")); i.src = url; });

export async function checkBasemaps(ctx: DiagContext): Promise<CheckResult[]> {
  const load = ctx.loadImage ?? loadImageDefault;
  return Promise.all(resolveBasemaps(ctx.cfg).map(async (b): Promise<CheckResult> => {
    const base = { id: `basemap-${b.id}`, group: "Sfondi", label: b.label };
    if (!b.tiles) return { ...base, status: "skip", detail: "Nessun tile (sfondo vuoto)." };
    const url = sampleTile(b.tiles);
    try { const { ms } = await timed(() => load(url), ctx.timeoutMs ?? 10_000); return { ...base, status: "ok", ms, detail: url }; }
    catch (e) { return { ...base, status: "fail", detail: `${url}: ${msg(e)}`, hint: "Il server dei tile non risponde o blocca questo dominio; controlla BASEMAPS / BASEMAP_TILES." }; }
  }));
}

// ---------------------------------------------------------------- tutti insieme
export async function runChecks(ctx: DiagContext, onResult?: (r: CheckResult[]) => void): Promise<CheckResult[]> {
  const all: CheckResult[] = [];
  const push = (r: CheckResult | CheckResult[]) => { all.push(...(Array.isArray(r) ? r : [r])); onResult?.(sortResults(all)); };
  push(configSummary(ctx));
  push(checkToken(ctx));
  push(redirectInfo(ctx));
  await Promise.all([
    checkGeoServer(ctx).then(push),
    ...CONFIG_TABLES.map((t) => checkTable(ctx, t).then(push)),
    checkWrite(ctx).then(push),
    checkDiscovery(ctx).then(push),
    checkRefresh(ctx).then(push),
    checkBasemaps(ctx).then(push),
  ]);
  return sortResults(all);
}

const ORDER = (id: string) => {
  const fixed = ["config", "gs-wms", "gs-wfs", ...CONFIG_TABLES.map((t) => `table-${t}`), "write", "token-roles", "token-azp", "token-exp", "clock", "kc-discovery", "kc-refresh", "kc-redirect"];
  const i = fixed.indexOf(id);
  return i >= 0 ? i : fixed.length;
};
export const sortResults = (l: CheckResult[]) => [...l].sort((a, b) => GROUPS.indexOf(a.group as never) - GROUPS.indexOf(b.group as never) || ORDER(a.id) - ORDER(b.id) || a.label.localeCompare(b.label));

export function summary(l: CheckResult[]): Record<CheckStatus, number> {
  const out: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, info: 0, skip: 0 };
  for (const r of l) out[r.status]++;
  return out;
}

/** Rapporto di testo da incollare in una segnalazione (niente token, solo ciò che si vede nella pagina). */
export function reportText(l: CheckResult[], when: Date, origin: string): string {
  const head = `Diagnostica Gema · ${origin} · ${when.toISOString()}`;
  const body = GROUPS.map((g) => {
    const rows = l.filter((r) => r.group === g);
    if (!rows.length) return "";
    return [`\n## ${g}`, ...rows.map((r) => `[${STATUS_LABEL[r.status]}] ${r.label}${r.ms != null ? ` (${r.ms} ms)` : ""}\n  ${r.detail.replace(/\n/g, "\n  ")}${r.hint ? `\n  → ${r.hint}` : ""}`)].join("\n");
  }).join("\n");
  return head + body + "\n";
}
