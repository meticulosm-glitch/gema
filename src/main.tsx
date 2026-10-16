import { createRoot } from "react-dom/client";
import { setWorkerUrl } from "maplibre-gl";
// maplibre-gl 6 cerca il worker accanto al bundle, ma Vite non lo copia: senza questo, in produzione /assets/maplibre-gl-worker.mjs dà 404
// e le sorgenti GeoJSON (evidenziazione, misure, editing, punto della serie) non si disegnano.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { loadConfig } from "./config";
import { initAuth } from "./auth";
import Root from "./Root";
import { applyBranding } from "./branding";

setWorkerUrl(workerUrl);

async function bootstrap() {
  const root = createRoot(document.getElementById("root")!);
  try {
    const cfg = await loadConfig();
    applyBranding(cfg);
    const kc = await initAuth(cfg);
    root.render(<Root cfg={cfg} kc={kc} />);
  } catch (e) {
    root.render(<pre style={{ padding: 16 }}>Impossibile avviare l'applicazione: {String(e)}</pre>);
  }
}
bootstrap();
