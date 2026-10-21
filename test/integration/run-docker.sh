#!/bin/sh
# Test di integrazione in Docker: avvia PostGIS e GeoServer (docker-compose.yml), esegue i test e ferma i container.
#   KEEP=1                  lascia i container accesi alla fine
#   INT_PGPORT, INT_GSPORT  porte sull'host (default 55432 e 58080)
#   argomenti               passati a vitest (es. un solo file: sh test/integration/run-docker.sh catalog)
set -eu
cd "$(dirname "$0")/../.."
export INT_PGPORT="${INT_PGPORT:-55432}" INT_GSPORT="${INT_GSPORT:-58080}"
COMPOSE="docker compose -f test/integration/docker-compose.yml -p mapp-int"

command -v psql >/dev/null || { echo "[int] serve psql sull'host (client PostgreSQL)" >&2; exit 2; }
# security.int.test.ts avvia nginx con la build, come nell'immagine
[ -f dist/index.html ] || npm run build
cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then echo "[int] container lasciati accesi (KEEP=1): $COMPOSE down -v per fermarli"
  else $COMPOSE down -v >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT INT TERM

echo "[int] avvio PostGIS e GeoServer ..."
$COMPOSE up -d --wait

export INT_REQUIRE=1
export INT_PGHOST=127.0.0.1 INT_PG_ADMIN_USER=postgres INT_PG_ADMIN_PASSWORD=pgadmin
export INT_GEOSERVER_URL="http://127.0.0.1:${INT_GSPORT}/geoserver" INT_GEOSERVER_USER=admin INT_GEOSERVER_PASSWORD=geoserver
# GeoServer raggiunge PostgreSQL sulla rete di compose, con il nome del servizio
export INT_DS_DB_HOST=postgis INT_DS_DB_PORT=5432

npx vitest run --config vitest.integration.config.ts "$@"
