import type Keycloak from "keycloak-js";
import type { AccessConfig } from "./config";
import { getWfsFeatures } from "./api";
import type { UsageKind } from "./usage";

/**
 * Lettura delle statistiche d'uso per la pagina admin: le viste aggregate per giorno (usage_sessions, usage_daily,
 * usage_roles), mai gli eventi uno per uno. Le sessioni sui più giorni sono la somma di quelle giornaliere.
 */
export interface DayRow { day: string; events: number; sessions: number; users: number }
export interface TopRow { target: string; events: number; sessions: number; users: number }
export interface RoleRow { role: string; events: number; sessions: number }
export interface UserRow { username: string; events: number; sessions: number; days: number; last: string }
export interface UsageReport {
  from: string; to: string;
  days: DayRow[];                                   // un elemento per giorno, anche a zero
  totals: { events: number; sessions: number; users: number };
  byKind: Partial<Record<UsageKind, TopRow[]>>;     // ordinati per eventi
  roles: RoleRow[];
  users: UserRow[];                                 // solo con USAGE_STATS=named
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const normDay = (v: unknown) => String(v ?? "").slice(0, 10);

export function periodFrom(days: number, now = new Date()): { from: string; to: string } {
  return { from: day(new Date(now.getTime() - (days - 1) * 86_400_000)), to: day(now) };
}

/** Tutti i giorni da `from` a `to`, con zero dove non ci sono eventi. */
export function fillDays(rows: DayRow[], from: string, to: string): DayRow[] {
  const by = new Map(rows.map((r) => [r.day, r]));
  const out: DayRow[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    out.push(by.get(d) ?? { day: d, events: 0, sessions: 0, users: 0 });
  }
  return out;
}

export function groupTop(rows: { kind: string; target: string; events: number; sessions: number; users: number }[]): UsageReport["byKind"] {
  const out: Record<string, Map<string, TopRow>> = {};
  for (const r of rows) {
    const m = (out[r.kind] ??= new Map());
    const cur = m.get(r.target) ?? { target: r.target, events: 0, sessions: 0, users: 0 };
    cur.events += r.events; cur.sessions += r.sessions; cur.users += r.users;
    m.set(r.target, cur);
  }
  return Object.fromEntries(Object.entries(out).map(([k, m]) => [k, Array.from(m.values()).sort((a, b) => b.events - a.events || a.target.localeCompare(b.target))]));
}

export async function loadUsage(gs: string, kc: Keycloak | null, acc: AccessConfig, days: number, now = new Date()): Promise<UsageReport> {
  const { from, to } = periodFrom(days, now);
  const cql = `day >= '${from}'`;
  const ws = acc.workspace;
  const [sess, daily, roles, users] = await Promise.all([
    getWfsFeatures(gs, kc, `${ws}:usage_sessions`, cql, 2000),
    getWfsFeatures(gs, kc, `${ws}:usage_daily`, cql, 20000),
    getWfsFeatures(gs, kc, `${ws}:usage_roles`, cql, 20000),
    getWfsFeatures(gs, kc, `${ws}:usage_users`, cql, 20000),
  ]);
  const dayRows = sess.map((f) => { const p = f.properties ?? {}; return { day: normDay(p.day), events: num(p.events), sessions: num(p.sessions), users: num(p.users) }; }).filter((r) => r.day >= from && r.day <= to);
  const filled = fillDays(dayRows, from, to);
  const userMap = new Map<string, UserRow>();
  for (const f of users) {
    const p = f.properties ?? {};
    const name = String(p.username ?? ""); if (!name) continue;
    const u = userMap.get(name) ?? { username: name, events: 0, sessions: 0, days: 0, last: "" };
    u.events += num(p.events); u.sessions += num(p.sessions); u.days += 1;
    const d = normDay(p.day); if (d > u.last) u.last = d;
    userMap.set(name, u);
  }
  const userList = Array.from(userMap.values()).sort((a, b) => b.sessions - a.sessions || b.events - a.events || a.username.localeCompare(b.username));
  const totals = filled.reduce((a, r) => ({ ...a, events: a.events + r.events, sessions: a.sessions + r.sessions }), { events: 0, sessions: 0, users: userList.length });
  const byKind = groupTop(daily.map((f) => { const p = f.properties ?? {}; return { kind: String(p.kind ?? ""), target: String(p.target ?? ""), events: num(p.events), sessions: num(p.sessions), users: num(p.users) }; }));
  const roleMap = new Map<string, RoleRow>();
  for (const f of roles) {
    const p = f.properties ?? {};
    const r = roleMap.get(String(p.role)) ?? { role: String(p.role ?? ""), events: 0, sessions: 0 };
    r.events += num(p.events); r.sessions += num(p.sessions);
    roleMap.set(r.role, r);
  }
  return { from, to, days: filled, totals, byKind, roles: Array.from(roleMap.values()).sort((a, b) => b.sessions - a.sessions || a.role.localeCompare(b.role)), users: userList };
}
