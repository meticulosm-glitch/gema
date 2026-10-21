#!/bin/sh
# Genera la configurazione del reverse proxy nginx (in /etc/nginx/proxy.d) dalle variabili d'ambiente.
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
#   TILE_CACHE=true       cache su disco dei tile WMS (GET GetMap) e dei tile GeoWebCache (/geoserver/gwc/): stessa richiesta,
#                         stessa immagine, senza tornare a GeoServer. Solo con credenziali di lettura fisse (GEOSERVER_USER):
#                         se passa il token dell'utente le immagini possono dipendere da chi le chiede e la cache resta spenta.
#                         Non si salvano le risposte che non sono immagini (eccezioni WMS, che GeoServer manda con status 200).
#   TILE_CACHE_TTL        durata di un tile in cache (default 10m; es. 30s, 10m, 2h, 1d). Dopo una modifica l'app chiede tile
#                         nuovi a chi ha modificato; gli altri li vedono aggiornati al più tardi dopo questo tempo.
#   TILE_CACHE_SIZE       spazio massimo su disco (default 1g; es. 500m, 2g), in /tmp/nginx-tiles (in Kubernetes: emptyDir)
#   ACCESS_LOG_FORMAT     log delle richieste: text (default, leggibile) oppure json (una riga JSON per richiesta, per Loki:
#                         tempo, metodo, path, stato, byte, durata e i parametri OGC service/request/layers/typename/format,
#                         codificati come nell'URL). Esempi LogQL (Grafana/Loki):
#                           layer più visti:  topk(10, sum by (layers) (count_over_time({app="gema-web"} | json | request="GetMap" [24h])))
#                           scarichi:         sum by (typename, format) (count_over_time({app="gema-web"} | json | request="GetFeature" | format!="" [7d]))
#                           errori GeoServer: sum by (status) (count_over_time({app="gema-web"} | json | path=~"/geoserver/.*" | status>=500 [1h]))
#
#   RATE_LIMIT=false      spegne il limite di richieste per client verso /geoserver/ (risposta 429 oltre il limite). Il client è
#                         l'indirizzo in X-Forwarded-For (dietro all'ingress) o quello della connessione. Limiti di default ampi:
#                         una mappa con più layer chiede decine di tile per spostamento, un cruscotto decine di conteggi.
#   GEOSERVER_RATE        letture, richieste al secondo per client (default 100r/s; anche al minuto, es. 3000r/m)
#   GEOSERVER_BURST       letture accettate di colpo oltre il ritmo (default 600)
#   GEOSERVER_WRITE_RATE  scritture (POST /geoserver/wfs: transazioni, salvataggi di configurazione, statistiche) (default 10r/s)
#   GEOSERVER_WRITE_BURST scritture accettate di colpo (default 40)
#
# Senza credenziali, l'header Authorization del browser (es. il Bearer di Keycloak) passa invariato.
# Il prefisso (/api/, /geoserver/) viene sostituito dal path dell'upstream.
# Se un upstream non è configurato, la route risponde 503 JSON invece di restituire index.html.
set -eu
DIR=/etc/nginx/proxy.d
OUT="$DIR/proxy.conf"
MAP="$DIR/auth.map"
umask 077
: > "$OUT"
: > "$MAP"

# formato del log delle richieste (vedi log_format in default.conf)
case "$(printf '%s' "${ACCESS_LOG_FORMAT:-text}" | tr 'A-Z' 'a-z')" in
  json) L_TEXT=0; L_JSON=1; echo "[proxy] log delle richieste in JSON" ;;
  text|"") L_TEXT=1; L_JSON=0 ;;
  *) L_TEXT=1; L_JSON=0; echo "[proxy] ACCESS_LOG_FORMAT ignorato (atteso text o json): ${ACCESS_LOG_FORMAT}" ;;
esac
printf 'map $host $mapp_log_text { default %s; }\nmap $host $mapp_log_json { default %s; }\n' "$L_TEXT" "$L_JSON" > "$DIR/log.map"

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

# ---------------------------------------------------------------- cache dei tile
TILES=0
TMAP="$DIR/tiles.map"
: > "$TMAP"
case "${TILE_CACHE:-false}" in
  true|TRUE|True|1|yes|YES)
    if [ "$READ_VAL" = '$http_authorization' ]; then
      echo "[proxy] TILE_CACHE ignorata: senza credenziali di lettura fisse (GEOSERVER_USER) i tile possono dipendere dall'utente"
    else
      TILES=1
      T_TTL="$(printf '%s' "${TILE_CACHE_TTL:-10m}" | tr 'A-Z' 'a-z')"
      printf '%s' "$T_TTL" | grep -Eq '^[1-9][0-9]{0,5}[smhd]$' || { echo "[proxy] TILE_CACHE_TTL ignorato (atteso es. 30s, 10m, 2h, 1d): ${TILE_CACHE_TTL}"; T_TTL=10m; }
      T_SIZE="$(printf '%s' "${TILE_CACHE_SIZE:-1g}" | tr 'A-Z' 'a-z')"
      printf '%s' "$T_SIZE" | grep -Eq '^[1-9][0-9]{0,5}[kmg]$' || { echo "[proxy] TILE_CACHE_SIZE ignorato (atteso es. 500m, 2g): ${TILE_CACHE_SIZE}"; T_SIZE=1g; }
      # a livello http: zona della cache e quali richieste/risposte vanno in cache
      cat > "$TMAP" <<CONF
proxy_cache_path /tmp/nginx-tiles levels=1:2 keys_zone=gs_tiles:20m max_size=${T_SIZE} inactive=${T_TTL} use_temp_path=off;
map "\$request_method:\$arg_request" \$gs_tile_getmap { default 0; "~*^(GET|HEAD):getmap\$" 1; }
map \$uri \$gs_tile_gwc { default 0; "~^/geoserver/gwc/" 1; }
map "\$gs_tile_getmap\$gs_tile_gwc" \$gs_tile_skip { default 1; "~1" 0; }
map \$upstream_http_content_type \$gs_tile_notimage { default 1; "~^image/" 0; }
CONF
      echo "[proxy] cache dei tile attiva: GetMap e GeoWebCache, durata ${T_TTL}, al massimo ${T_SIZE}"
    fi ;;
esac

# ---------------------------------------------------------------- limite di richieste per client
RATE=0
RMAP="$DIR/rate.map"
: > "$RMAP"
rate_ok() { printf '%s' "$1" | grep -Eq '^[1-9][0-9]{0,5}r/[sm]$'; }
burst_ok() { printf '%s' "$1" | grep -Eq '^[0-9]{1,6}$'; }
case "${RATE_LIMIT:-true}" in
  false|FALSE|False|0|no|NO|off|OFF) echo "[proxy] limite di richieste verso GeoServer spento (RATE_LIMIT=false)" ;;
  *)
    RATE=1
    R_RATE="${GEOSERVER_RATE:-100r/s}";        rate_ok "$R_RATE"   || { echo "[proxy] GEOSERVER_RATE ignorato (atteso es. 100r/s o 3000r/m): $R_RATE"; R_RATE=100r/s; }
    R_BURST="${GEOSERVER_BURST:-600}";         burst_ok "$R_BURST" || { echo "[proxy] GEOSERVER_BURST ignorato (atteso un numero): $R_BURST"; R_BURST=600; }
    W_RATE="${GEOSERVER_WRITE_RATE:-10r/s}";   rate_ok "$W_RATE"   || { echo "[proxy] GEOSERVER_WRITE_RATE ignorato (atteso es. 10r/s o 300r/m): $W_RATE"; W_RATE=10r/s; }
    W_BURST="${GEOSERVER_WRITE_BURST:-40}";    burst_ok "$W_BURST" || { echo "[proxy] GEOSERVER_WRITE_BURST ignorato (atteso un numero): $W_BURST"; W_BURST=40; }
    # a livello http: chiave per client (vuota = non conta) e zone; le scritture contano solo i POST
    cat > "$RMAP" <<CONF
map \$http_x_forwarded_for \$gs_client { default \$http_x_forwarded_for; "" \$binary_remote_addr; }
map \$request_method \$gs_write_client { default ""; POST \$gs_client; }
limit_req_zone \$gs_client zone=gs_read:10m rate=${R_RATE};
limit_req_zone \$gs_write_client zone=gs_write:5m rate=${W_RATE};
CONF
    echo "[proxy] limite per client verso GeoServer: letture ${R_RATE} (raffiche di ${R_BURST}), scritture ${W_RATE} (raffiche di ${W_BURST}), poi 429" ;;
esac
rate_lines() { # $1 = "w" per la location delle scritture
  [ "$RATE" = 1 ] || return 0
  echo "  limit_req zone=gs_read burst=${R_BURST} nodelay;"
  [ "$1" = w ] && echo "  limit_req zone=gs_write burst=${W_BURST} nodelay;"
  echo "  limit_req_status 429;"
  echo "  limit_req_log_level warn;"
}

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
      rate_lines r
      echo "  proxy_pass $UP/;"
      common "$UP_HOSTPORT" "$SSL_LINES"
      echo '  proxy_set_header Authorization $gs_auth;'
      if [ "$TILES" = 1 ]; then
        # la chiave è l'URL: filtro, data, stile e il contatore _r (dopo una modifica) danno tile diversi
        echo "  proxy_cache gs_tiles;"
        echo '  proxy_cache_key "$request_uri";'
        echo "  proxy_cache_valid 200 ${T_TTL};"
        echo '  proxy_cache_bypass $gs_tile_skip;'
        echo '  proxy_no_cache $gs_tile_skip $gs_tile_notimage;'
        echo "  proxy_cache_lock on;"
        echo "  proxy_cache_lock_timeout 10s;"
        echo "  proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;"
        echo "  proxy_cache_background_update on;"
        echo "  proxy_ignore_headers Cache-Control Expires Set-Cookie;"
        echo "  proxy_hide_header Set-Cookie;"
      fi
      echo "}"
    } >> "$OUT"
    echo "[proxy] $1 -> $UP/ (sola lettura)"
    if [ "$EDIT" = 1 ]; then
      {
        echo "location = ${1}wfs {"                    # l'unico endpoint scrivibile: transazioni WFS-T
        echo "  limit_except GET POST { deny all; }"
        echo "  client_max_body_size 10m;"
        rate_lines w
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
