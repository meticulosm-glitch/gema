#!/bin/sh
# Metriche per Prometheus. nginx conta richieste, stati, byte e tempi di risposta (dell'intera richiesta, dell'upstream e di
# GeoServer per tipo di richiesta OGC) in una memoria condivisa e li espone su una porta dedicata, separata da quella
# dell'app: il Service la espone dentro al cluster, la rotta APISIX no, quindi da fuori /metrics non si raggiunge.
#
#   METRICS=false    spegne le metriche (default true)
#   METRICS_PORT     porta delle metriche (default 9145), GET /metrics. Anche indirizzo:porta (es. 127.0.0.1:9145).
#                    Sulla porta dell'app (8080) /metrics risponde 404.
#
# Metriche (prefisso gema_):
#   gema_http_requests_total{route,method,status}           richieste per area (app, assets, config, static, geoserver,
#                                                            geocode, api), metodo e stato; 429 = respinte dai limiti per client
#   gema_http_request_duration_seconds{route}               istogramma della durata delle richieste (da 5 ms a 60 s)
#   gema_http_response_bytes_total{route}                   byte inviati
#   gema_upstream_response_duration_seconds{route}          istogramma del tempo di risposta di GeoServer, geocoder e backend
#   gema_geoserver_requests_total{request,status}           richieste verso GeoServer per tipo (GetMap, GetFeature, Transaction, gwc, ...)
#   gema_geoserver_request_duration_seconds{request}        istogramma della durata per tipo di richiesta OGC
#   gema_tile_cache_requests_total{status}                  esiti della cache dei tile (HIT, MISS, BYPASS, ...)
#   gema_nginx_connections{state}, gema_nginx_connections_accepted_total, gema_nginx_connections_handled_total,
#   gema_nginx_requests_total                               connessioni e richieste di nginx (stub_status)
#   gema_metrics_zone_free_bytes, gema_metrics_zone_size_bytes   spazio della memoria condivisa delle metriche
# Esempi PromQL:
#   tempo al 95° percentile delle GetMap:  histogram_quantile(0.95, sum by (le) (rate(gema_geoserver_request_duration_seconds_bucket{request="GetMap"}[5m])))
#   errori di GeoServer al secondo:        sum(rate(gema_geoserver_requests_total{status=~"5.."}[5m]))
#   quota di tile dalla cache:             sum(rate(gema_tile_cache_requests_total{status="HIT"}[5m])) / sum(rate(gema_tile_cache_requests_total[5m]))
#
# Serve il modulo njs di nginx, presente nell'immagine (nginx-unprivileged): se manca, le metriche restano spente e lo
# script lo dice. Le etichette hanno solo valori da insiemi chiusi: il dettaglio per layer resta nel log JSON (Loki).
set -eu
DIR=/etc/nginx/proxy.d
MODULE=/etc/nginx/modules/ngx_http_js_module.so
NJS=/etc/nginx/njs/metrics.js
MAIN="$DIR/metrics.main"   # contesto principale di nginx.conf (load_module)
HTTP="$DIR/metrics.map"    # contesto http: zona condivisa, funzioni njs, server delle metriche
INC="$DIR/metrics.inc"     # server dell'app: la riga di log che registra ogni richiesta
LOC="$DIR/metrics.conf"    # server dell'app: /metrics -> 404
umask 022
: > "$MAIN"
: > "$HTTP"
: > "$INC"
# sulla porta dell'app /metrics non esiste: senza questa location risponderebbe index.html (e Prometheus non capirebbe)
printf 'location = /metrics {\n  access_log off;\n  return 404;\n}\n' > "$LOC"

ON=1
case "${METRICS:-true}" in false|FALSE|False|0|no|NO|off|OFF) ON=0 ;; esac

port_ok() { # porta 1-65535, eventualmente preceduta da un indirizzo IPv4; una sola riga
  case "$1" in *"
"*) return 1 ;; esac
  printf '%s' "$1" | grep -Eq '^([0-9]{1,3}(\.[0-9]{1,3}){3}:)?[1-9][0-9]{0,4}$' && [ "${1##*:}" -le 65535 ]
}
M_PORT="${METRICS_PORT:-9145}"
if ! port_ok "$M_PORT"; then
  echo "[metrics] METRICS_PORT ignorata (attesa una porta, es. 9145, oppure indirizzo:porta): ${METRICS_PORT}"
  M_PORT=9145
fi
if [ "${M_PORT##*:}" = 8080 ]; then
  echo "[metrics] METRICS_PORT ignorata: 8080 è la porta dell'app, le metriche devono stare su una porta separata"
  M_PORT=9145
fi

if [ "$ON" = 0 ]; then
  echo "[metrics] metriche spente (METRICS=false)"
elif [ ! -r "$MODULE" ]; then
  echo "[metrics] ATTENZIONE: modulo njs di nginx non trovato ($MODULE): metriche spente"
elif [ ! -r "$NJS" ]; then
  echo "[metrics] ATTENZIONE: $NJS non trovato: metriche spente"
else
  echo "load_module $MODULE;" > "$MAIN"
  cat > "$HTTP" <<CONF
# metriche per Prometheus (50-metrics-config.sh): contatori e istogrammi condivisi tra i worker
js_import gema_metrics from $NJS;
js_shared_dict_zone zone=gema_metrics:4m type=number;
js_set \$gema_metrics_record gema_metrics.record;
log_format gema_metrics '-';

server {
  listen $M_PORT;
  server_name _;
  access_log off;
  default_type text/plain;

  location = /metrics {
    limit_except GET { deny all; }
    js_fetch_timeout 2s;
    js_content gema_metrics.render;
  }
  # connessioni di nginx, lette da /metrics
  location = /stub_status {
    stub_status;
  }
  location / {
    return 404;
  }
}
CONF
  # la condizione chiama gema_metrics.record a fine richiesta e vale sempre "": la riga non viene mai scritta
  echo 'access_log /dev/null gema_metrics if=$gema_metrics_record;' > "$INC"
  echo "[metrics] metriche Prometheus su :${M_PORT##*:}/metrics (richieste, stati, tempi di risposta, GeoServer per richiesta OGC, cache dei tile)"
fi
