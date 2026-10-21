export interface AppConfig {
  keycloak?: { url: string; realm: string; clientId: string }; // assente = auth disabilitata
  apiUrl: string;
  geoserverUrl: string;
  basemapTiles: string;
  mapCenter: [number, number];
  mapZoom: number;
  mapBounds?: [number, number, number, number]; // area di interesse (west, south, east, north); assente = centro e zoom iniziali
  title?: string;         // nome nell'header e nel titolo della pagina
  accent?: string;        // colore principale, #rrggbb
  editEnabled?: boolean;  // mostra gli strumenti di editing (WFS-T)
  editRole?: string;      // ruolo Keycloak richiesto per l'editing (vuoto = tutti)
  terrainTiles?: string;  // tile DEM "terrarium" per il rilievo 3D
  logo?: string;          // logo nell'header (al posto della lettera); URL assoluto o relativo
  logoHeight?: number;    // altezza in px (default 28)
  partnerLogos?: string[]; // loghi aggiuntivi a destra nell'header
  favicon?: string;
  logoShowTitle?: boolean; // mostra il nome accanto al logo (di default il logo basta)
  headerColor?: string;   // colore dell'header (#rrggbb); le superfici del tema scuro ne derivano
  partnerLogosBg?: string; // sfondo dietro ai loghi partner: #rrggbb oppure "none"
  basemaps?: { id: string; label: string; tiles?: string; attribution?: string; maxzoom?: number }[]; // sfondi selezionabili; assente = mappa, satellite, scuro, nessuno
  geocoder?: { type: "nominatim" | "photon"; url: string; country?: string; lang?: string }; // ricerca di luoghi; assente = solo ricerca per attributo
  access?: AccessConfig;  // ruoli, pagine admin e dashboard per ruolo (richiede Keycloak)
  downloadMaxFeatures?: number; // tetto di oggetti per uno scarico vettoriale (default 50000)
  clientErrors?: boolean; // errori JavaScript del browser a /client-errors, nel log di nginx (default true)
  wmsTiled?: boolean;     // aggiunge tiled=true alle GetMap (integrazione diretta WMS di GeoWebCache)
  usageStats?: "off" | "anonymous" | "named"; // statistiche d'uso (default anonymous: ruoli e sessione, senza nome utente)
}

export interface AccessConfig {
  enabled: boolean;
  adminRole: string;      // client role che apre le pagine admin (es. fss-etl-admin)
  viewerRole: string;     // client role del visualizzatore (es. fss-etl-viewer)
  rolesClient: string;    // client Keycloak che contiene i ruoli
  knownRoles: string[];   // ruoli proposti nella pagina admin (il browser non può elencare quelli di Keycloak)
  workspace: string;      // workspace GeoServer delle tabelle di configurazione
}

export async function loadConfig(): Promise<AppConfig> {
  const res = await fetch("/config.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`config.json non disponibile (${res.status})`);
  return res.json();
}
