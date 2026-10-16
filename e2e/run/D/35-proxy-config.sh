#!/bin/sh
# Genera la configurazione del reverse proxy nginx (in /tmp/claude-0/-home-claude/7cc3e260-b8c6-5054-96fd-442188c76508/scratchpad/ep/e2e/run/D/proxy.d) dalle variabili d'ambiente.
#
#   BACKEND_URL           upstream per /api/        (es. http://mapp-api.ns.svc.cluster.local:8000)
#   GEOSERVER_PROXY_URL   upstream per /geoserver/  (es. http://geoserver.ns.svc.cluster.local:8080/geoserver)
#
#   Credenziali di LETTURA iniettate da nginx (Basic):
#     GEOSERVER_USER / GEOSERVER_PASSWORD         oppure   GEOSERVER_USER_FILE / GEOSERVER_PASSWORD_FILE
#   Credenziali di SCRITTURA (usate solo per POST /geoserver/wfs, cioè le transazioni WFS-T):
#     GEOSERVER_WRITE_USER / GEOSERVER_WRITE_PASSWORD   oppure   ..._FILE
#   GEOSERVER_WRITE_PASSTHROUGH=true   le scritture (POST /geoserver/wfs) inoltrano il token Bearer dell'utente invece di
#                         credenziali fisse: è quello che serve con ACCESS_CONTROL, perché sia GeoServer (OIDC + regole dati)
#                         a decidere chi può scrivere. Con credenziali fisse, qualunque utente loggato scriverebbe come l'utente di scrittura.
#   ACCESS_CONTROL=true   (stesso flag dell'app) consente POST su /geoserver/wfs, serve per salvare ruoli e dashboard
#   EDIT_ENABLED=true     consente le scritture. Di default il proxy è in SOLA LETTURA: ogni metodo diverso da GET/HEAD
#                         verso /geoserver/ riceve 403, e nemmeno /geoserver/rest o altri endpoint accettano POST.
#
#   GEOCODER              ricerca di luoghi: nominatim (default), photon oppure off. Il browser chiama /geocode/ e nginx inoltra
#                         a GEOCODER_URL (default https://nominatim.openstreetmap.org oppure https://photon.komoot.io)
#                         SENZA Authorization né cookie, con una cache di 1 giorno e un limite di richieste per client.
#   GEOCODER_USER_AGENT   User-Agent verso il geocoder (la policy di Nominatim vuole uno che identifichi l'applicazione)
#
# Senza credenziali, l'header Authorization del browser (es. il Bearer di Keycloak) passa invariato.
# Il prefisso (/api/, /geoserver/) viene sostituito dal path dell'upstream.
# Se un upstream non è configurato, la route risponde 503 JSON invece di restituire index.html.
set -eu
DIR=/tmp/claude-0/-home-claude/7cc3e260-b8c6-5054-96fd-442188c76508/scratchpad/ep/e2e/run/D/proxy.d
OUT="$DIR/proxy.conf"
MAP="$DIR/auth.map"
umask 077
: > "$OUT"
: > "$MAP"

secret() { # $1 = valore diretto, $2 = percorso di un file (Secret montato come volume)
  if [ -n "$1" ]; then printf '%s' "$1"
  elif [ -n "$2" ] && [ -r "$2" ]; then cat "$2"
  fi
}
# base64 evita problemi con $ " \ nella password: nel file nginx finiscono solo caratteri sicuri
basic() { printf 'Basic %s' "$(printf '%s:%s' "$1" "$2" | base64 | tr -d '\n')"; }

R_USER="$(secret "${GEOSERVER_USER:-}" "${GEOSERVER_USER_FILE:-}")"
R_PASS="$(secret "${GEOSERVER_PASSWORD:-}" "${GEOSERVER_PASSWORD_FILE:-}")"
W_USER="$(secret "${GEOSERVER_WRITE_USER:-}" "${GEOSERVER_WRITE_USER_FILE:-}")"
W_PASS="$(secret "${GEOSERVER_WRITE_PASSWORD:-}" "${GEOSERVER_WRITE_PASSWORD_FILE:-}")"

case "${EDIT_ENABLED:-false}" in true|TRUE|True|1|yes|YES) EDIT=1 ;; *) EDIT=0 ;; esac
# ACCESS_CONTROL richiede Keycloak: con AUTH_ENABLED=false viene ignorato (come in 40-runtime-config.sh)
ACCESS=0
case "${ACCESS_CONTROL:-false}" in true|TRUE|True|1|yes|YES) [ "${AUTH_ENABLED:-true}" = "false" ] || ACCESS=1 ;; esac
[ "$ACCESS" = 1 ] && EDIT=1

READ_VAL='$http_authorization'
if [ -n "$R_USER" ] && [ -n "$R_PASS" ]; then
  READ_VAL="\"$(basic "$R_USER" "$R_PASS")\""
  echo "[proxy] credenziali di lettura GeoServer caricate (utente: $R_USER)"
else
  echo "[proxy] nessuna credenziale di lettura: l'header Authorization del browser passa invariato"
fi
WRITE_VAL="$READ_VAL"
if [ -n "$W_USER" ] && [ -n "$W_PASS" ]; then
  WRITE_VAL="\"$(basic "$W_USER" "$W_PASS")\""
  echo "[proxy] credenziali di scrittura GeoServer caricate (utente: $W_USER)"
fi
case "${GEOSERVER_WRITE_PASSTHROUGH:-false}" in
  true|TRUE|True|1|yes|YES)
    WRITE_VAL='$http_authorization'
    echo "[proxy] scritture: inoltro l'header Authorization dell'utente (token Keycloak), nessuna credenziale fissa" ;;
  *)
    [ "$ACCESS" = 1 ] && echo "[proxy] ATTENZIONE: ACCESS_CONTROL senza GEOSERVER_WRITE_PASSTHROUGH: ogni utente loggato può scrivere con le credenziali di scrittura del proxy, anche se l'interfaccia lo nasconde" ;;
esac
if [ "$EDIT" = 1 ] && [ -z "$W_USER" ] && [ "${GEOSERVER_WRITE_PASSTHROUGH:-false}" != "true" ]; then
  echo "[proxy] ATTENZIONE: scritture abilitate (EDIT_ENABLED/ACCESS_CONTROL) senza credenziali di scrittura dedicate: le transazioni usano le credenziali di lettura o il token del browser"
fi

# l'header Authorization verso GeoServer dipende dal metodo: scrittura solo per POST
printf 'map $request_method $gs_auth {\n  default %s;\n  POST    %s;\n}\n' "$READ_VAL" "$WRITE_VAL" > "$MAP"

# direttive comuni a tutte le route proxate
common() { # $1 = host:porta dell'upstream, $2 = righe SSL (opzionali)
  cat <<CONF
  proxy_http_version 1.1;
  proxy_set_header Host $1;
${2:-}
  proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto \$scheme;
  proxy_set_header X-Forwarded-Host \$http_host;
  proxy_read_timeout 120s;
CONF
}

emit_proxy() { # $1 = prefisso, $2 = upstream, $3 = nome variabile, $4 = "gs" per GeoServer
  if [ -z "$2" ]; then
    cat >> "$OUT" <<CONF
location $1 {
  default_type application/json;
  return 503 '{"error":"$3 non configurata"}';
}
CONF
    echo "[proxy] $1 non configurato ($3 vuota)"
    return
  fi
  UP="${2%/}"
  UP_HOSTPORT="${UP#*://}"; UP_HOSTPORT="${UP_HOSTPORT%%/*}"
  UP_HOST="${UP_HOSTPORT%%:*}"
  SSL_LINES=""
  case "$UP" in
    https://*) SSL_LINES="  proxy_ssl_server_name on;
  proxy_ssl_name ${UP_HOST};" ;;
  esac

  if [ "$4" = gs ]; then
    {
      echo "location $1 {"
      echo "  limit_except GET { deny all; }"          # GET comprende HEAD; tutto il resto -> 403
      echo "  proxy_pass $UP/;"
      common "$UP_HOSTPORT" "$SSL_LINES"
      echo '  proxy_set_header Authorization $gs_auth;'
      echo "}"
    } >> "$OUT"
    echo "[proxy] $1 -> $UP/ (sola lettura)"
    if [ "$EDIT" = 1 ]; then
      {
        echo "location = ${1}wfs {"                    # l'unico endpoint scrivibile: transazioni WFS-T
        echo "  limit_except GET POST { deny all; }"
        echo "  client_max_body_size 10m;"
        echo "  proxy_pass $UP/wfs;"
        common "$UP_HOSTPORT" "$SSL_LINES"
        echo '  proxy_set_header Authorization $gs_auth;'
        echo "}"
      } >> "$OUT"
      echo "[proxy] ${1}wfs: POST consentito (scritture WFS-T abilitate)"
    fi
  else
    {
      echo "location $1 {"
      echo "  proxy_pass $UP/;"
      common "$UP_HOSTPORT" "$SSL_LINES"
      echo "}"
    } >> "$OUT"
    echo "[proxy] $1 -> $UP/"
  fi
}

emit_proxy /api/       "${BACKEND_URL:-}"         BACKEND_URL         api
emit_proxy /geoserver/ "${GEOSERVER_PROXY_URL:-}" GEOSERVER_PROXY_URL gs

# ---------------------------------------------------------------- geocoder (ricerca di indirizzi e luoghi)
GEO_TYPE="$(printf '%s' "${GEOCODER:-nominatim}" | tr 'A-Z' 'a-z')"
GEO_UP=""
case "$GEO_TYPE" in
  nominatim) GEO_UP="${GEOCODER_URL:-https://nominatim.openstreetmap.org}"; GEO_RATE="1r/s" ;;
  photon)    GEO_UP="${GEOCODER_URL:-https://photon.komoot.io}";            GEO_RATE="5r/s" ;;
  off|none|false|"") echo "[proxy] geocoder disattivato (GEOCODER=$GEO_TYPE)" ;;
  *) echo "[proxy] GEOCODER=$GEO_TYPE non riconosciuto (nominatim|photon|off): ricerca di luoghi disattivata" ;;
esac
GMAP="$DIR/geocode.map"
: > "$GMAP"
if [ -n "$GEO_UP" ]; then
  GU="${GEO_UP%/}"
  GU_HOSTPORT="${GU#*://}"; GU_HOSTPORT="${GU_HOSTPORT%%/*}"
  GU_HOST="${GU_HOSTPORT%%:*}"
  GU_SSL=""
  case "$GU" in https://*) GU_SSL="  proxy_ssl_server_name on;
  proxy_ssl_name ${GU_HOST};" ;; esac
  # direttive a livello http: cache e limite per client (dietro a un ingress il client è nell'ultimo X-Forwarded-For)
  cat > "$GMAP" <<CONF
proxy_cache_path /tmp/nginx-geocode levels=1:2 keys_zone=geocode_cache:5m max_size=20m inactive=1d use_temp_path=off;
map \$http_x_forwarded_for \$geocode_client { default \$http_x_forwarded_for; "" \$binary_remote_addr; }
limit_req_zone \$geocode_client zone=geocode_rl:1m rate=${GEO_RATE};
CONF
  {
    echo "location /geocode/ {"
    echo "  limit_except GET { deny all; }"
    echo "  limit_req zone=geocode_rl burst=5 nodelay;"
    echo "  limit_req_status 429;"
    echo "  proxy_pass $GU/;"
    echo "  proxy_http_version 1.1;"
    echo "  proxy_set_header Host $GU_HOSTPORT;"
    [ -n "$GU_SSL" ] && echo "$GU_SSL"
    # un servizio esterno non deve mai ricevere il token Keycloak né i cookie dell'utente
    echo '  proxy_set_header Authorization "";'
    echo '  proxy_set_header Cookie "";'
    echo '  proxy_set_header Referer "";'
    echo "  proxy_set_header User-Agent \"$(printf '%s' "${GEOCODER_USER_AGENT:-mapp-web}" | tr -cd 'A-Za-z0-9 ._/:()@+-')\";"
    echo "  proxy_hide_header Set-Cookie;"
    echo "  proxy_ignore_headers Cache-Control Expires Set-Cookie;"
    echo "  proxy_cache geocode_cache;"
    echo '  proxy_cache_key "$request_uri";'
    echo "  proxy_cache_valid 200 1d;"
    echo "  proxy_read_timeout 15s;"
    echo "}"
  } >> "$OUT"
  echo "[proxy] /geocode/ -> $GU/ ($GEO_TYPE, cache 1 giorno, $GEO_RATE per client)"
fi
