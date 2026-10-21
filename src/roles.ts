import type Keycloak from "keycloak-js";
import type { AccessConfig } from "./config";

export type ToolId = "info" | "measure" | "table" | "dashboard" | "export" | "edit" | "view3d" | "series" | "compare" | "search" | "views" | "download";

export const TOOLS: { id: ToolId; label: string; hint: string }[] = [
  { id: "info", label: "Interroga oggetti", hint: "Feature Info" },
  { id: "measure", label: "Misure e coordinate", hint: "distanza, area, coordinate" },
  { id: "table", label: "Tabella attributi", hint: "" },
  { id: "dashboard", label: "Grafici sul layer", hint: "dashboard rapida di un attributo" },
  { id: "export", label: "Stampa / esporta", hint: "PNG con legenda" },
  { id: "view3d", label: "Vista 3D", hint: "" },
  { id: "series", label: "Serie storica in un punto", hint: "valore del layer nel tempo (più GetFeatureInfo)" },
  { id: "compare", label: "Confronto con cursore", hint: "swipe tra due layer o due date" },
  { id: "search", label: "Ricerca luoghi e attributi", hint: "indirizzi (geocoder) e testo negli attributi dei layer attivi" },
  { id: "views", label: "Viste salvate", hint: "salva e riapri viste con nome (tabella saved_views)" },
  { id: "download", label: "Scarica dati", hint: "CSV, GeoJSON, Shapefile (WFS) e GeoTIFF dell'area visibile (WCS)" },
  { id: "edit", label: "Modifica oggetti", hint: "WFS-T: serve anche il permesso di scrittura su GeoServer" },
];
export const TOOL_IDS = TOOLS.map((t) => t.id);
/** Strumenti del visualizzatore finché l'admin non ha configurato nessuna regola. */
export const DEFAULT_VIEWER_TOOLS: ToolId[] = ["info", "measure", "table", "dashboard", "export", "view3d", "series", "compare", "search", "views", "download"];

export interface RoleRule { fid?: string; role: string; layers: string[]; tools: ToolId[]; updatedBy?: string; updatedAt?: string }

export interface Permissions {
  admin: boolean;
  /** "*" = tutti i layer */
  layers: "*" | Set<string>;
  tools: Set<ToolId>;
  roles: string[];
  /** nessuna regola trovata per i ruoli dell'utente */
  none: boolean;
}

/** Ruoli dell'utente: client role del client configurato + realm role. */
export function userRoles(kc: Keycloak, acc: AccessConfig): string[] {
  const t: any = kc.tokenParsed ?? {};
  const client: string[] = t.resource_access?.[acc.rolesClient]?.roles ?? [];
  const realm: string[] = t.realm_access?.roles ?? [];
  return Array.from(new Set([...client, ...realm]));
}

export function computePermissions(roles: string[], rules: RoleRule[], acc: AccessConfig): Permissions {
  if (roles.includes(acc.adminRole)) return { admin: true, layers: "*", tools: new Set(TOOL_IDS), roles, none: false };
  // nessuna regola salvata: il visualizzatore vede tutto in sola lettura (bootstrap)
  if (rules.length === 0) {
    const ok = roles.includes(acc.viewerRole);
    return { admin: false, layers: ok ? "*" : new Set(), tools: new Set(ok ? DEFAULT_VIEWER_TOOLS : []), roles, none: !ok };
  }
  const mine = rules.filter((r) => roles.includes(r.role));
  if (mine.length === 0) return { admin: false, layers: new Set(), tools: new Set(), roles, none: true };
  const all = mine.some((r) => r.layers.includes("*"));
  return {
    admin: false,
    layers: all ? "*" : new Set(mine.flatMap((r) => r.layers)),
    tools: new Set(mine.flatMap((r) => r.tools)),
    roles,
    none: false,
  };
}

export const layerAllowed = (p: Permissions, name: string) => p.layers === "*" || p.layers.has(name);
export const slug = (s: string) => s.trim();
