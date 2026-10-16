import type * as maplibregl from "maplibre-gl";
import { scaleDenominator } from "./geo";

export interface LegendItem { title: string; bitmap: ImageBitmap }

/** Compone un PNG: titolo + mappa corrente + legende dei layer attivi, e lo scarica. */
export function exportMapPng(map: maplibregl.Map, opts: { title: string; legends: LegendItem[] }): Promise<void> {
  return new Promise((resolve) => {
    // il canvas WebGL va letto nello stesso frame in cui viene renderizzato
    map.once("render", () => {
      const src = map.getCanvas();
      const s = window.devicePixelRatio || 1;
      const W = src.width, H = src.height;
      const pad = 14 * s, headH = 58 * s;

      const out = document.createElement("canvas");
      const ctx = out.getContext("2d")!;

      // layout delle legende (due passate: misura, poi disegno)
      const layout = (draw: boolean, top: number): number => {
        let x = pad, y = top, rowH = 0;
        for (const it of opts.legends) {
          const w = Math.max(160 * s, it.bitmap.width * s) + 18 * s;
          const h = 20 * s + it.bitmap.height * s + 10 * s;
          if (x + w > W - pad && x > pad) { x = pad; y += rowH; rowH = 0; }
          if (draw) {
            ctx.fillStyle = "#1d2733";
            ctx.font = `600 ${12 * s}px system-ui, sans-serif`;
            ctx.fillText(it.title, x, y + 13 * s, w - 18 * s);
            ctx.drawImage(it.bitmap, x, y + 20 * s, it.bitmap.width * s, it.bitmap.height * s);
          }
          x += w; rowH = Math.max(rowH, h);
        }
        return y + rowH - top;
      };

      const legendH = opts.legends.length ? layout(false, 0) + pad : 0;
      const footH = 26 * s;
      out.width = W;
      out.height = headH + H + legendH + footH;

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, out.width, out.height);

      // intestazione
      ctx.fillStyle = "#14243a";
      ctx.fillRect(0, 0, W, headH);
      ctx.fillStyle = "#ffffff";
      ctx.font = `600 ${22 * s}px system-ui, sans-serif`;
      ctx.textBaseline = "middle";
      ctx.fillText(opts.title || "Mappa", pad, headH / 2, W * 0.6);
      ctx.font = `${12 * s}px system-ui, sans-serif`;
      ctx.textAlign = "right";
      const scale = Math.round(scaleDenominator(map.getZoom(), map.getCenter().lat)).toLocaleString("it-IT");
      ctx.fillText(`Scala indicativa ≈ 1:${scale}`, W - pad, headH / 2 - 8 * s);
      ctx.fillText(new Date().toLocaleDateString("it-IT"), W - pad, headH / 2 + 9 * s);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";

      // mappa
      ctx.drawImage(src, 0, headH);
      ctx.strokeStyle = "#d9dee6";
      ctx.lineWidth = s;
      ctx.strokeRect(0, headH, W, H);

      // legende
      if (opts.legends.length) layout(true, headH + H + pad);

      // piè di pagina
      ctx.fillStyle = "#6a7686";
      ctx.font = `${11 * s}px system-ui, sans-serif`;
      ctx.fillText("Base cartografica © OpenStreetMap contributors", pad, out.height - 9 * s);

      out.toBlob((blob) => {
        if (blob) {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `mappa_${new Date().toISOString().slice(0, 10)}.png`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        }
        resolve();
      }, "image/png");
    });
    map.triggerRepaint();
  });
}
