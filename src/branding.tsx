import { useState } from "react";
import type { AppConfig } from "./config";

/** Logo (o lettera) e nome nell'header. Se c'è un logo e nessun titolo, il testo non viene mostrato. */
export function Brand({ cfg }: { cfg: AppConfig }) {
  const [broken, setBroken] = useState(false);
  const hasLogo = !!cfg.logo && !broken;
  // il logo di solito contiene già il nome: il testo compare solo senza logo o se richiesto (LOGO_SHOW_TITLE)
  const name = hasLogo ? (cfg.logoShowTitle ? cfg.title || "" : "") : cfg.title || "MApp Web";
  return (
    <div className="brand">
      {cfg.logo && !broken ? (
        <img className="brand-logo" src={cfg.logo} alt={cfg.title || "Logo"} style={{ height: cfg.logoHeight || 28 }} onError={() => setBroken(true)} />
      ) : (
        <span className="logo">{(cfg.title || "M").trim().charAt(0).toUpperCase()}</span>
      )}
      {name && <span>{name}</span>}
    </div>
  );
}

/** Loghi aggiuntivi a destra, su sfondo chiaro così restano leggibili anche se pensati per carta bianca. */
export function PartnerLogos({ cfg }: { cfg: AppConfig }) {
  const [hidden, setHidden] = useState<string[]>([]);
  const list = (cfg.partnerLogos ?? []).filter((s) => !hidden.includes(s));
  if (list.length === 0) return null;
  return (
    <div className="partner-logos">
      {list.map((src) => (
        <img key={src} src={src} alt={src.split("/").pop()?.replace(/\.\w+$/, "") ?? "logo"} style={{ height: cfg.logoHeight || 28 }} onError={() => setHidden((h) => [...h, src])} />
      ))}
    </div>
  );
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Titolo, favicon e colori di marca da configurazione. */
export function applyBranding(cfg: AppConfig) {
  if (cfg.title) document.title = cfg.title;
  const st = document.documentElement.style;
  if (cfg.accent && HEX.test(cfg.accent)) st.setProperty("--c-accent-base", cfg.accent);
  if (cfg.headerColor && HEX.test(cfg.headerColor)) {
    const h = cfg.headerColor;
    const mix = (pct: number) => `color-mix(in srgb, ${h} ${100 - pct}%, white)`;
    st.setProperty("--brand-header", h);
    // superfici del tema scuro: lo stesso colore dell'header, via via più chiaro
    st.setProperty("--brand-bg", mix(4));
    st.setProperty("--brand-panel", mix(7));
    st.setProperty("--brand-border", mix(16));
    st.setProperty("--brand-row", mix(11));
  }
  if (cfg.partnerLogosBg === "none") { st.setProperty("--partner-bg", "transparent"); st.setProperty("--partner-pad", "0px"); }
  else if (cfg.partnerLogosBg && HEX.test(cfg.partnerLogosBg)) st.setProperty("--partner-bg", cfg.partnerLogosBg);
  if (!cfg.favicon) return;
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.appendChild(link); }
  link.removeAttribute("type");
  link.href = cfg.favicon;
}
