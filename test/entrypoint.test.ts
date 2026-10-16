import { describe, expect, it } from "vitest";
import { runEntrypoint } from "./shell";

describe("40-runtime-config.sh", () => {
  it("non sovrascrive un config.json già montato", async () => {
    const r = await runEntrypoint("40-runtime-config.sh", {}, { preexistingConfig: '{"tenuto":true}\n' });
    expect(r.code).toBe(0);
    expect(r.configJson).toBe('{"tenuto":true}\n');
    expect(r.stdout).toContain("generazione saltata");
  });

  it("rifiuta l'avvio se l'auth è attiva e manca Keycloak", async () => {
    const r = await runEntrypoint("40-runtime-config.sh", { AUTH_ENABLED: "true" });
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("KEYCLOAK_URL");
    expect(r.configJson).toBeNull();
  });

  it("genera la config di default con auth disattivata", async () => {
    const r = await runEntrypoint("40-runtime-config.sh", {
      AUTH_ENABLED: "false",
      ACCESS_CONTROL: "true",
      APP_TITLE: `G.E.M.A "nord"`,
      LOGO_HEIGHT: "abc",
      APP_HEADER_COLOR: "#aabbcc",
      PARTNER_LOGOS_BG: "none",
      PARTNER_LOGOS: " /logos/a.svg , /logos/b.png,, ",
      BASEMAP_TILES: "",
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("ACCESS_CONTROL ignorato");
    const cfg = JSON.parse(r.configJson ?? "");
    expect(cfg.keycloak).toBeUndefined();
    expect(cfg.access).toBeUndefined();
    expect(cfg.apiUrl).toBe("/api");
    expect(cfg.geoserverUrl).toBe("/geoserver");
    expect(cfg.basemapTiles).toBe("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
    expect(cfg.mapCenter).toEqual([12.5, 42]);
    expect(cfg.mapZoom).toBe(5);
    expect(cfg.title).toBe(`G.E.M.A "nord"`);
    expect(cfg.logoHeight).toBe(28);
    expect(cfg.headerColor).toBe("#aabbcc");
    expect(cfg.partnerLogosBg).toBe("none");
    expect(cfg.partnerLogos).toEqual(["/logos/a.svg", "/logos/b.png"]);
    expect(cfg.editEnabled).toBe(false);
    expect(cfg.logoShowTitle).toBe(false);
  });

  it("con il proxy il browser usa i path relativi e attiva accessi ed editing", async () => {
    const r = await runEntrypoint("40-runtime-config.sh", {
      KEYCLOAK_URL: "https://kc.example/auth",
      KEYCLOAK_REALM: "iride",
      KEYCLOAK_CLIENT_ID: "mapp-web",
      GEOSERVER_PROXY_URL: "http://geoserver.ns:8080/geoserver",
      GEOSERVER_URL: "http://non-usare",
      BACKEND_URL: "http://api.ns:8000",
      API_URL: "http://non-usare",
      ACCESS_CONTROL: "yes",
      ADMIN_ROLE: "admin-x",
      VIEWER_ROLE: "viewer-x",
      KNOWN_ROLES: " viewer-x, ops ",
      CONFIG_WORKSPACE: "cfg",
      EDIT_ENABLED: "1",
      EDIT_ROLE: "editor",
      LOGO_SHOW_TITLE: "TRUE",
      LOGO_HEIGHT: "40",
      APP_ACCENT: "#112233",
      TERRAIN_TILES: "https://dem/{z}/{x}/{y}.png",
      MAP_CENTER_LON: "9.1",
      MAP_CENTER_LAT: "45",
      MAP_ZOOM: "8",
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("GEOSERVER_URL ignorata");
    expect(r.stdout).toContain("API_URL ignorata");
    const cfg = JSON.parse(r.configJson ?? "");
    expect(cfg.keycloak).toEqual({ url: "https://kc.example/auth", realm: "iride", clientId: "mapp-web" });
    expect(cfg.geoserverUrl).toBe("/geoserver");
    expect(cfg.apiUrl).toBe("/api");
    expect(cfg.access).toEqual({
      enabled: true,
      adminRole: "admin-x",
      viewerRole: "viewer-x",
      rolesClient: "mapp-web",
      knownRoles: ["viewer-x", "ops"],
      workspace: "cfg",
    });
    expect(cfg.editEnabled).toBe(true);
    expect(cfg.editRole).toBe("editor");
    expect(cfg.logoShowTitle).toBe(true);
    expect(cfg.logoHeight).toBe(40);
    expect(cfg.accent).toBe("#112233");
    expect(cfg.terrainTiles).toBe("https://dem/{z}/{x}/{y}.png");
    expect(cfg.mapCenter).toEqual([9.1, 45]);
    expect(cfg.mapZoom).toBe(8);
  });
});

describe("35-proxy-config.sh", () => {
  it("senza upstream risponde 503 e inoltra l'Authorization del browser", async () => {
    const r = await runEntrypoint("35-proxy-config.sh", { GEOCODER: "off" }) // il geocoder è attivo di default e ha un proprio proxy_pass;
    expect(r.code, r.stderr).toBe(0);
    expect(r.proxyConf).toContain(`location /api/`);
    expect(r.proxyConf).toContain(`{"error":"BACKEND_URL non configurata"}`);
    expect(r.proxyConf).toContain(`{"error":"GEOSERVER_PROXY_URL non configurata"}`);
    expect(r.proxyConf).not.toContain("proxy_pass");
    expect(r.authMap).toContain("default $http_authorization;");
    expect(r.authMap).toContain("POST    $http_authorization;");
    expect(r.stdout).toContain("nessuna credenziale di lettura");
  });

  it("proxia /api e /geoserver in sola lettura", async () => {
    const r = await runEntrypoint("35-proxy-config.sh", {
      BACKEND_URL: "http://api.internal:8000/",
      GEOSERVER_PROXY_URL: "https://gs.example:8443/geoserver/",
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.proxyConf).toContain("location /api/ {");
    expect(r.proxyConf).toContain("proxy_pass http://api.internal:8000/;");
    expect(r.proxyConf).toContain("proxy_set_header Host api.internal:8000;");
    expect(r.proxyConf).toContain("location /geoserver/ {");
    expect(r.proxyConf).toContain("limit_except GET { deny all; }");
    expect(r.proxyConf).toContain("proxy_pass https://gs.example:8443/geoserver/;");
    expect(r.proxyConf).toContain("proxy_ssl_server_name on;");
    expect(r.proxyConf).toContain("proxy_ssl_name gs.example;");
    expect(r.proxyConf).toContain("proxy_set_header Host gs.example:8443;");
    expect(r.proxyConf).not.toContain("location = /geoserver/wfs");
  });

  it("con EDIT o ACCESS_CONTROL apre solo il POST su /geoserver/wfs", async () => {
    const read = Buffer.from("reader:p@ss\"word").toString("base64");
    const write = Buffer.from("writer:secret").toString("base64");
    const edited = await runEntrypoint("35-proxy-config.sh", {
      GEOSERVER_PROXY_URL: "http://gs:8080/geoserver",
      EDIT_ENABLED: "true",
      GEOSERVER_USER: "reader",
      GEOSERVER_PASSWORD: `p@ss"word`,
      GEOSERVER_WRITE_USER: "writer",
      GEOSERVER_WRITE_PASSWORD: "secret",
    });
    expect(edited.code, edited.stderr).toBe(0);
    expect(edited.proxyConf).toContain("location = /geoserver/wfs {");
    expect(edited.proxyConf).toContain("limit_except GET POST { deny all; }");
    expect(edited.proxyConf).toContain("client_max_body_size 10m;");
    expect(edited.proxyConf).toContain("proxy_pass http://gs:8080/geoserver/wfs;");
    expect(edited.authMap).toContain(`default "Basic ${read}";`);
    expect(edited.authMap).toContain(`POST    "Basic ${write}";`);
    expect(edited.stdout).toContain("POST consentito");

    const viaAccess = await runEntrypoint("35-proxy-config.sh", {
      GEOSERVER_PROXY_URL: "http://gs:8080/geoserver",
      ACCESS_CONTROL: "true",
      AUTH_ENABLED: "true",
    });
    expect(viaAccess.proxyConf).toContain("location = /geoserver/wfs {");
    expect(viaAccess.stdout).toContain("ATTENZIONE");

    const ignored = await runEntrypoint("35-proxy-config.sh", {
      GEOSERVER_PROXY_URL: "http://gs:8080/geoserver",
      ACCESS_CONTROL: "true",
      AUTH_ENABLED: "false",
      EDIT_ENABLED: "false",
    });
    expect(ignored.proxyConf).not.toContain("location = /geoserver/wfs");
  });

  it("il passthrough di scrittura inoltra il Bearer e le password possono arrivare da file", async () => {
    const dir = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = await dir.mkdtemp(path.join(os.tmpdir(), "mapp-secret-"));
    const userFile = path.join(tmp, "user");
    const passFile = path.join(tmp, "pass");
    await dir.writeFile(userFile, "file-user");
    await dir.writeFile(passFile, "file-pass");
    try {
      const basic = Buffer.from("file-user:file-pass").toString("base64");
      const r = await runEntrypoint("35-proxy-config.sh", {
        GEOSERVER_PROXY_URL: "http://gs:8080/geoserver",
        EDIT_ENABLED: "yes",
        GEOSERVER_USER_FILE: userFile,
        GEOSERVER_PASSWORD_FILE: passFile,
        GEOSERVER_WRITE_PASSTHROUGH: "true",
      });
      expect(r.code, r.stderr).toBe(0);
      expect(r.authMap).toContain(`default "Basic ${basic}";`);
      expect(r.authMap).toContain("POST    $http_authorization;");
      expect(r.stdout).toContain("inoltro l'header Authorization");
    } finally {
      await dir.rm(tmp, { recursive: true, force: true });
    }
  });
});
