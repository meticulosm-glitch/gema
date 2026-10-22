// Metriche Prometheus di nginx (modulo njs), attivate da docker-entrypoint.d/50-metrics-config.sh.
//
//   record  a fine richiesta (fase di log), dal server dell'app tramite `access_log /dev/null ... if=$gema_metrics_record`:
//           aggiorna contatori e istogrammi nella zona di memoria condivisa (una sola per tutti i worker). Restituisce
//           sempre "", quindi quella riga di log non viene mai scritta.
//   render  GET /metrics sulla porta delle metriche: formato testuale di Prometheus (text/plain; version=0.0.4).
//
// Le etichette hanno solo valori da insiemi chiusi (area dell'app, metodo, stato, richiesta OGC, esito della cache): mai
// percorsi, layer o utenti, così le serie restano poche. Il dettaglio per layer resta nel log JSON (Loki).
//
// Scritto per l'interprete njs (niente sintassi recente, niente dipendenze); i test unitari lo caricano in Node con un
// `ngx` finto (test/metrics-njs.test.ts).

var ZONE = "gema_metrics";

/** Limiti (in secondi) dei bucket degli istogrammi: da 5 ms a 1 minuto (proxy_read_timeout è 120 s, oltre c'è +Inf). */
var BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

/** Famiglie esposte, nell'ordine di uscita: nome, tipo, descrizione. */
var FAMILIES = [
  ["gema_http_requests_total", "counter", "Richieste servite dal server dell'app, per area, metodo e stato HTTP"],
  ["gema_http_request_duration_seconds", "histogram", "Durata delle richieste (dal primo byte ricevuto all'ultimo inviato al client), per area"],
  ["gema_http_response_bytes_total", "counter", "Byte del corpo delle risposte inviati ai client, per area"],
  ["gema_upstream_response_duration_seconds", "histogram", "Tempo di risposta dell'upstream (GeoServer, geocoder, backend), per area; esclusi i tile serviti dalla cache e le richieste respinte da nginx"],
  ["gema_geoserver_requests_total", "counter", "Richieste verso /geoserver/, per richiesta OGC e stato HTTP"],
  ["gema_geoserver_request_duration_seconds", "histogram", "Durata delle richieste verso /geoserver/ vista dal client (cache compresa), per richiesta OGC"],
  ["gema_tile_cache_requests_total", "counter", "Esito della cache dei tile di nginx (TILE_CACHE) per le richieste verso /geoserver/"],
];

/** Richieste OGC riconosciute (parametro request, senza distinzione di maiuscole); le altre diventano "other". */
var OGC = {
  getmap: "GetMap", getfeatureinfo: "GetFeatureInfo", getlegendgraphic: "GetLegendGraphic", getcapabilities: "GetCapabilities",
  getfeature: "GetFeature", describefeaturetype: "DescribeFeatureType", getpropertyvalue: "GetPropertyValue", transaction: "Transaction",
  getcoverage: "GetCoverage", describecoverage: "DescribeCoverage", gettile: "GetTile",
};
var METHODS = { GET: 1, HEAD: 1, POST: 1, PUT: 1, PATCH: 1, DELETE: 1, OPTIONS: 1 };
var CACHE = { HIT: 1, MISS: 1, BYPASS: 1, EXPIRED: 1, STALE: 1, UPDATING: 1, REVALIDATED: 1 };
var UPSTREAM_AREAS = { geoserver: 1, geocode: 1, api: 1 };

function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

/** Area dell'app a cui appartiene il percorso (dopo try_files: le pagine della SPA arrivano qui come /index.html). */
function area(uri) {
  var u = String(uri || "");
  if (u.indexOf("/geoserver/") === 0) return "geoserver";
  if (u.indexOf("/geocode/") === 0) return "geocode";
  if (u.indexOf("/api/") === 0) return "api";
  if (u.indexOf("/assets/") === 0) return "assets";
  if (u === "/config.json") return "config";
  if (u === "/" || u === "/index.html") return "app";
  if (u === "/client-errors" || u === "/csp-report") return "reports";
  return "static";
}

/** Richiesta OGC: dal parametro request; GeoWebCache (/geoserver/gwc/) a parte; POST su /wfs senza parametro = transazione WFS-T. */
function ogcRequest(uri, method, request) {
  var u = String(uri || "");
  if (u.indexOf("/geoserver/gwc/") === 0) return "gwc";
  var q = String(request || "").toLowerCase();
  if (q) return has(OGC, q) ? OGC[q] : "other";
  if (method === "POST" && /\/wfs$/.test(u)) return "Transaction";
  return "other";
}

function methodOf(m) { var s = String(m || "").toUpperCase(); return has(METHODS, s) ? s : "OTHER"; }
function statusOf(s) { var v = String(s || ""); return /^[1-5][0-9][0-9]$/.test(v) ? v : "000"; }

/** Secondi di $upstream_response_time: "0.402", più tentativi "0.001, 0.402", redirect interni "0.1 : 0.2" (sommati); "-" o vuoto = nessuno. */
function upstreamSeconds(v) {
  var m = String(v || "").match(/[0-9]+(?:\.[0-9]+)?/g);
  if (!m) return null;
  var t = 0;
  for (var i = 0; i < m.length; i++) t += Number(m[i]);
  return t;
}

/** Indice del bucket (non cumulativo) di un valore: il primo limite >= valore, oppure BUCKETS.length (+Inf). */
function bucketIndex(v) {
  for (var i = 0; i < BUCKETS.length; i++) if (v <= BUCKETS[i]) return i;
  return BUCKETS.length;
}

/** Etichette nel formato di Prometheus, nell'ordine dato. I valori arrivano già da insiemi chiusi. */
function labels(pairs) {
  var out = [];
  for (var i = 0; i < pairs.length; i += 2) out.push(pairs[i] + '="' + pairs[i + 1] + '"');
  return out.join(",");
}

// Chiavi nella zona condivisa: "c|famiglia|etichette" (contatore), "h|famiglia|etichette|bucket" (bucket non cumulativo),
// "s|famiglia|etichette" (somma dei valori). Il conteggio di un istogramma è la somma dei suoi bucket.
function count(d, family, lb, n) { d.incr("c|" + family + "|" + lb, n); }
function observe(d, family, lb, seconds) {
  d.incr("h|" + family + "|" + lb + "|" + bucketIndex(seconds), 1);
  d.incr("s|" + family + "|" + lb, seconds);
}

/** Aggiorna le metriche di una richiesta conclusa. `v` ha le variabili di nginx (r.variables). */
function update(d, v) {
  var uri = v.uri;
  var a = area(uri);
  var method = methodOf(v.request_method);
  var status = statusOf(v.status);
  var rt = Number(v.request_time);
  if (!(rt >= 0)) rt = 0;
  count(d, "gema_http_requests_total", labels(["route", a, "method", method, "status", status]), 1);
  observe(d, "gema_http_request_duration_seconds", labels(["route", a]), rt);
  var bytes = Number(v.body_bytes_sent);
  if (bytes > 0) count(d, "gema_http_response_bytes_total", labels(["route", a]), bytes);
  // con un tile dalla cache nginx registra un "upstream" senza stato e con tempo 0.000: conta solo se ha risposto davvero
  if (has(UPSTREAM_AREAS, a) && /[1-5][0-9][0-9]/.test(String(v.upstream_status || ""))) {
    var up = upstreamSeconds(v.upstream_response_time);
    if (up !== null) observe(d, "gema_upstream_response_duration_seconds", labels(["route", a]), up);
  }
  if (a === "geoserver") {
    var q = ogcRequest(uri, method, v.arg_request);
    count(d, "gema_geoserver_requests_total", labels(["request", q, "status", status]), 1);
    observe(d, "gema_geoserver_request_duration_seconds", labels(["request", q]), rt);
    var cache = String(v.upstream_cache_status || "");
    if (has(CACHE, cache)) count(d, "gema_tile_cache_requests_total", labels(["status", cache]), 1);
  }
}

/** js_set $gema_metrics_record: chiamata dal log del server dell'app. Una zona piena o un errore non toccano la richiesta. */
function record(r) {
  try {
    var d = ngx.shared[ZONE];
    if (d) update(d, r.variables);
  } catch (e) {
    // zona piena (serve più memoria in js_shared_dict_zone) o variabile assente: la metrica di questa richiesta si perde
  }
  return "";
}

/** Numero nel formato di Prometheus: interi così come sono, decimali arrotondati al microsecondo. */
function num(x) {
  var n = Number(x) || 0;
  return n === Math.floor(n) ? String(n) : String(Math.round(n * 1e6) / 1e6);
}

/** Pagina stub_status di nginx -> connessioni e richieste totali (null se non leggibile). */
function parseStubStatus(text) {
  var t = String(text || "");
  var active = t.match(/Active connections:\s*([0-9]+)/);
  var totals = t.match(/\n\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s*\n/);
  var rw = t.match(/Reading:\s*([0-9]+)\s+Writing:\s*([0-9]+)\s+Waiting:\s*([0-9]+)/);
  if (!active || !totals || !rw) return null;
  return {
    active: Number(active[1]), accepted: Number(totals[1]), handled: Number(totals[2]), requests: Number(totals[3]),
    reading: Number(rw[1]), writing: Number(rw[2]), waiting: Number(rw[3]),
  };
}

/**
 * Testo per Prometheus dalle voci della zona ([chiave, valore]), dallo stato delle connessioni e dallo spazio della zona.
 * Ogni famiglia ha sempre HELP e TYPE, anche senza serie; dentro una famiglia le serie sono in ordine di etichette.
 */
function format(items, conn, zone) {
  var fam = {};
  for (var i = 0; i < items.length; i++) {
    var p = String(items[i][0]).split("|");
    if (p.length < 3) continue;
    var f = fam[p[1]] || (fam[p[1]] = {});
    var s = f[p[2]] || (f[p[2]] = { v: 0, b: [], sum: 0 });
    if (p[0] === "c") s.v = items[i][1];
    else if (p[0] === "h") s.b[Number(p[3])] = items[i][1];
    else if (p[0] === "s") s.sum = items[i][1];
  }
  var out = [];
  for (var k = 0; k < FAMILIES.length; k++) {
    var name = FAMILIES[k][0], type = FAMILIES[k][1];
    out.push("# HELP " + name + " " + FAMILIES[k][2]);
    out.push("# TYPE " + name + " " + type);
    var series = fam[name] || {};
    var keys = Object.keys(series).sort();
    for (var j = 0; j < keys.length; j++) {
      var lb = keys[j], se = series[lb];
      if (type === "counter") { out.push(name + "{" + lb + "} " + num(se.v)); continue; }
      var acc = 0;
      for (var b = 0; b <= BUCKETS.length; b++) {
        acc += Number(se.b[b]) || 0;
        out.push(name + "_bucket{" + lb + ',le="' + (b < BUCKETS.length ? String(BUCKETS[b]) : "+Inf") + '"} ' + acc);
      }
      out.push(name + "_sum{" + lb + "} " + num(se.sum));
      out.push(name + "_count{" + lb + "} " + acc);
    }
  }
  if (conn) {
    out.push("# HELP gema_nginx_connections Connessioni client aperte ora, per stato (stub_status)");
    out.push("# TYPE gema_nginx_connections gauge");
    var states = ["active", "reading", "writing", "waiting"];
    for (var c = 0; c < states.length; c++) out.push('gema_nginx_connections{state="' + states[c] + '"} ' + conn[states[c]]);
    out.push("# HELP gema_nginx_connections_accepted_total Connessioni client accettate dall'avvio");
    out.push("# TYPE gema_nginx_connections_accepted_total counter");
    out.push("gema_nginx_connections_accepted_total " + conn.accepted);
    out.push("# HELP gema_nginx_connections_handled_total Connessioni client gestite dall'avvio");
    out.push("# TYPE gema_nginx_connections_handled_total counter");
    out.push("gema_nginx_connections_handled_total " + conn.handled);
    out.push("# HELP gema_nginx_requests_total Richieste ricevute da nginx dall'avvio, su tutte le porte (comprese sonde e metriche)");
    out.push("# TYPE gema_nginx_requests_total counter");
    out.push("gema_nginx_requests_total " + conn.requests);
  }
  if (zone) {
    out.push("# HELP gema_metrics_zone_free_bytes Spazio libero nella memoria condivisa delle metriche: vicino a zero, alcune richieste non vengono più contate");
    out.push("# TYPE gema_metrics_zone_free_bytes gauge");
    out.push("gema_metrics_zone_free_bytes " + num(zone.free));
    out.push("# HELP gema_metrics_zone_size_bytes Dimensione della memoria condivisa delle metriche");
    out.push("# TYPE gema_metrics_zone_size_bytes gauge");
    out.push("gema_metrics_zone_size_bytes " + num(zone.capacity));
  }
  return out.join("\n") + "\n";
}

/** js_content di /metrics: legge la zona, chiede a nginx lo stato delle connessioni (stessa porta) e risponde. */
async function render(r) {
  var d = ngx.shared[ZONE];
  var items = d ? d.items(1000000) : [];
  var zone = d ? { free: d.freeSpace(), capacity: d.capacity } : null;
  var conn = null;
  try {
    var host = String(r.variables.server_addr || "127.0.0.1");
    if (host.indexOf(":") >= 0) host = "[" + host + "]";
    var res = await ngx.fetch("http://" + host + ":" + r.variables.server_port + "/stub_status");
    if (res.status === 200) {
      var text = await res.text(); // njs non accetta await dentro gli argomenti di una chiamata
      conn = parseStubStatus(text);
    }
  } catch (e) {
    // stato delle connessioni non disponibile: si espongono solo le metriche delle richieste
  }
  r.headersOut["Content-Type"] = "text/plain; version=0.0.4; charset=utf-8";
  r.headersOut["Cache-Control"] = "no-store";
  r.return(200, format(items, conn, zone));
}

export default { record: record, render: render, update: update, format: format, area: area, ogcRequest: ogcRequest, upstreamSeconds: upstreamSeconds, bucketIndex: bucketIndex, parseStubStatus: parseStubStatus, BUCKETS: BUCKETS, FAMILIES: FAMILIES, ZONE: ZONE };
