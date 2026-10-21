# Test di integrazione

Verificano i pezzi che i test unitari e gli e2e (con GeoServer finto) non possono coprire, contro **servizi reali**:

| File | Servizi | Cosa verifica |
|---|---|---|
| `db.int.test.ts` | PostgreSQL + PostGIS | `init-db.sh` e `mapp-config.sql` della ConfigMap del chart: tabelle, indici, idempotenza, diritti minimi dell'utente applicativo, vincoli, cambio password, errori |
| `geoserver.int.test.ts` | GeoServer + PostGIS | `publish-geoserver.sh` (workspace, datastore, layer, idempotenza, errori) e il codice dell'app (`configStore`, `api`, `capabilities`) su WFS/WFS-T reali |
| `download.int.test.ts` | GeoServer + PostGIS | scarico dei dati con le funzioni dell'app: GeoJSON (filtro, area, lon/lat), CSV e Shapefile con accenti in UTF-8, tetto agli oggetti, GeoTIFF via WCS 2.0 ritagliato e georeferenziato, errori |
| `catalog.int.test.ts` | PostgreSQL (+ GeoServer) | tabelle `catalog_folders` / `catalog_layers` create da `init-db.sh` (colonne, vincoli, idempotenza, aggiornamento di un'installazione precedente, diritti dell'utente applicativo); con GeoServer: pubblicazione e `loadCatalog` / `saveCatalog` dell'app, tipi, transazione unica tutto-o-niente, conflitti |
| `roleviews.int.test.ts` | PostgreSQL (+ GeoServer) | tabella `role_views` (formato dell'area, ruolo unico, aggiornamento, diritti); con GeoServer: regola e vista salvate, modificate ed eliminate insieme in un'unica transazione |
| `forms.int.test.ts` | PostgreSQL (+ GeoServer) | tabella `edit_forms` (un modulo per layer, diritti, aggiornamento); con GeoServer: moduli salvati, riletti per layer (apici e accenti), aggiornati e ripristinati |
| `announcements.int.test.ts` | PostgreSQL (+ GeoServer) | tabella `announcements` (livelli, date, manutenzione non chiudibile, diritti, aggiornamento); con GeoServer: avvisi salvati, riletti (booleani e date), modificati ed eliminati |
| `dashio.int.test.ts` | GeoServer + PostGIS | dashboard esportate e reimportate (sostituzione e aggiunta) con il JSON identico; importazione tutto-o-niente se una riga è rifiutata |
| `widgets.int.test.ts` | GeoServer + PostGIS | dati dei widget dal WFS vero (solo gli attributi necessari, date e numeri di GeoServer): torta, linea per mese, tabella ordinata, indicatore con filtro CQL |
| `filters.int.test.ts` | GeoServer + PostGIS | filtri globali delle dashboard: periodo con fine compresa su colonne `date` e `timestamp`, BBOX sulla geometria letta dallo schema, combinazione con il filtro del widget |
| `drafts.int.test.ts` | PostgreSQL; GeoServer + PostGIS | bozze delle dashboard: tabella `dashboard_drafts` (titolo obbligatorio, una bozza per dashboard pubblicata, più bozze nuove), diritti, script rieseguibile; salva bozza, pubblica con l'id restituito da GeoServer e la bozza eliminata nella stessa transazione, scarta, elimina tutto |
| `diagnostics.int.test.ts` | GeoServer + PostGIS | pagina di diagnostica: capabilities, schema e lettura di tutte le tabelle pubblicate dal Job (colonne attese), tabella non pubblicata riconosciuta, prova di scrittura accettata senza cambiare righe |
| `changelog.int.test.ts` | PostgreSQL; GeoServer + PostGIS | registro modifiche: trigger su tutte le tabelle di configurazione (non su viste salvate e bozze), riga prima/dopo e autore, solo-timbro ignorato, registro in sola lettura per l'utente applicativo, Job rieseguibile, conservazione `CHANGE_LOG_DAYS`; via GeoServer: autore dell'eliminazione, ripristino di una versione, registro non scrivibile via WFS-T |
| `usage.int.test.ts` | PostgreSQL; GeoServer + PostGIS | statistiche d'uso: `usage_events` (vincoli, utente applicativo che può solo aggiungere), viste aggregate per giorno/oggetto/ruolo/utente, Job rieseguibile, conservazione `USAGE_DAYS`; via GeoServer: il tracker inserisce gli eventi e la pagina li legge dalle viste |
| `backup.int.test.ts` | GeoServer + PostGIS | backup e ripristino: configurazione letta ed esportata, cambiata, poi ripristinata in un'unica transazione (sostituzione); dopo il ripristino ogni sezione è identica al backup |
| `vectortiles.int.test.ts` | GeoServer + PostGIS | conteggio esatto (resultType=hits) di un layer oltre il limite dei widget; se GeoServer ha l'estensione vectortiles, GetMap in MVT con layer e attributi letti dal tile |
| `security.int.test.ts` | nginx | configurazione generata da 35/40/45 + `default.conf` con nginx vero: ogni combinazione di CSP, `CLIENT_ERRORS`, `RATE_LIMIT`, cache e geocoder passa `nginx -t`; intestazioni di sicurezza su ogni location; segnalazione del browser nel log JSON con il corpo intatto, senza cookie né token, senza toccare l'upstream; 429 oltre il limite per client (letture e scritture) e l'upstream vede solo le richieste ammesse |
| `tiles.int.test.ts` | GeoServer + PostGIS + nginx | cache dei tile davanti a GeoServer vero: HIT/MISS su un layer PostGIS pubblicato per il test, cookie, eccezioni WMS, FeatureInfo, legende |

Gli script vengono letti da `charts/templates/geoserver-configuration/configmap.yaml`: si prova esattamente ciò che gira nel Job.

## Come eseguirli

Tutto in Docker (consigliato, è quello che fa la CI):

```sh
npm run test:integration:docker
```

Avvia PostGIS e GeoServer con `test/integration/docker-compose.yml`, esegue i test e ferma i container. `KEEP=1` li lascia accesi.
Servono docker con compose, `psql` e nginx (per `tiles.int.test.ts` e `security.int.test.ts`, che usa anche la build in `dist/`: lo script la crea se manca).

Contro servizi già esistenti:

```sh
INT_PGHOST=127.0.0.1 INT_PGPORT=5432 INT_PG_ADMIN_USER=postgres INT_PG_ADMIN_PASSWORD=... \
INT_GEOSERVER_URL=http://localhost:8080/geoserver INT_GEOSERVER_USER=admin INT_GEOSERVER_PASSWORD=... \
INT_DS_DB_HOST=postgres-visto-da-geoserver \
npm run test:integration
```

| Variabile | Significato |
|---|---|
| `INT_PGHOST`, `INT_PGPORT`, `INT_PG_ADMIN_USER`, `INT_PG_ADMIN_PASSWORD` | PostgreSQL con un utente che può creare database e ruoli |
| `INT_GEOSERVER_URL`, `INT_GEOSERVER_USER`, `INT_GEOSERVER_PASSWORD` | GeoServer con un utente amministratore (REST) |
| `INT_DS_DB_HOST`, `INT_DS_DB_PORT` | PostgreSQL come lo raggiunge GeoServer (default: `INT_PGHOST`, 5432) |
| `INT_PUBLISH=false` | il workspace esiste già (es. GeoServer di sviluppo): niente database né pubblicazione, solo i test dell'app; con `INT_WORKSPACE` |
| `INT_REQUIRE=1` | un servizio non configurato fa fallire i test invece di saltarli (in CI) |

Ogni esecuzione crea database, utenti e workspace con nomi univoci e li rimuove alla fine. Con `INT_PUBLISH=false` vengono
rimosse solo le righe create dai test.

Senza variabili, `npm run test:integration` salta tutto: non serve nulla per i test unitari.
Con il solo PostgreSQL (`INT_PG*`) girano le parti che non richiedono GeoServer (es. le tabelle del catalogo).
