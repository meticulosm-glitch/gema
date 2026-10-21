import type { AccessConfig } from "./config";

/**
 * «Visualizza come ruolo»: l'amministratore usa l'applicazione con i permessi, la vista iniziale, le dashboard e gli
 * avvisi di un altro ruolo, per controllare cosa vede. Vale solo nell'interfaccia: le richieste a GeoServer partono
 * sempre con il token dell'amministratore. La scelta resta nella scheda del browser (sessionStorage) finché non si esce.
 */
const KEY = "gema.viewAs";

export function loadViewAs(): string | null {
  try { const v = sessionStorage.getItem(KEY); return v && v.trim() ? v.trim() : null; } catch { return null; }
}

export function storeViewAs(role: string | null): void {
  try { if (role) sessionStorage.setItem(KEY, role); else sessionStorage.removeItem(KEY); } catch { /* storage non disponibile: vale fino al ricaricamento */ }
}

/** Ruoli con cui calcolare permessi e viste: quelli del token, oppure il ruolo scelto se l'utente è davvero amministratore. */
export function effectiveRoles(tokenRoles: string[], acc: AccessConfig, viewAs: string | null): string[] {
  if (!viewAs || viewAs === acc.adminRole || !tokenRoles.includes(acc.adminRole)) return tokenRoles;
  return [viewAs];
}
