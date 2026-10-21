import { createRoot } from "react-dom/client";
import { setWorkerUrl } from "maplibre-gl";
// maplibre-gl 6 cerca il worker accanto al bundle, ma Vite non lo copia: senza questo, in produzione /assets/maplibre-gl-worker.mjs dà 404
// e le sorgenti GeoJSON (evidenziazione, misure, editing, punto della serie) non si disegnano.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { loadConfig } from "./config";
import { initAuth } from "./auth";
import Root from "./Root";
import { applyBranding } from "./branding";
import { setWmsTiled } from "./api";
import { reportClientError, startClientErrors, stopClientErrors } from "./clientErrors";
import "./base.css";

setWorkerUrl(workerUrl);
// subito, prima della configurazione: anche un errore di avvio arriva nel log
if (import.meta.env.PROD) startClientErrors();

async function bootstrap() {
  const root = createRoot(document.getElementById("root")!);
  try {
    const cfg = await loadConfig();
    if (cfg.clientErrors === false) stopClientErrors();
    applyBranding(cfg);
    setWmsTiled(cfg.wmsTiled === true);
    const kc = await initAuth(cfg);
    root.render(<Root cfg={cfg} kc={kc} />);
  } catch (e) {
    reportClientError(e);
    root.render(<pre className="boot-error">Impossibile avviare l'applicazione: {String(e)}</pre>);
  }
}
bootstrap();
