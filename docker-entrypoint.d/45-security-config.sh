#!/bin/sh
# Sicurezza del server web e segnalazione degli errori del browser. Gira dopo 40-runtime-config.sh: legge config.json
# (anche se montato da una ConfigMap) per sapere da quali server la pagina carica tile, loghi e login.
#
#   CSP                   Content-Security-Policy: enforce (default), report-only oppure off. Consente solo questo sito
#                         più le origini che compaiono in config.json (Keycloak, sfondi, rilievo 3D, loghi, GeoServer o API
#                         se non passano dal proxy). Le violazioni arrivano a /csp-report e finiscono nel log (Loki).
#   CSP_EXTRA_ORIGINS     altre origini da consentire, separate da spazio o virgola (es. https://cdn.example.org): servono
#                         per servizi esterni che non compaiono in config.json
#   FRAME_ANCESTORS       siti che possono incorporare l'applicazione in un iframe (origini separate da spazio o virgola).
#                         Default: nessuno, solo lo stesso sito (X-Frame-Options SAMEORIGIN, frame-ancestors 'self').
#   CLIENT_ERRORS=false   spegne /client-errors: senza, il browser manda qui i propri errori JavaScript (messaggio, pila,
#                         pagina, versione) e nginx li scrive su stdout in JSON con "type":"client-error", pronti per Loki.
#                         Corpo al massimo 16 kB, 1 richiesta al secondo per client (raffiche di 20).
#
# Le intestazioni di sicurezza (nosniff, Referrer-Policy, X-Frame-Options, Permissions-Policy, CSP) stanno in
# security.inc, incluso dal server e da ogni location che aggiunge intestazioni proprie (in nginx una location con
# add_header non eredita quelle del server).
set -eu
DIR=/etc/nginx/proxy.d
CONF=/usr/share/nginx/html/config.json
INC="$DIR/security.inc"
MAP="$DIR/security.map"
LOC="$DIR/security.conf"
umask 022
: > "$MAP"
: > "$LOC"

# ---------------------------------------------------------------- origini dalla configurazione
# ogni URL assoluto in config.json -> origine (schema://host[:porta]); "{s}." nei tile -> "*." (sottodomini a rotazione)
ORIGINS=""
if [ -r "$CONF" ]; then
  ORIGINS="$(grep -o '"https\?://[^"]*"' "$CONF" | tr -d '"' | sed -E 's#^(https?://[^/?#]+).*#\1#' | sed -E 's#\{[a-z-]+\}\.#*.#g' | grep -E '^https?://[A-Za-z0-9*.:-]+$' | sort -u | tr '\n' ' ')"
fi
# senza un elenco di sfondi (BASEMAPS) l'app offre anche satellite e scuro: stessi server di defaultBasemaps in src/basemaps.ts
PRESET_ORIGINS="https://server.arcgisonline.com https://a.basemaps.cartocdn.com"
if [ ! -r "$CONF" ] || ! grep -q '"basemaps"[[:space:]]*:[[:space:]]*\[[[:space:]]*{' "$CONF"; then ORIGINS="$ORIGINS $PRESET_ORIGINS"; fi
for o in $(printf '%s' "${CSP_EXTRA_ORIGINS:-}" | tr ',' ' '); do
  case "$o" in http://*|https://*) ORIGINS="$ORIGINS $(printf '%s' "$o" | sed -E 's#^(https?://[^/?#]+).*#\1#')" ;; *) echo "[security] CSP_EXTRA_ORIGINS: '$o' ignorata (serve http:// o https://)" ;; esac
done
ORIGINS="$(printf '%s\n' $ORIGINS | sort -u | tr '\n' ' ' | sed 's/ $//')"

ANCESTORS=""
for o in $(printf '%s' "${FRAME_ANCESTORS:-}" | tr ',' ' '); do
  case "$o" in http://*|https://*) ANCESTORS="$ANCESTORS $(printf '%s' "$o" | sed -E 's#^(https?://[^/?#]+).*#\1#')" ;; *) echo "[security] FRAME_ANCESTORS: '$o' ignorata (serve http:// o https://)" ;; esac
done

CSP_MODE="$(printf '%s' "${CSP:-enforce}" | tr 'A-Z' 'a-z')"
case "$CSP_MODE" in enforce|report-only|off) ;; *) echo "[security] CSP=${CSP} non riconosciuta (enforce|report-only|off): uso enforce"; CSP_MODE=enforce ;; esac

POLICY="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: ${ORIGINS}; connect-src 'self' ${ORIGINS}; font-src 'self' data:; worker-src 'self' blob:; child-src 'self' blob:; frame-src ${ORIGINS:-'none'}; frame-ancestors 'self'${ANCESTORS}; form-action 'self' ${ORIGINS}; base-uri 'self'; object-src 'none'; report-uri /csp-report"
POLICY="$(printf '%s' "$POLICY" | tr -s ' ' | sed 's/ ;/;/g')"

{
  echo 'add_header X-Content-Type-Options "nosniff" always;'
  echo 'add_header Referrer-Policy "strict-origin-when-cross-origin" always;'
  # X-Frame-Options non sa elencare siti: con FRAME_ANCESTORS decide solo frame-ancestors della CSP
  [ -z "$ANCESTORS" ] && echo 'add_header X-Frame-Options "SAMEORIGIN" always;'
  # la posizione serve al pulsante "dove sono"; fotocamera, microfono, pagamenti e simili mai
  echo 'add_header Permissions-Policy "geolocation=(self), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()" always;'
  case "$CSP_MODE" in
    enforce)     echo "add_header Content-Security-Policy \"$POLICY\" always;" ;;
    report-only) echo "add_header Content-Security-Policy-Report-Only \"$POLICY\" always;" ;;
  esac
} > "$INC"
case "$CSP_MODE" in
  off) echo "[security] CSP spenta (CSP=off)" ;;
  *)   echo "[security] CSP ${CSP_MODE}: origini esterne consentite: ${ORIGINS:-nessuna}" ;;
esac
[ -n "$ANCESTORS" ] && echo "[security] l'applicazione può essere incorporata da:${ANCESTORS}"
[ -n "$ANCESTORS" ] && [ "$CSP_MODE" != enforce ] && echo "[security] ATTENZIONE: FRAME_ANCESTORS senza CSP=enforce: nessuna protezione contro l'incorporamento da altri siti"
true

# ---------------------------------------------------------------- errori del browser e violazioni CSP -> log JSON
CLIENT=1
case "${CLIENT_ERRORS:-true}" in false|FALSE|False|0|no|NO|off|OFF) CLIENT=0 ;; esac
if [ "$CLIENT" = 1 ] || [ "$CSP_MODE" != off ]; then
  cat > "$MAP" <<'CONF'
# segnalazioni dal browser: una riga JSON per segnalazione (il corpo è quello mandato dal browser, già JSON, con escape)
log_format client_json escape=json '{"type":"$client_report_type","time":"$time_iso8601","status":$status,"remote":"$remote_addr","ua":"$http_user_agent","report":"$request_body"}';
map $uri $client_report_type { default "client-error"; /csp-report "csp-violation"; }
map $http_x_forwarded_for $security_client { default $http_x_forwarded_for; "" $binary_remote_addr; }
limit_req_zone $security_client zone=client_reports:1m rate=1r/s;
CONF
  # il corpo si legge solo passando la richiesta a un upstream: un sink interno che risponde 204
  report_location() { # $1 = percorso
    cat <<CONF
location = $1 {
  limit_except POST { deny all; }
  limit_req zone=client_reports burst=20 nodelay;
  limit_req_status 429;
  client_max_body_size 16k;
  client_body_buffer_size 16k;
  access_log /dev/stdout client_json;
  proxy_pass http://127.0.0.1:\$server_port/__report-sink;
  proxy_set_header Authorization "";
  proxy_set_header Cookie "";
}
CONF
  }
  {
    if [ "$CLIENT" = 1 ]; then report_location /client-errors; fi
    if [ "$CSP_MODE" != off ]; then report_location /csp-report; fi
    cat <<'CONF'
location = /__report-sink {
  allow 127.0.0.1;
  deny all;
  access_log off;
  return 204;
}
CONF
  } > "$LOC"
  if [ "$CLIENT" = 1 ]; then echo "[security] /client-errors attivo: errori del browser nel log JSON (type=client-error)"; fi
else
  echo "[security] segnalazioni dal browser spente"
fi
