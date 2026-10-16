import Keycloak from "keycloak-js";
import type { AppConfig } from "./config";

export async function initAuth(cfg: AppConfig): Promise<Keycloak | null> {
  if (!cfg.keycloak) {
    console.warn("[auth] Keycloak disabilitato (nessun blocco keycloak in config.json)");
    return null;
  }
  const kc = new Keycloak(cfg.keycloak);
  await kc.init({ onLoad: "login-required", pkceMethod: "S256", checkLoginIframe: false });
  setInterval(() => kc.updateToken(30).catch(() => kc.login()), 20_000);
  return kc;
}
