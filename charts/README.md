<p align="center">
  <picture>
    <!-- il logo dell'intestazione ha il testo chiaro: su sfondo chiaro si usa il solo simbolo -->
    <source media="(prefers-color-scheme: dark)" srcset="../public/logos/gema-logo-header.svg">
    <img src="../public/logos/gema-favicon.svg" alt="G.E.M.A." height="56">
  </picture>
</p>

# Chart Helm di G.E.M.A.

Questo chart installa G.E.M.A. su Kubernetes: l'applicazione (nginx), l'autenticazione opzionale con oauth2-proxy, la
rotta APISIX, i secret da Vault e il Job che prepara database e GeoServer. Le funzionalità dell'app sono descritte nel
[README principale](../README.md).

## Indice

- [Cosa installa](#cosa-installa)
- [Installazione](#installazione)
- [Valori del chart](#valori-del-chart)
- [Secret attesi in Vault](#secret-attesi-in-vault)
- [Variabili d'ambiente dell'applicazione](#variabili-dambiente-dellapplicazione)
  - [Autenticazione e ruoli](#autenticazione-e-ruoli)
  - [GeoServer e proxy](#geoserver-e-proxy)
  - [Mappa e sfondi](#mappa-e-sfondi)
  - [Aspetto](#aspetto)
  - [Ricerca di luoghi](#ricerca-di-luoghi)
  - [Editing e scarico dati](#editing-e-scarico-dati)
  - [Cache e prestazioni](#cache-e-prestazioni)
  - [Limiti per client](#limiti-per-client)
  - [Sicurezza](#sicurezza)
  - [Log, errori e statistiche](#log-errori-e-statistiche)
- [Job di inizializzazione](#job-di-inizializzazione)
- [Esempio di values per un ambiente](#esempio-di-values-per-un-ambiente)
- [Prerequisiti in GeoServer e Vault](#prerequisiti-in-geoserver-e-vault)

## Cosa installa

| Risorsa | Template | Note |
|---|---|---|
| Deployment | `deployment.yaml` | container `geolibre` (nginx + app, porta 8080) e, con `auth.enabled`, il sidecar `oauth2-proxy` (porta 4180). Volumi `emptyDir`: `/data` e `/tmp/nginx-tiles` (cache dei tile) |
| Service | `service.yaml` | porta `service.port` verso nginx (`service.targetPort`) oppure, con `auth.enabled`, verso oauth2-proxy (4180) |
| ApisixRoute | `apisixroute.yaml` | tutto il traffico di `apisixRoute.host` verso il Service (solo con `apisixRoute.enabled`) |
| ExternalSecret | `external-secret.yaml` | secret `eso.existingSecret` con le chiavi `eso.secrets`, caricato nell'app con `envFrom` |
| ExternalSecret | `auth-external-secret.yaml` | secret `auth.existingSecret` di oauth2-proxy (solo con `auth.enabled` e `auth.createSecret`) |
| ConfigMap | `geoserver-configuration/configmap.yaml` | `<rilascio>-geolibre-config-init`: `mapp-config.sql`, `init-db.sh`, `publish-geoserver.sh` |
| Job | `geoserver-configuration/job.yaml` | `<rilascio>-geolibre-config-init`: hook di Sync di ArgoCD, crea le tabelle in PostgreSQL e le pubblica in GeoServer |
| ExternalSecret | `geoserver-configuration/external-secret.yaml` | `<rilascio>-geolibre-config-db` (utenze del database) e `<rilascio>-geolibre-config-geoserver` (amministratore di GeoServer), sync-wave `-1` |

Ordine con ArgoCD: secret (wave `-1`), ConfigMap, Job (wave `1`, ricreato a ogni sync), Deployment.

I nomi seguono il rilascio (`<rilascio>-geolibre`, accorciato se il rilascio contiene già `geolibre`): due installazioni
nello stesso namespace non si scontrano.

## Installazione

```sh
helm upgrade --install gema ./charts \
  -f charts/values.yaml \
  -f charts/environments/dev/values.yaml \
  -n gema --create-namespace
```

`charts/values.yaml` contiene i valori comuni; `charts/environments/<ambiente>/values.yaml` quelli dell'ambiente
(host, URL di Keycloak). Le variabili d'ambiente dell'app si aggiungono con `env` (comuni) ed `extraEnv` (per ambiente):
le due liste vengono unite per nome, e a parità di nome vince `extraEnv`.

## Valori del chart

| Valore | Default | Descrizione |
|---|---|---|
| `environment` | — | nome dell'ambiente (informativo, nei values dell'ambiente) |
| `replicaCount` | `1` | repliche del Deployment. Con più repliche la cache dei tile è per replica |
| `image.repository` | `registry.gema.example.it` | immagine dell'app |
| `image.tag` | `"dev"` | tag dell'immagine |
| `image.pullPolicy` | `Always` | |
| `imagePullSecrets` | `[{name: credential-registry}]` | secret per il registry |
| `env` | vedi `values.yaml` | variabili d'ambiente dell'app, comuni a tutti gli ambienti ([elenco completo](#variabili-dambiente-dellapplicazione)) |
| `extraEnv` | — | variabili d'ambiente in più o che sostituiscono quelle di `env` con lo stesso nome (per ambiente) |
| `service.type` | `ClusterIP` | |
| `service.port` | `80` | porta del Service, usata anche dalla rotta APISIX |
| `service.targetPort` | `8080` | porta di nginx verso cui va il traffico; con `auth.enabled` il Service punta invece a oauth2-proxy (4180), che inoltra a nginx |
| `auth.enabled` | `false` | aggiunge il sidecar oauth2-proxy davanti a nginx (login a livello di rete, oltre a quello dell'app) |
| `auth.image` | `quay.io/oauth2-proxy/oauth2-proxy:v7.9.0` | immagine di oauth2-proxy |
| `auth.issuerUrl` | `""` | issuer OIDC di Keycloak (`https://keycloak/realms/<realm>`); **obbligatorio** con `auth.enabled` (senza, il chart non si rende) |
| `auth.clientId` | `myclient` | client Keycloak di oauth2-proxy |
| `auth.clientRole` | `mykeycloak-role` | client role richiesto per passare (`--allowed-role=<clientId>:<clientRole>`) |
| `auth.existingSecret` | `gema-oidc` | secret con `OIDC_CLIENT_SECRET` e `OAUTH2_PROXY_COOKIE_SECRET` |
| `auth.createSecret` | `true` | crea `auth.existingSecret` da Vault (proprietà `OIDC_CLIENT_SECRET`, `OAUTH2_PROXY_COOKIE_SECRET`); `false` se il secret esiste già |
| `auth.resources` | 25m/32Mi, limiti 200m/128Mi | risorse del sidecar |
| `apisixRoute.enabled` | `true` | crea la ApisixRoute |
| `apisixRoute.host` | — | host pubblico dell'app (es. `gema.example.it`); con `auth.enabled` il redirect di oauth2-proxy è `https://<host>/oauth2/callback` |
| `resources` | 100m/256Mi, limiti 1 CPU/1Gi | risorse del container dell'app |
| `eso.secretStoreName` | `existingsecretstore` | ClusterSecretStore di External Secrets |
| `eso.path` | `vaultpath/gema/secret` | percorso in Vault di tutti i secret |
| `eso.existingSecret` | `gema-secret` | nome del Secret creato per l'app |
| `eso.secrets` | `GEOSERVER_USER` ← `GEOSERVER_READ_USER`, `GEOSERVER_PASSWORD` ← `GEOSERVER_READ_PASSWORD` | variabili d'ambiente dell'app prese da Vault. Ogni voce è `NOME` (stessa proprietà in Vault) oppure `{key: NOME, property: proprietà}` |
| `postgres.host` | `postgres.svc.cluster.local` | host PostgreSQL usato dal Job (e dal datastore di GeoServer) |
| `configJob.geoserverUrl` | `http://mapp-enterprise-lot1-geoserver/geoserver` | URL interno di GeoServer per la REST API del Job (obbligatorio) |
| `configJob.aclReadRoles` | `""` | ruoli GeoServer che leggono la configurazione, separati da virgola. Vuoto = `ROLE_` + `VIEWER_ROLE`, `ADMIN_ROLE` e `KNOWN_ROLES` dell'app, in maiuscolo |
| `configJob.aclWriteRoles` | `""` | ruoli GeoServer che scrivono la configurazione. Vuoto = `ROLE_` + `ADMIN_ROLE` |
| `configJob.aclViewsWriteRoles` | `""` | chi salva le viste (`saved_views`). Vuoto = come `configJob.aclReadRoles` |
| `nodeSelector`, `tolerations`, `affinity` | vuoti | posizionamento dei pod |
| `changeLogDays` | `0` | giorni di registro modifiche da conservare (`0` = per sempre); il Job pulisce a ogni esecuzione |
| `usageDays` | `180` | giorni di statistiche d'uso da conservare (`0` = per sempre) |
| `tileCacheSizeLimit` | `2Gi` | dimensione del volume della cache dei tile; `TILE_CACHE_SIZE` deve restare sotto questo limite |

## Secret attesi in Vault

Tutte le proprietà si leggono da `eso.path`.

| Proprietà in Vault | Secret Kubernetes | Chiave | Chi la usa |
|---|---|---|---|
| `GEOSERVER_READ_USER`, `GEOSERVER_READ_PASSWORD` | `gema-secret` | `GEOSERVER_USER`, `GEOSERVER_PASSWORD` | app: utente GeoServer di **sola lettura** che nginx aggiunge alle letture (vedi [prerequisiti](#prerequisiti-in-geoserver-e-vault)) |
| `OIDC_CLIENT_SECRET`, `OAUTH2_PROXY_COOKIE_SECRET` | `auth.existingSecret` (`gema-oidc`) | stesso nome | oauth2-proxy, solo con `auth.enabled` |
| `gema_db_user`, `gema_db_password` | `<rilascio>-geolibre-config-db` | `user`, `password` | Job: utenza del datastore se mancano `gs_user`/`gs_password` |
| `geoserver_db_user`, `geoserver_db_password` | `<rilascio>-geolibre-config-db` | `gs_user`, `gs_password` | Job: utente applicativo di PostgreSQL usato dal datastore di GeoServer (creato se manca, con i soli diritti sulle tabelle) |
| `PG_ADMIN_USER`, `PG_ADMIN_PASSWORD` | `<rilascio>-geolibre-config-db` | stesso nome | Job: amministratore PostgreSQL (crea database, schema, tabelle, utente applicativo) |
| `GEOSERVER_USER`, `GEOSERVER_PASSWORD` | `<rilascio>-geolibre-config-geoserver` | `user`, `password` | Job: amministratore di GeoServer per la REST API (workspace, datastore, layer, regole dati) |

Facoltativa nel secret `<rilascio>-geolibre-config-db`: la chiave `port` (porta PostgreSQL, default 5432).

## Variabili d'ambiente dell'applicazione

Si impostano in `env` / `extraEnv`. I valori booleani accettano `true`, `1`, `yes` (e `false`, `0`, `no`, `off`).
Le variabili che finiscono in `config.json` non hanno effetto se `config.json` è montato già pronto in
`/usr/share/nginx/html/config.json`; quelle di nginx (proxy, cache, limiti, sicurezza) valgono sempre.

Script che le leggono: **35** = `35-proxy-config.sh` (nginx: proxy e limiti), **40** = `40-runtime-config.sh`
(`config.json`), **45** = `45-security-config.sh` (nginx: sicurezza).

### Autenticazione e ruoli

| Variabile | Default | Script | Descrizione |
|---|---|---|---|
| `AUTH_ENABLED` | `true` | 40 | `false` disattiva il login Keycloak (e quindi ruoli e pagine admin) |
| `KEYCLOAK_URL` | — | 40 | URL di Keycloak (es. `https://auth.example.it`); obbligatoria con il login attivo |
| `KEYCLOAK_REALM` | — | 40 | realm; obbligatoria con il login attivo |
| `KEYCLOAK_CLIENT_ID` | — | 40 | client pubblico dell'app (PKCE); obbligatoria con il login attivo |
| `ACCESS_CONTROL` | `false` | 35, 40 | attiva ruoli, permessi, pagine admin e dashboard per ruolo; consente le POST su `/geoserver/wfs` per salvare la configurazione. Ignorata senza login |
| `ADMIN_ROLE` | `fss-etl-admin` | 40 | client role dell'amministratore (vede tutto e apre il menu Admin) |
| `VIEWER_ROLE` | `fss-etl-viewer` | 40 | client role del visualizzatore di base |
| `ROLES_CLIENT_ID` | `KEYCLOAK_CLIENT_ID` | 40 | client Keycloak che contiene i ruoli, se diverso da quello dell'app |
| `KNOWN_ROLES` | — | 40 | ruoli proposti nella pagina *Ruoli e permessi*, separati da virgola |
| `CONFIG_WORKSPACE` | `mapp` | 40, Job | workspace GeoServer con le tabelle di configurazione. Il chart la passa anche al Job: va impostata in `env`, non in `extraEnv` |

### GeoServer e proxy

| Variabile | Default | Script | Descrizione |
|---|---|---|---|
| `GEOSERVER_PROXY_URL` | — | 35, 40 | URL interno di GeoServer (es. `http://geoserver:8080/geoserver`). nginx lo espone come `/geoserver/` e il browser usa sempre `/geoserver`. Senza, `/geoserver/` risponde 503 |
| `GEOSERVER_URL` | `/geoserver` | 40 | URL di GeoServer per il browser, solo senza `GEOSERVER_PROXY_URL` (GeoServer chiamato direttamente, serve CORS) |
| `GEOSERVER_USER`, `GEOSERVER_PASSWORD` | — | 35 | credenziali di lettura che nginx aggiunge (Basic). Senza, passa l'header `Authorization` del browser (il token Keycloak) |
| `GEOSERVER_USER_FILE`, `GEOSERVER_PASSWORD_FILE` | — | 35 | come sopra, lette da file (Secret montato come volume) |
| `GEOSERVER_WRITE_USER`, `GEOSERVER_WRITE_PASSWORD` | — | 35 | credenziali usate solo per le POST su `/geoserver/wfs` (transazioni WFS-T) |
| `GEOSERVER_WRITE_USER_FILE`, `GEOSERVER_WRITE_PASSWORD_FILE` | — | 35 | come sopra, lette da file |
| `GEOSERVER_WRITE_PASSTHROUGH` | `false` | 35 | `true`: le scritture inoltrano il token dell'utente invece delle credenziali fisse, così GeoServer (OIDC + regole dati) decide chi può scrivere. **Consigliato con `ACCESS_CONTROL`**: con credenziali fisse ogni utente loggato può scrivere con quelle credenziali, anche se l'interfaccia lo nasconde |
| `BACKEND_URL` | — | 35, 40 | upstream di un backend opzionale, esposto come `/api/`. Senza, `/api/` risponde 503 |
| `API_URL` | `/api` | 40 | URL del backend per il browser, solo senza `BACKEND_URL` |

Di default il proxy verso GeoServer è **in sola lettura**: passano solo GET e HEAD. Le POST su `/geoserver/wfs` sono
ammesse solo con `EDIT_ENABLED` o `ACCESS_CONTROL`; `/geoserver/rest` non accetta mai scritture.

### Mappa e sfondi

| Variabile | Default | Script | Descrizione |
|---|---|---|---|
| `MAP_CENTER_LON`, `MAP_CENTER_LAT` | `12.5`, `42.0` | 40 | centro iniziale della mappa (gradi) |
| `MAP_ZOOM` | `5` | 40 | zoom iniziale |
| `MAP_BBOX` | — | 40 | area di interesse `ovest,sud,est,nord` in gradi, per il pulsante *area di interesse*; senza, usa centro e zoom |
| `BASEMAP_TILES` | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | 40 | tile dello sfondo *Mappa* |
| `BASEMAPS` | — | 40, 45 | elenco degli sfondi: `id\|Etichetta\|tile {z}/{x}/{y}\|attribuzione`, separati da `;` (tile vuoto = nessuno sfondo). Senza, mappa (`BASEMAP_TILES`), satellite Esri, scuro CARTO e nessuno |
| `TERRAIN_TILES` | — | 40 | tile DEM in formato *terrarium* per il rilievo 3D (es. `https://host/{z}/{x}/{y}.png`) |

### Aspetto

| Variabile | Default | Script | Descrizione |
|---|---|---|---|
| `APP_TITLE` | — | 40 | nome dell'app nell'intestazione e nella scheda del browser |
| `APP_ACCENT` | — | 40 | colore principale `#rrggbb` |
| `APP_HEADER_COLOR` | — | 40 | colore dell'intestazione `#rrggbb`; nel tema scuro ne derivano anche pannelli e bordi |
| `LOGO_URL` | — | 40 | logo nell'intestazione (URL o percorso, es. `/logos/gema-logo-header.svg`) |
| `LOGO_HEIGHT` | `28` | 40 | altezza dei loghi in px |
| `LOGO_SHOW_TITLE` | `false` | 40 | mostra `APP_TITLE` anche accanto al logo |
| `PARTNER_LOGOS` | — | 40 | loghi a destra nell'intestazione, separati da virgola |
| `PARTNER_LOGOS_BG` | bianco | 40 | sfondo dietro ai loghi partner: `#rrggbb` oppure `none` |
| `FAVICON_URL` | — | 40 | icona della scheda del browser |

I file in `public/logos/` sono serviti come `/logos/...`.

### Ricerca di luoghi

| Variabile | Default | Script | Descrizione |
|---|---|---|---|
| `GEOCODER` | `nominatim` | 35, 40 | `nominatim`, `photon` oppure `off`. Il browser chiama `/geocode/` e nginx inoltra senza token né cookie, con cache di un giorno e un limite per client (1/s Nominatim, 5/s Photon) |
| `GEOCODER_URL` | `https://nominatim.openstreetmap.org` / `https://photon.komoot.io` | 35 | geocoder da usare (es. un'istanza interna) |
| `GEOCODER_USER_AGENT` | `mapp-web` | 35 | User-Agent verso il geocoder (la policy di Nominatim ne chiede uno che identifichi l'app) |
| `GEOCODER_COUNTRY` | — | 40 | limita i risultati a uno o più paesi (codici ISO, es. `it` o `it,sm`) |
| `GEOCODER_LANG` | `it` | 40 | lingua dei risultati |

### Editing e scarico dati

| Variabile | Default | Script | Descrizione |
|---|---|---|---|
| `EDIT_ENABLED` | `false` | 35, 40 | mostra gli strumenti di editing e consente le POST su `/geoserver/wfs` |
| `EDIT_ROLE` | — | 40 | ruolo Keycloak (di realm o di client) richiesto per l'editing (vuoto = nessun vincolo). Con `ACCESS_CONTROL` serve anche lo strumento *Modifica oggetti* nella pagina *Ruoli e permessi* |
| `DOWNLOAD_MAX_FEATURES` | `50000` | 40 | massimo di oggetti per uno scarico vettoriale (CSV, GeoJSON, Shapefile) |

### Cache e prestazioni

| Variabile | Default | Script | Descrizione |
|---|---|---|---|
| `TILE_CACHE` | `false` | 35 | cache su disco delle GetMap e di `/geoserver/gwc/`. Funziona solo con credenziali di lettura fisse (`GEOSERVER_USER`): con il token dell'utente resta spenta, perché le immagini potrebbero dipendere da chi le chiede. Non salva le eccezioni WMS |
| `TILE_CACHE_TTL` | `10m` | 35 | durata di un tile in cache (`30s`, `10m`, `2h`, `1d`). Chi modifica vede subito i tile nuovi; gli altri al più tardi dopo questo tempo |
| `TILE_CACHE_SIZE` | `1g` | 35 | spazio massimo su disco (`500m`, `2g`); deve stare sotto `tileCacheSizeLimit` |
| `WMS_TILED` | `false` | 40 | aggiunge `tiled=true` alle GetMap, per l'integrazione diretta WMS di GeoWebCache (griglia EPSG:900913 a 256 px) |

### Limiti per client

Il client è identificato da `X-Forwarded-For` (impostato da APISIX e oauth2-proxy) o, in mancanza, dall'indirizzo della
connessione. Oltre il limite la risposta è **429**.

| Variabile | Default | Script | Descrizione |
|---|---|---|---|
| `RATE_LIMIT` | `true` | 35 | `false` spegne i limiti verso GeoServer |
| `GEOSERVER_RATE` | `100r/s` | 35 | letture al secondo (o al minuto: `3000r/m`) per client |
| `GEOSERVER_BURST` | `600` | 35 | letture accettate di colpo oltre il ritmo (una mappa con più layer chiede decine di tile per spostamento) |
| `GEOSERVER_WRITE_RATE` | `10r/s` | 35 | scritture (POST su `/geoserver/wfs`: transazioni, salvataggi, statistiche) per client |
| `GEOSERVER_WRITE_BURST` | `40` | 35 | scritture accettate di colpo |

Limiti fissi: geocoder 1/s (Nominatim) o 5/s (Photon) con raffiche di 5; segnalazioni dal browser 1/s con raffiche di 20.

### Sicurezza

| Variabile | Default | Script | Descrizione |
|---|---|---|---|
| `CSP` | `enforce` | 45 | Content-Security-Policy: `enforce`, `report-only` (solo segnalazioni) oppure `off`. Consente solo il sito stesso più le origini presenti in `config.json` (Keycloak, sfondi, rilievo, loghi, GeoServer se non passa dal proxy) |
| `CSP_EXTRA_ORIGINS` | — | 45 | altre origini da consentire, separate da spazio o virgola (es. un WMS esterno usato nel catalogo che non compare in configurazione) |
| `FRAME_ANCESTORS` | — | 45 | siti che possono incorporare l'app in un iframe. Senza, solo lo stesso sito |

Intestazioni sempre presenti, su ogni risposta: `X-Content-Type-Options: nosniff`, `Referrer-Policy:
strict-origin-when-cross-origin`, `X-Frame-Options: SAMEORIGIN` (salvo con `FRAME_ANCESTORS`), `Permissions-Policy`
(posizione solo per il sito, niente fotocamera, microfono, pagamenti).

Per un primo rilascio con servizi esterni non censiti conviene `CSP=report-only`: le violazioni arrivano nel log
(`type="csp-violation"`), si aggiungono le origini mancanti a `CSP_EXTRA_ORIGINS` e poi si passa a `enforce`.

### Log, errori e statistiche

| Variabile | Default | Script | Descrizione |
|---|---|---|---|
| `ACCESS_LOG_FORMAT` | `text` | 35 | `text` (leggibile) oppure `json`: una riga JSON per richiesta con tempo, metodo, percorso, stato, byte, durata, stato della cache e parametri OGC (service, request, layers, typename, format). Nessun header, token o cookie |
| `CLIENT_ERRORS` | `true` | 40, 45 | il browser manda i propri errori JavaScript a `/client-errors` e nginx li scrive nel log JSON con `type="client-error"` (messaggio, pila, pagina, versione; token oscurati). `false` spegne l'endpoint e l'invio |
| `USAGE_STATS` | `anonymous` | 40 | statistiche d'uso (con `ACCESS_CONTROL`): `off`, `anonymous` (ruoli e sessione, nessun nome) oppure `named` (anche il nome utente) |

## Job di inizializzazione

Il Job `<rilascio>-geolibre-config-init` gira a ogni sync di ArgoCD (hook `Sync`, il precedente viene eliminato) ed è idempotente.

1. **`init-db`** (immagine `postgres:17-alpine`), con l'utenza di amministrazione: crea il database e lo schema
   `gema_config`, le tabelle, i trigger del registro modifiche, le viste delle statistiche e l'utente applicativo con i
   soli diritti necessari; applica la conservazione di registro e statistiche.
2. **`publish-geoserver`** (immagine `curl`), con l'amministratore di GeoServer: crea workspace, datastore e layer di
   configurazione e imposta le regole dati.

Tabelle create: `role_rules`, `dashboards`, `saved_views`, `catalog_folders`, `catalog_layers`, `role_views`,
`edit_forms`, `announcements`, `dashboard_drafts`, `change_log`, `usage_events`; viste `usage_daily`, `usage_sessions`,
`usage_roles`, `usage_users`.

Le variabili del Job sono scritte nel template `job.yaml`:

| Variabile | Valore nel chart | Passo | Descrizione |
|---|---|---|---|
| `PGHOST` | `postgres.host` | entrambi | host PostgreSQL |
| `PGPORT` | chiave `port` di `<rilascio>-geolibre-config-db` (default 5432) | entrambi | porta PostgreSQL |
| `PG_ADMIN_USER`, `PG_ADMIN_PASSWORD` | da `<rilascio>-geolibre-config-db` | init-db | amministratore PostgreSQL |
| `GS_DB_USER`, `GS_DB_PASSWORD` | `gs_user`, `gs_password` di `<rilascio>-geolibre-config-db` | entrambi | utente applicativo (datastore di GeoServer) |
| `PGUSER`, `PGPASSWORD` | `user`, `password` di `<rilascio>-geolibre-config-db` | publish | ripiego se mancano `GS_DB_*` |
| `MAPP_DB`, `MAPP_SCHEMA` | `gema_config` | entrambi | database e schema della configurazione |
| `DB_CREATE` | `true` | init-db | crea il database se manca (`false` se esiste già e l'amministratore non può fare `CREATE DATABASE`) |
| `POSTGIS_EXTENSION` | `true` | init-db | `CREATE EXTENSION postgis` (tentativo) |
| `CHANGE_LOG_DAYS` | `changeLogDays` | init-db | conservazione del registro modifiche |
| `USAGE_DAYS` | `usageDays` | init-db | conservazione delle statistiche d'uso |
| `GEOSERVER_URL` | `configJob.geoserverUrl` | publish | URL interno di GeoServer per la REST API |
| `GEOSERVER_USER`, `GEOSERVER_PASSWORD` | da `<rilascio>-geolibre-config-geoserver` | publish | amministratore di GeoServer |
| `CONFIG_WORKSPACE` | `CONFIG_WORKSPACE` dell'app (`env` o `extraEnv`, default `mapp`) | publish | workspace delle tabelle di configurazione |
| `DATASTORE` | `gema_config` | publish | nome del datastore |
| `PUBLISH_GEOSERVER` | `true` | publish | `false` salta la pubblicazione in GeoServer |
| `UPDATE_DATASTORE` | `true` | publish | allinea un datastore già esistente (database, schema, utente, password) |
| `SET_ACL` | `true` | publish | imposta le regole dati di GeoServer sulle tabelle |
| `ACL_READ_ROLES` | `configJob.aclReadRoles`, oppure dai ruoli dell'app | publish | ruoli GeoServer che leggono la configurazione |
| `ACL_WRITE_ROLES` | `configJob.aclWriteRoles`, oppure da `ADMIN_ROLE` | publish | ruoli GeoServer che scrivono la configurazione |
| `ACL_VIEWS_WRITE_ROLES` | `configJob.aclViewsWriteRoles` (solo se impostato) | publish | chi scrive le viste salvate (default dello script: `ACL_READ_ROLES`) |

Altre variabili riconosciute dagli script (non impostate nel chart): `WAIT_TRIES` (tentativi di attesa dei servizi,
default 60), `PGCONNECT_TIMEOUT` (default 5 s), `DS_DB_HOST` / `DS_DB_PORT` (host e porta di PostgreSQL visti da
GeoServer, se diversi da quelli del Job).

Regole dati impostate con `SET_ACL`:

| Tabelle | Lettura | Scrittura |
|---|---|---|
| `role_rules`, `dashboards`, `catalog_folders`, `catalog_layers`, `role_views`, `edit_forms`, `announcements` | `ACL_READ_ROLES` | `ACL_WRITE_ROLES` |
| `dashboard_drafts` | `ACL_WRITE_ROLES` | `ACL_WRITE_ROLES` |
| `change_log`, viste `usage_*` | `ACL_WRITE_ROLES` | solo `ADMIN` di GeoServer |
| `usage_events` | `ACL_READ_ROLES` | `ACL_READ_ROLES` (solo aggiunta: l'utente del database non può modificare né cancellare) |
| `saved_views` | `ACL_READ_ROLES` | `ACL_VIEWS_WRITE_ROLES` |

I ruoli GeoServer derivano da quelli Keycloak tramite il plugin OIDC (`ROLE_` + nome in maiuscolo). Di default il chart
li calcola dai ruoli dell'app, così regole dati e permessi dell'interfaccia restano allineati: per esempio `ADMIN_ROLE=fss-etl-admin`
diventa `ROLE_FSS-ETL-ADMIN`. Se GeoServer nomina i ruoli in un altro modo, impostare `configJob.aclReadRoles` e `configJob.aclWriteRoles`.

## Esempio di values per un ambiente

```yaml
# charts/environments/prod/values.yaml
environment: prod
apisixRoute:
  host: gema.ente.it
image:
  tag: "1.0.0"
replicaCount: 2
extraEnv:
  - name: KEYCLOAK_URL
    value: https://auth.ente.it
  - name: GEOSERVER_WRITE_PASSTHROUGH
    value: "true"
  - name: ACCESS_LOG_FORMAT
    value: json
  - name: TILE_CACHE
    value: "true"
  - name: TILE_CACHE_TTL
    value: 30m
  - name: MAP_BBOX
    value: "6.6,36.6,18.5,47.1"
  - name: GEOCODER_COUNTRY
    value: it
  - name: CSP
    value: report-only        # poi enforce, dopo aver controllato le violazioni nel log
configJob:
  geoserverUrl: http://geoserver.gema-prod.svc.cluster.local:8080/geoserver
changeLogDays: 365
usageDays: 180
tileCacheSizeLimit: 4Gi
```

## Prerequisiti in GeoServer e Vault

Il chart separa l'utente con cui l'app legge da GeoServer dall'amministratore usato dal Job, e fa passare le scritture con
il token dell'utente. Prima di installarlo (o di aggiornare un'installazione precedente) servono:

1. **Un utente GeoServer di sola lettura** per l'app, con le proprietà `GEOSERVER_READ_USER` e `GEOSERVER_READ_PASSWORD`
   in Vault. Deve poter leggere i layer dei dati e le tabelle di configurazione: in GeoServer gli si assegna uno dei ruoli
   di lettura (per esempio `ROLE_` + `VIEWER_ROLE`) oppure lo si aggiunge a `configJob.aclReadRoles`. Senza quelle
   proprietà External Secrets non crea il secret e il pod non parte.
2. **Il plugin OIDC di GeoServer che accetta il token Keycloak** (Bearer) sulle richieste WFS, perché con
   `GEOSERVER_WRITE_PASSTHROUGH=true` le scritture (salvataggi della configurazione, editing, statistiche) arrivano con il
   token dell'utente. La pagina *Admin → Diagnostica* fa una prova di scrittura e dice se GeoServer la accetta.
   Se il plugin non è configurato, la scelta temporanea è `GEOSERVER_WRITE_PASSTHROUGH=false` con un utente di scrittura
   dedicato (`GEOSERVER_WRITE_USER` / `GEOSERVER_WRITE_PASSWORD`), sapendo che allora ogni utente loggato può scrivere.
3. **Con `auth.enabled`:** `auth.issuerUrl` e le proprietà `OIDC_CLIENT_SECRET` e `OAUTH2_PROXY_COOKIE_SECRET` in Vault
   (o un secret `auth.existingSecret` già presente, con `auth.createSecret: false`).

Aggiornando da una versione precedente del chart, Job, ConfigMap e secret del Job cambiano nome
(`mapp-config-init` → `<rilascio>-geolibre-config-init`, `mapp-config-db` → `<rilascio>-geolibre-config-db`,
`mapp-config-geoserver` → `<rilascio>-geolibre-config-geoserver`): ArgoCD crea i nuovi e, con il prune attivo, elimina i
vecchi. I dati in PostgreSQL e GeoServer non cambiano.
