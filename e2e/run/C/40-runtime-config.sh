#!/bin/sh
# Genera /config.json dalle variabili d'ambiente, a meno che non sia già
# presente (es. montato da una ConfigMap Kubernetes).
#
#   AUTH_ENABLED=false     omette il blocco keycloak (login disattivato)
#   KEYCLOAK_URL / KEYCLOAK_REALM / KEYCLOAK_CLIENT_ID   obbligatorie con l'auth attiva
#   GEOSERVER_PROXY_URL    se impostata, il browser usa /geoserver (GEOSERVER_URL viene ignorata)
#   BACKEND_URL            se impostata, il browser usa /api (API_URL viene ignorata)
#   EDIT_ENABLED=true      mostra gli strumenti di editing (serve anche nel proxy: vedi 35-proxy-config.sh)
#   EDIT_ROLE              ruolo Keycloak richiesto per vedere l'editing (vuoto = tutti)
#   MAP_BBOX               area di interesse "ovest,sud,est,nord" (gradi) per il pulsante di zoom; senza, usa MAP_CENTER_*/MAP_ZOOM
#   APP_TITLE, APP_ACCENT  nome nell'header e colore principale (#rrggbb)
#   ACCESS_CONTROL=true    attiva ruoli, pagine admin e dashboard per ruolo (richiede AUTH_ENABLED=true)
#   ADMIN_ROLE             client role che apre le pagine admin (default fss-etl-admin)
#   VIEWER_ROLE            client role del visualizzatore (default fss-etl-viewer)
#   ROLES_CLIENT_ID        client Keycloak che contiene i ruoli (default KEYCLOAK_CLIENT_ID)
#   KNOWN_ROLES            ruoli proposti nella pagina admin, separati da virgola (es. fss-etl-viewer,fss-etl-ops)
#   CONFIG_WORKSPACE       workspace GeoServer con le tabelle di configurazione (default mapp)
#   LOGO_URL               logo nell'header al posto della lettera (URL o percorso, es. /logos/logo.svg)
#   LOGO_HEIGHT            altezza dei loghi in px (default 28)
#   PARTNER_LOGOS          loghi a destra nell'header, separati da virgola (es. /logos/a.svg,/logos/b.png)
#   FAVICON_URL            icona della scheda del browser
#   LOGO_SHOW_TITLE=true   mostra APP_TITLE anche accanto al logo (di default, con un logo, il testo non si ripete)
#   APP_HEADER_COLOR       colore dell'header (#rrggbb); nel tema scuro anche pannelli e bordi ne derivano
#   PARTNER_LOGOS_BG       sfondo dietro ai loghi partner: #rrggbb oppure "none" (default bianco)
#   BASEMAPS               sfondi selezionabili: "id|Etichetta|tile{z}/{x}/{y}|attribuzione" separati da ";" (tile vuoto = nessuno).
#                          Senza, si usano mappa (BASEMAP_TILES), satellite Esri, scuro CARTO e nessuno.
#   GEOCODER               ricerca di luoghi: nominatim (default), photon o off (vedi 35-proxy-config.sh per GEOCODER_URL)
#   GEOCODER_COUNTRY       limita Nominatim a uno o più paesi (codici ISO, es. it o it,sm)
#   GEOCODER_LANG          lingua dei risultati (default it)
#   TERRAIN_TILES          tile DEM "terrarium" per il rilievo 3D (es. https://host/{z}/{x}/{y}.png)
set -eu
CONF=/tmp/claude-0/-home-claude/7cc3e260-b8c6-5054-96fd-442188c76508/scratchpad/ep/e2e/run/C/html/config.json

if [ -e "$CONF" ]; then
  echo "[config] $CONF già presente (mount), generazione saltata"
  exit 0
fi

json() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }   # per i valori testuali liberi

if [ "${AUTH_ENABLED:-true}" = "false" ]; then
  KC_BLOCK=""
  echo "[config] autenticazione Keycloak disabilitata"
else
  KC_BLOCK="\"keycloak\": { \"url\": \"$(json "${KEYCLOAK_URL:?KEYCLOAK_URL è obbligatoria}")\", \"realm\": \"$(json "${KEYCLOAK_REALM:?KEYCLOAK_REALM è obbligatoria}")\", \"clientId\": \"$(json "${KEYCLOAK_CLIENT_ID:?KEYCLOAK_CLIENT_ID è obbligatoria}")\" },"
fi

# Se il proxy nginx è configurato, il browser deve usare i path relativi: l'URL interno del service
# (GEOSERVER_PROXY_URL / BACKEND_URL) non è risolvibile dal browser. Ignoro quindi GEOSERVER_URL / API_URL.
if [ -n "${GEOSERVER_PROXY_URL:-}" ]; then
  [ -n "${GEOSERVER_URL:-}" ] && echo "[config] GEOSERVER_URL ignorata: con GEOSERVER_PROXY_URL il browser usa /geoserver"
  GS_PUBLIC="/geoserver"
else
  GS_PUBLIC="${GEOSERVER_URL:-/geoserver}"
fi
if [ -n "${BACKEND_URL:-}" ]; then
  [ -n "${API_URL:-}" ] && echo "[config] API_URL ignorata: con BACKEND_URL il browser usa /api"
  API_PUBLIC="/api"
else
  API_PUBLIC="${API_URL:-/api}"
fi

roles_json() { # elenco separato da virgole -> "a","b"
  printf '%s' "$1" | tr ',' '\n' | sed 's/^ *//; s/ *$//' | grep -v '^$' | while IFS= read -r r; do printf '"%s",' "$(json "$r")"; done | sed 's/,$//'
}
ACCESS_BLOCK=""
case "${ACCESS_CONTROL:-false}" in
  true|TRUE|True|1|yes|YES)
    if [ "${AUTH_ENABLED:-true}" = "false" ]; then
      echo "[config] ACCESS_CONTROL ignorato: servono i ruoli di Keycloak (AUTH_ENABLED=false)"
    else
      ACCESS_BLOCK="\"access\": { \"enabled\": true, \"adminRole\": \"$(json "${ADMIN_ROLE:-fss-etl-admin}")\", \"viewerRole\": \"$(json "${VIEWER_ROLE:-fss-etl-viewer}")\", \"rolesClient\": \"$(json "${ROLES_CLIENT_ID:-${KEYCLOAK_CLIENT_ID:-}}")\", \"knownRoles\": [$(roles_json "${KNOWN_ROLES:-}")], \"workspace\": \"$(json "${CONFIG_WORKSPACE:-mapp}")\" },"
      echo "[config] controllo accessi attivo (admin: ${ADMIN_ROLE:-fss-etl-admin}, viewer: ${VIEWER_ROLE:-fss-etl-viewer})"
    fi ;;
esac

case "${LOGO_HEIGHT:-28}" in ''|*[!0-9]*) LOGO_H=28 ;; *) LOGO_H="${LOGO_HEIGHT:-28}" ;; esac

case "${LOGO_SHOW_TITLE:-false}" in true|TRUE|True|1|yes|YES) LOGO_TITLE=true ;; *) LOGO_TITLE=false ;; esac
hexcolor() { case "$1" in \#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]) printf '%s' "$1" ;; esac; }
HEADER_C="$(hexcolor "${APP_HEADER_COLOR:-}")"
case "${PARTNER_LOGOS_BG:-}" in none|NONE) PARTNER_BG=none ;; *) PARTNER_BG="$(hexcolor "${PARTNER_LOGOS_BG:-}")" ;; esac

# MAP_BBOX: quattro numeri "ovest,sud,est,nord"; se non è valido viene ignorato (e si usa centro/zoom)
BBOX_JSON=""
BBOX_RAW="$(printf '%s' "${MAP_BBOX:-}" | tr -d ' ')"
if [ -n "$BBOX_RAW" ]; then
  if printf '%s' "$BBOX_RAW" | grep -Eq '^-?[0-9]+(\.[0-9]+)?(,-?[0-9]+(\.[0-9]+)?){3}$'; then BBOX_JSON="\"mapBounds\": [${BBOX_RAW}],"
  else echo "[config] MAP_BBOX ignorato (atteso ovest,sud,est,nord in gradi): $BBOX_RAW"; fi
fi

case "${EDIT_ENABLED:-false}" in true|TRUE|True|1|yes|YES) EDIT_JSON=true ;; *) EDIT_JSON=false ;; esac

# NB: il default va in una variabile a parte, perché le graffe di {z}/{x}/{y} dentro ${VAR:-...}
# chiuderebbero l'espansione al primo "}" e produrrebbero un URL sbagliato.
DEFAULT_TILES='https://tile.openstreetmap.org/{z}/{x}/{y}.png'
BASEMAP="${BASEMAP_TILES:-$DEFAULT_TILES}"

# BASEMAPS: "id|Etichetta|tile|attribuzione;..." -> elenco JSON (le voci non valide le scarta il browser)
basemaps_json() {
  printf '%s\n' "$1" | tr ';' '\n' | while IFS='|' read -r b_id b_label b_tiles b_attr; do
    b_id="$(printf '%s' "$b_id" | tr -d ' ')"
    [ -n "$b_id" ] || continue
    b_tiles="$(printf '%s' "$b_tiles" | tr -d ' ')"   # nei tile non ci sono spazi: " " = vuoto = nessuno sfondo
    printf '{"id":"%s","label":"%s","tiles":"%s","attribution":"%s"},' "$(json "$b_id")" "$(json "${b_label:-$b_id}")" "$(json "$b_tiles")" "$(json "$b_attr")"
  done | sed 's/,$//'
}
BASEMAPS_BLOCK=""
BM="$(basemaps_json "${BASEMAPS:-}")"
[ -n "$BM" ] && BASEMAPS_BLOCK="\"basemaps\": [${BM}],"

# GEOCODER: il browser usa sempre /geocode (lo inoltra nginx, vedi 35-proxy-config.sh)
GEOCODER_BLOCK=""
GEO_T="$(printf '%s' "${GEOCODER:-nominatim}" | tr 'A-Z' 'a-z')"
case "$GEO_T" in
  nominatim|photon)
    GEO_C="$(printf '%s' "${GEOCODER_COUNTRY:-}" | tr -d ' ' | tr 'A-Z' 'a-z')"
    printf '%s' "$GEO_C" | grep -Eq '^([a-z]{2}(,[a-z]{2})*)?$' || { echo "[config] GEOCODER_COUNTRY ignorato (atteso codici a 2 lettere): $GEO_C"; GEO_C=""; }
    GEO_L="$(printf '%s' "${GEOCODER_LANG:-it}" | tr 'A-Z' 'a-z')"
    printf '%s' "$GEO_L" | grep -Eq '^[a-z]{2}$' || GEO_L=it
    GEOCODER_BLOCK="\"geocoder\": { \"type\": \"$GEO_T\", \"url\": \"/geocode\", \"country\": \"$GEO_C\", \"lang\": \"$GEO_L\" }," ;;
esac

cat > "$CONF" <<JSON
{
  ${KC_BLOCK}
  ${ACCESS_BLOCK}
  "apiUrl": "$(json "${API_PUBLIC}")",
  "geoserverUrl": "$(json "${GS_PUBLIC}")",
  "basemapTiles": "$(json "${BASEMAP}")",
  "mapCenter": [${MAP_CENTER_LON:-12.5}, ${MAP_CENTER_LAT:-42.0}],
  ${BBOX_JSON}
  ${BASEMAPS_BLOCK}
  ${GEOCODER_BLOCK}
  "mapZoom": ${MAP_ZOOM:-5},
  "title": "$(json "${APP_TITLE:-}")",
  "logo": "$(json "${LOGO_URL:-}")",
  "logoHeight": ${LOGO_H},
  "partnerLogos": [$(roles_json "${PARTNER_LOGOS:-}")],
  "favicon": "$(json "${FAVICON_URL:-}")",
  "logoShowTitle": ${LOGO_TITLE},
  "headerColor": "${HEADER_C}",
  "partnerLogosBg": "${PARTNER_BG}",
  "accent": "$(json "${APP_ACCENT:-}")",
  "editEnabled": ${EDIT_JSON},
  "editRole": "$(json "${EDIT_ROLE:-}")",
  "terrainTiles": "$(json "${TERRAIN_TILES:-}")"
}
JSON
echo "[config] generato $CONF (editing: ${EDIT_JSON})"
