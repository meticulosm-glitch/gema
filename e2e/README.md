# Test end-to-end

Browser reale (Chromium di Playwright) e nginx reale, configurato dagli stessi script di entrypoint dell'immagine
(`docker-entrypoint.d/35-proxy-config.sh`, `40-runtime-config.sh`, `45-security-config.sh`, `50-metrics-config.sh`) e da
`nginx/default.conf`, con le metriche attive come nell'immagine se c'è il modulo njs. GeoServer, Keycloak e i
geocoder sono simulati da `mock-gs.mjs`, così gli scenari non dipendono da servizi esterni.

| Scenario | Cosa copre |
|---|---|
| `e2e.mjs` | proxy in sola lettura e scrittura, elenco prodotti, TIME, CQL, Feature Info, editing WFS-T (attributi, vertici, nuovo oggetto, eliminazione), dashboard, tabella, link condivisibile, misure, 3D, export PNG, tema scuro |
| `e2e-access.mjs` | ruoli Keycloak, pagine admin (regole e dashboard), scritture negate, tabelle di configurazione mancanti |
| `e2e-search.mjs` | ricerca di luoghi (Nominatim, Photon) e per attributo, sfondi, scheda del layer, viste salvate |
| `e2e-tiles.mjs` | cache dei tile WMS in nginx: HIT/MISS, cosa non va in cache (eccezioni, FeatureInfo, WFS), cookie e header, richieste parallele, tempi, cache condivisa tra due utenti nel browser |
| `e2e-vectortiles.mjs` | disegno vettoriale (vector tiles): scelta Immagine/Vettoriale se GeoServer offre MVT, tile MVT, oggetto e attributi al passaggio del mouse senza GetFeatureInfo, legenda col colore, filtro applicato ai tile, scelta ricordata nel link, ritorno all'immagine, GeoServer senza estensione |
| `e2e-security.mjs` | sicurezza di nginx: CSP, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy su tutte le risposte (anche index.html, config.json, asset, GeoServer); app funzionante con la CSP applicata; script inline iniettato bloccato e violazione nel log; errori JavaScript e promesse rifiutate nel log JSON (pila, versione, token oscurato, solo il percorso della pagina), ripetizioni contate una volta; 429 su raffiche di segnalazioni, letture e scritture verso GeoServer; corpo oltre 16 kB 413; `CSP=report-only`, `FRAME_ANCESTORS`, `CLIENT_ERRORS=false`. Tutti gli scenari girano con la CSP applicata, quindi una violazione altrove fa fallire il controllo «nessun errore in console» |
| `e2e-metrics.mjs` | metriche per Prometheus mentre si usa l'app: `/metrics` sulla porta dedicata in formato valido (mai su quella dell'app), pagine, configurazione, asset e richieste a GeoServer contate per area e per richiesta OGC (tile, Feature Info, dashboard); con GeoServer lento le GetMap stanno sopra 0.25 s nell'istogramma, quelle dalla cache di un secondo utente sotto 0.1 s; le chiamate a GeoServer misurate da nginx sono esattamente quelle ricevute; contatori che crescono soltanto e di quanto devono; connessioni; `METRICS=false`. Serve il modulo njs di nginx: senza, lo scenario si salta (`E2E_REQUIRE_NJS=1` lo rende un errore) |
| `e2e-download.mjs` | scarico dei dati: GeoJSON, CSV e Shapefile (WFS) con filtro e area visibile, limite di oggetti, GeoTIFF (WCS) con ritaglio e data; i file scaricati vengono aperti e controllati |
| `e2e-catalog.mjs` | catalogo prodotti da interfaccia: cartelle annidate, ordine (frecce e trascinamento), titoli e descrizioni, layer e cartelle nascosti, accesi di default; salvataggio in un'unica transazione WFS-T, layer nuovi e non più pubblicati, conflitto tra admin, errore a metà transazione, tabelle mancanti; cosa vede il visualizzatore |
| `e2e-roleview.mjs` | vista iniziale per ruolo: area (numeri e mini-mappa), sfondo e layer accesi dalla pagina Ruoli; cosa vede chi apre la mappa con uno o più ruoli, con un link, da admin; pulsante area di interesse; vista svuotata ed eliminata; tabella mancante |
| `e2e-forms.mjs` | moduli di modifica: pagina admin (etichette, ordine, obbligatori, sola lettura, nascosti, menu con i valori del layer, predefiniti, controlli) ed editor della mappa (errori sui campi, solo i campi cambiati, predefiniti nei nuovi oggetti); layer senza modulo; tabella mancante |
| `e2e-announce.mjs` | avvisi: pagina admin (testo con link, tipo, periodo, ruoli, chiudibile, anteprima, controlli), banner su mappa e pagine per ruolo, chiusura ricordata, avviso modificato che ricompare, arrivo senza ricaricare (orologio simulato), tabella mancante |
| `e2e-dashio.mjs` | dashboard: duplica, esporta (una e tutte) e importa da JSON: anteprima, widget non validi scartati, layer di un altro ambiente da sostituire, sostituzione per titolo, esclusioni, transazione unica, file non validi |
| `e2e-widgets.mjs` | nuovi widget: indicatore con soglie (due direzioni), torta con legenda e clic verso la mappa, linea temporale con cursore, tabella ordinata, testo markdown sicuro, mini-mappa con il filtro; campi e controlli per tipo nella pagina admin; tema scuro |
| `e2e-filters.mjs` | filtri globali delle dashboard: periodo (scorciatoie e date a mano, fine compresa) e area (del ruolo o scelta sulla mappa) applicati a tutti i widget, nota per quelli non filtrabili, stato nell'indirizzo dopo un ricaricamento, "Apri sulla mappa" con i filtri, ripristina; configurazione e periodo iniziale dalla pagina admin |
| `e2e-drafts.mjs` | bozze e pubblicazione delle dashboard: modifica in bozza mentre il visualizzatore vede la versione pubblicata (e non chiede mai le bozze), differenze, anteprima come ruolo con gli avvisi su ruoli e layer, pubblica (dashboard aggiornata e bozza eliminata insieme), scarta, bozza nuova incompleta non visibile ai ruoli, elimina; tabella delle bozze mancante = salvataggio diretto |
| `e2e-viewas.mjs` | «Visualizza come ruolo»: dal menu Admin o dalla pagina Ruoli l'amministratore vede layer, strumenti, vista iniziale, avvisi e dashboard del ruolo; barra con cambio ruolo e uscita, pagine admin spiegate, scelta che resta al ricaricamento, ruolo senza regole, utente normale che non può usarlo |
| `e2e-diag.mjs` | pagina di diagnostica: GeoServer, tabelle (colonne e lettura), prova di scrittura che non cambia righe, ruoli nel token, discovery e rinnovo del token su Keycloak, sfondi; tabelle mancanti, scrittura rifiutata e Keycloak senza CORS riconosciuti con il rimedio; rapporto copiato e scaricato senza token; pagina negata ai non amministratori |
| `e2e-changes.mjs` | registro modifiche: scritture registrate come dal trigger (il solo timbro no), registro non scrivibile via WFS-T, eliminazione dall'app attribuita a chi elimina, elenco con dettaglio dei campi, ripristino di un elemento eliminato e ritorno a una versione precedente (con la configurazione ricaricata), filtri per utente e testo, cronologia di un elemento, registro non pubblicato |
| `e2e-usage.mjs` | statistiche d'uso: eventi (pagine, layer, strumento, dashboard) accumulati e inviati in una transazione alla chiusura della pagina; modalità anonima, con nome e spenta; pagina admin con totali, sessioni al giorno, classifiche, ruoli e utenti; tabella mancante senza richieste ripetute; log nginx in JSON per Loki |
| `e2e-backup.mjs` | backup e ripristino: file JSON con tutte le sezioni, anteprima (nuovi/modificati/da eliminare/uguali) in unione e sostituzione, copia di sicurezza scaricata prima, ripristino in una sola transazione registrato nel registro modifiche, file sbagliati, stesso file = niente da cambiare, pagina negata ai non amministratori |
| `e2e-tiles.mjs` | cache dei tile in nginx (TILE_CACHE): la stessa GetMap la seconda volta arriva dal disco (MISS poi HIT, GeoServer non la vede), filtro e contatore danno tile nuovi, GetCapabilities ed eccezioni WMS non salvate, cache spenta senza credenziali di lettura fisse; WMS_TILED: GetMap con tiled=true e un secondo utente servito dalla cache |

## Come eseguirli

```sh
npm run test:e2e            # build, dipendenze e tutti gli scenari
node e2e/run.mjs e2e-search # solo uno scenario (la build in dist/ deve esserci)
```

Le dipendenze degli scenari (Playwright compreso) sono in `e2e/package.json`. La prima volta serve il browser: `npx --prefix e2e playwright install chromium`. Serve anche nginx (`apt-get install nginx`,
`brew install nginx`) e, per le metriche, il suo modulo njs (`apt-get install libnginx-mod-http-js`; in un percorso diverso
`NGINX_JS_MODULE=/percorso/ngx_http_js_module.so`); il servizio di sistema non viene toccato, i test avviano le proprie
istanze su 127.0.0.1:8072-8099 e 8177-8178, con le metriche sulla porta + 1000.

Screenshot, log di nginx e config generate finiscono in `e2e/.run` (ignorata da git; `E2E_RUN_DIR` per cambiarla).
`CHROMIUM_PATH` usa un Chromium già installato al posto di quello di Playwright.
