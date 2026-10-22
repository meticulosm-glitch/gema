<p align="center">
  <picture>
    <!-- il logo dell'intestazione ha il testo chiaro: su sfondo chiaro si usa il solo simbolo -->
    <source media="(prefers-color-scheme: dark)" srcset="public/logos/gema-logo-header.svg">
    <img src="public/logos/gema-favicon.svg" alt="G.E.M.A." height="72">
  </picture>
</p>

<h1 align="center">G.E.M.A.</h1>

<p align="center">
  Visualizzatore geografico web per Kubernetes, pensato per sostituire M.App Enterprise.<br>
  Mappe, dashboard, editing e amministrazione sopra GeoServer e PostGIS, con login Keycloak.
</p>

---

## Indice

- [Panoramica](#panoramica)
- [Architettura](#architettura)
- [Funzionalità](#funzionalità)
  - [Mappa](#mappa)
  - [Strumenti della mappa](#strumenti-della-mappa)
  - [Dashboard](#dashboard)
  - [Amministrazione](#amministrazione)
  - [Utenti, ruoli e permessi](#utenti-ruoli-e-permessi)
  - [Sicurezza](#sicurezza)
  - [Prestazioni](#prestazioni)
  - [Osservabilità](#osservabilità)
- [Configurazione](#configurazione)
- [Sviluppo locale](#sviluppo-locale)
- [Immagine Docker](#immagine-docker)
- [Test](#test)
- [Struttura del repository](#struttura-del-repository)
- [Licenza](#licenza)

## Panoramica

G.E.M.A. è un'applicazione web a pagina singola (React + MapLibre) servita da nginx. Tutti i dati geografici arrivano da
**GeoServer** (WMS, WFS, WFS-T, WCS) e la configurazione dell'applicazione è salvata in tabelle **PostGIS** pubblicate da
GeoServer. Non c'è un backend applicativo da mantenere: ruoli, catalogo, dashboard e avvisi si leggono e si scrivono via
WFS/WFS-T, con i permessi applicati da GeoServer.

Si installa con il chart Helm in [`charts/`](charts/README.md), che descrive tutti i valori e le variabili d'ambiente.

## Architettura

```
 Browser ──► APISIX ──► (oauth2-proxy, opzionale) ──► nginx ──┬─► file dell'app (React + MapLibre)
    │                                                         ├─► /geoserver/  ──► GeoServer ──► PostGIS (dati e gema_config)
    │                                                         ├─► /geocode/    ──► Nominatim / Photon
    │                                                         ├─► /api/        ──► backend opzionale
    │                                                         └─► /client-errors, /csp-report ──► log JSON (Loki)
    └──── login ──► Keycloak (token OIDC, ruoli)                  nginx :9145/metrics ◄── Prometheus (solo nel cluster)
```

- **nginx** serve l'app e fa da reverse proxy: aggiunge le credenziali di GeoServer (il browser non le vede), tiene il
  proxy in sola lettura salvo dove servono le scritture, mette in cache i tile, limita le richieste per client e scrive i
  log in testo o JSON.
- **La configurazione di nginx e dell'app nasce all'avvio** dagli script in `docker-entrypoint.d/`, a partire dalle
  variabili d'ambiente: `35-proxy-config.sh` (proxy, credenziali, cache, limiti, log), `40-runtime-config.sh`
  (`config.json` letto dal browser), `45-security-config.sh` (CSP, intestazioni di sicurezza, segnalazioni dal browser),
  `50-metrics-config.sh` (metriche per Prometheus).
- **Un Job Helm** crea in PostgreSQL lo schema `gema_config` e pubblica le tabelle in GeoServer con le regole di accesso.
  È idempotente: gira a ogni sync di ArgoCD e non tocca ciò che esiste già.

## Funzionalità

### Mappa

- **Catalogo dei prodotti.** Elenco dei layer per cartelle (annidate), con titoli, descrizioni e ordine decisi
  dall'amministratore. Layer accesi di default e layer nascosti. Senza catalogo configurato si usa l'elenco del
  GetCapabilities.
- **Layer attivi.** Opacità, stile (tra quelli dichiarati da GeoServer), ordine, filtro CQL, data per i layer con
  dimensione TIME. Ogni layer ha una scheda con quanto dichiara GeoServer (abstract, parole chiave, estensione, link), il
  numero di oggetti e gli attributi.
- **Disegno vettoriale (vector tiles).** Per i layer vettoriali pesanti si può scegliere *Immagine* (stile SLD di
  GeoServer) o *Vettoriale* (tile MVT disegnati dal browser). In vettoriale le linee restano nitide a ogni zoom e passando
  il mouse si vedono l'oggetto e i suoi attributi senza interrogare il server. La scelta compare solo se GeoServer ha
  l'estensione vectortiles.
- **Legende** sempre visibili sulla mappa, nello stile scelto; si possono comprimere.
- **Dimensione temporale.** Slider con riproduzione degli istanti di un layer, selezione della data dal menu.
- **Sfondi.** Mappa, satellite, scuro e nessuno, oppure un elenco configurato (`BASEMAPS`). Rilievo 3D se è configurato un
  DEM (`TERRAIN_TILES`).
- **Vista iniziale per ruolo.** Area, sfondo e layer accesi all'apertura dipendono dal ruolo dell'utente. Il pulsante
  *area di interesse* riporta la mappa sulla zona di lavoro.
- **Link condivisibile.** Inquadratura, layer, filtri, date, stili, opacità, sfondo e disegno sono nell'indirizzo: chi apre
  il link vede la stessa mappa.
- **Avvisi.** Banner sotto la barra (informazione, attenzione, manutenzione), per ruolo e per periodo, con link; arrivano
  senza ricaricare la pagina. La chiusura viene ricordata finché l'avviso non cambia.
- **Tema chiaro e scuro**, con colori e loghi personalizzabili (logo dell'app, loghi dei partner, favicon, colore
  principale e dell'intestazione).

### Strumenti della mappa

Ogni strumento si assegna ai ruoli dalla pagina *Ruoli e permessi*.

| Strumento | Cosa fa |
|---|---|
| Interroga oggetti | Feature Info: attributi dell'oggetto cliccato su tutti i layer attivi |
| Misure e coordinate | distanza, area, coordinate del punto |
| Tabella attributi | tabella del layer vettoriale con filtro rapido e filtro CQL lato server; clic su una riga per centrare l'oggetto |
| Grafici sul layer | dashboard rapida di un attributo; un clic sul grafico filtra la mappa |
| Stampa / esporta | PNG con titolo, mappa e legende |
| Vista 3D | inclinazione e rilievo del terreno |
| Serie storica in un punto | valore di un layer temporale nel tempo, in un punto, come grafico |
| Confronto con cursore | swipe tra due layer o tra due date dello stesso layer |
| Ricerca luoghi e attributi | indirizzi e luoghi (Nominatim o Photon) e testo negli attributi dei layer attivi |
| Viste salvate | salva e riapri viste con nome (per utente, in PostGIS) |
| Scarica dati | CSV, GeoJSON e Shapefile (WFS) con filtro e area visibile; GeoTIFF (WCS) ritagliato alla data scelta |
| Modifica oggetti | editing WFS-T: attributi (con i moduli configurati), vertici, nuovi oggetti, eliminazione |

### Dashboard

- **Widget:** KPI, indicatore con soglie, barre, torta, istogramma, colonne per mese, linea temporale con cursore, tabella
  ordinata, mini-mappa con il filtro del widget, testo (markdown sicuro). Aggregazioni: numero, somma, media, minimo,
  massimo. I conteggi restano esatti anche oltre il limite degli oggetti letti.
- **Filtri globali:** periodo (scorciatoie o date) e area (quella del ruolo o scelta sulla mappa), applicati a tutti i
  widget; lo stato resta nell'indirizzo. *Apri sulla mappa* porta i filtri sulla mappa.
- **Dashboard per ruolo:** ogni dashboard è visibile solo ai ruoli scelti.
- **Bozza e pubblicazione:** le modifiche restano in bozza finché non si pubblicano. Si vedono le differenze e
  un'anteprima *come ruolo*, con gli avvisi su ruoli e layer che quel ruolo non vede.
- **Duplica, esporta e importa** in JSON, anche tra ambienti diversi: anteprima, layer da rimappare, sostituzione per
  titolo, importazione in un'unica transazione.

### Amministrazione

Le pagine stanno nel menu **Admin**, visibile solo al ruolo amministratore.

| Pagina | Cosa permette |
|---|---|
| Ruoli e permessi | per ogni ruolo Keycloak: layer visibili, strumenti, vista iniziale (area, sfondo, layer accesi) |
| Catalogo prodotti | cartelle, ordine (frecce e trascinamento), titoli, descrizioni, layer nascosti e accesi di default; salvataggio in un'unica transazione con controllo dei conflitti tra amministratori |
| Moduli di modifica | per ogni layer modificabile: etichette, ordine, campi obbligatori, in sola lettura o nascosti, menu con i valori, valori predefiniti, controlli |
| Avvisi | testo con link, tipo, periodo, ruoli, chiudibile o no, anteprima |
| Crea dashboard | editor delle dashboard, bozze, anteprima come ruolo, duplica, esporta, importa |
| Registro modifiche | chi ha cambiato cosa e quando su tutta la configurazione (trigger in PostGIS), dettaglio dei campi, filtri, cronologia di un elemento, ripristino di una versione o di un elemento eliminato |
| Statistiche d'uso | sessioni al giorno, pagine, layer, strumenti e dashboard più usati, ruoli; utenti solo se la raccolta è con nome |
| Backup e ripristino | tutta la configurazione in un file JSON; ripristino in unione o sostituzione con anteprima, copia di sicurezza automatica, una sola transazione |
| Diagnostica | GeoServer, tabelle e colonne, prova di scrittura, ruoli nel token, Keycloak (discovery, rinnovo del token, CORS), sfondi; rapporto da copiare o scaricare, con il rimedio per ogni problema |

**Visualizza come ruolo:** l'amministratore vede l'applicazione con layer, strumenti, vista iniziale, avvisi e dashboard
di un ruolo, con una barra per cambiare ruolo o tornare amministratore.

Se una tabella di configurazione manca (Job non ancora rieseguito), l'app funziona come prima e la pagina admin lo segnala.

### Utenti, ruoli e permessi

- **Login Keycloak** (OIDC con PKCE). Disattivabile per ambienti senza autenticazione.
- **Ruoli applicativi** letti dai client role del token: un ruolo amministratore, un ruolo visualizzatore e i ruoli che si
  aggiungono dalla pagina admin.
- **I permessi veri li applica GeoServer.** L'interfaccia nasconde ciò che un ruolo non può fare, e le regole dati di
  GeoServer impediscono le letture e scritture non consentite. Con `GEOSERVER_WRITE_PASSTHROUGH` le scritture passano con
  il token dell'utente, così GeoServer sa chi scrive.

### Sicurezza

- **Proxy in sola lettura di default:** verso GeoServer passano solo GET; le POST sono ammesse solo su `/geoserver/wfs`
  (transazioni WFS-T) quando l'editing o il controllo accessi sono attivi.
- **Credenziali di GeoServer nel proxy**, mai nel browser (anche da file, per i Secret montati come volume).
- **Content-Security-Policy** applicata di default: script e stili solo dal sito stesso, connessioni e immagini solo verso
  i server presenti nella configurazione. Più X-Content-Type-Options, Referrer-Policy, X-Frame-Options e
  Permissions-Policy su tutte le risposte.
- **Limite di richieste per client** verso GeoServer, geocoder e segnalazioni (oltre il limite, 429).
- **Registro modifiche** non scrivibile dall'utente applicativo; eliminazioni firmate con l'autore.

### Prestazioni

- **Cache dei tile in nginx** per GetMap e GeoWebCache, su disco, con durata e spazio configurabili.
- **Integrazione con GeoWebCache** (`tiled=true` nelle GetMap).
- **Vector tiles** per i layer vettoriali pesanti.
- **Cache del geocoder** per un giorno.

### Osservabilità

- **Log delle richieste in JSON** (`ACCESS_LOG_FORMAT=json`), con i parametri OGC (servizio, richiesta, layer, formato),
  pronti per Loki.
- **Errori del browser nel log:** gli errori JavaScript e le violazioni della CSP arrivano a nginx e finiscono nel log JSON
  (`type="client-error"`, `type="csp-violation"`), con pila, versione della build e pagina, senza token né dati della vista.
- **Statistiche d'uso** in PostGIS, anonime di default.
- **Metriche per Prometheus** su `/metrics`, porta 9145 (solo dentro al cluster: la rotta APISIX non la espone):
  richieste per area e stato, istogrammi dei tempi di risposta (intera richiesta, GeoServer per tipo di richiesta OGC,
  upstream), cache dei tile, richieste respinte dai limiti, connessioni di nginx. ServiceMonitor per il Prometheus Operator
  nel chart. Elenco ed esempi PromQL in [`charts/README.md`](charts/README.md#metriche-per-prometheus).
- **Pagina di diagnostica** e `/healthz` per i probe di Kubernetes.

Esempi LogQL:

```logql
{app="gema-web"} | json | type="client-error"
topk(10, sum by (layers) (count_over_time({app="gema-web"} | json | request="GetMap" [24h])))
sum by (status) (count_over_time({app="gema-web"} | json | path=~"/geoserver/.*" | status>=500 [1h]))
```

Esempi PromQL:

```promql
histogram_quantile(0.95, sum by (le) (rate(gema_geoserver_request_duration_seconds_bucket{request="GetMap"}[5m])))
sum by (request) (rate(gema_geoserver_requests_total{status=~"5.."}[5m]))
```

## Configurazione

Tutta la configurazione passa da variabili d'ambiente del container, impostate dal chart Helm.
**[`charts/README.md`](charts/README.md)** descrive ogni valore del chart, ogni variabile d'ambiente, i secret attesi e il
Job che prepara database e GeoServer.

In alternativa alle variabili, `config.json` si può montare già pronto (per esempio da una ConfigMap) in
`/usr/share/nginx/html/config.json`: in quel caso lo script di avvio non lo rigenera.

## Sviluppo locale

Servono Node.js 22 e un GeoServer raggiungibile (e, se si vuole il login, un Keycloak).

```sh
npm ci
# public/config.json: URL di GeoServer e Keycloak per lo sviluppo (non finisce nell'immagine)
npm run dev
```

`public/config.json` ha lo stesso formato del `config.json` generato in produzione. Per lavorare senza login basta
togliere il blocco `keycloak`.

## Immagine Docker

```sh
docker build -f docker/Dockerfile -t gema-web .
docker run --rm -p 8080:8080 \
  -e AUTH_ENABLED=false \
  -e GEOSERVER_PROXY_URL=http://geoserver:8080/geoserver \
  -e GEOSERVER_USER=reader -e GEOSERVER_PASSWORD=... \
  gema-web
```

L'immagine è basata su `nginx-unprivileged` (utente non root, porta 8080; metriche sulla 9145) e contiene la build
dell'app, `nginx/default.conf`, il modulo njs delle metriche (`nginx/metrics.js`) e gli script di avvio.

## Test

| Tipo | Comando | Cosa serve |
|---|---|---|
| Unitari | `npm test` | niente |
| Integrazione | `npm run test:integration:docker` | Docker con compose, `psql`, nginx con il modulo njs: PostGIS e GeoServer reali ([dettagli](test/integration/README.md)) |
| End-to-end | `npm run test:e2e` | nginx (con il modulo njs, per le metriche) e Chromium di Playwright: browser vero, GeoServer e Keycloak simulati ([dettagli](e2e/README.md)) |
| Tutti | `npm run test:all` | tutto quanto sopra |

## Struttura del repository

```
src/                    applicazione (React + TypeScript)
public/                 file statici: loghi, favicon, config.json di sviluppo
nginx/default.conf      server nginx (include la configurazione generata all'avvio)
nginx/metrics.js        metriche per Prometheus (modulo njs)
docker-entrypoint.d/    script di avvio che generano proxy, config.json, sicurezza e metriche
docker/Dockerfile       immagine di produzione
charts/                 chart Helm: app, rotta APISIX, secret, Job di inizializzazione
test/                   test unitari; test/integration/ test con servizi reali
e2e/                    test end-to-end con browser e nginx reali
```

## Licenza

GNU General Public License v3.0: vedi [LICENSE](LICENSE).

---

<p align="center">
  <img src="public/logos/Meticulo%20Software%20Production%20Logo.png" alt="Meticulo" height="120"><br>
  Sviluppato da <strong>Meticulo</strong>
</p>
