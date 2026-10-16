import { describe, expect, it } from "vitest";
import type { AccessConfig } from "../src/config";
import { computePermissions, layerAllowed, slug, TOOL_IDS, userRoles, type RoleRule } from "../src/roles";
import { roleList } from "../src/AdminRoles";
import type { DashboardDef } from "../src/configStore";

const acc: AccessConfig = {
  enabled: true,
  adminRole: "fss-etl-admin",
  viewerRole: "fss-etl-viewer",
  rolesClient: "mapp-web",
  knownRoles: ["fss-etl-viewer", "fss-etl-ops"],
  workspace: "mapp",
};

const rule = (role: string, layers: string[], tools: RoleRule["tools"]): RoleRule => ({ role, layers, tools });

describe("userRoles", () => {
  it("unisce i client role del client configurato e i realm role, senza duplicati", () => {
    const kc = {
      tokenParsed: {
        resource_access: { "mapp-web": { roles: ["fss-etl-viewer", "extra"] }, other: { roles: ["ignored"] } },
        realm_access: { roles: ["extra", "offline_access"] },
      },
    };
    expect(userRoles(kc as never, acc)).toEqual(["fss-etl-viewer", "extra", "offline_access"]);
  });

  it("tollera un token senza ruoli", () => {
    expect(userRoles({} as never, acc)).toEqual([]);
  });
});

describe("computePermissions", () => {
  it("dà tutto all'admin, indipendentemente dalle regole", () => {
    const p = computePermissions(["fss-etl-admin"], [], acc);
    expect(p.admin).toBe(true);
    expect(p.layers).toBe("*");
    expect([...p.tools].sort()).toEqual([...TOOL_IDS].sort());
    expect(p.none).toBe(false);
    expect(layerAllowed(p, "qualsiasi")).toBe(true);
  });

  it("senza regole salvate il viewer vede tutto in sola lettura, gli altri niente", () => {
    const viewer = computePermissions(["fss-etl-viewer"], [], acc);
    expect(viewer.layers).toBe("*");
    expect(viewer.tools.has("edit")).toBe(false);
    expect(viewer.tools.has("info")).toBe(true);
    expect(viewer.none).toBe(false);

    const stranger = computePermissions(["qualcuno"], [], acc);
    expect(stranger.none).toBe(true);
    expect(stranger.layers).toEqual(new Set());
    expect(layerAllowed(stranger, "a")).toBe(false);
  });

  it("unisce layer e strumenti delle regole che corrispondono ai ruoli", () => {
    const rules = [
      rule("fss-etl-viewer", ["iride:a"], ["info", "table"]),
      rule("fss-etl-ops", ["iride:b", "iride:a"], ["edit"]),
      rule("altro", ["segreto"], ["export"]),
    ];
    const p = computePermissions(["fss-etl-viewer", "fss-etl-ops"], rules, acc);
    expect(p.none).toBe(false);
    expect(p.admin).toBe(false);
    expect(p.layers).toEqual(new Set(["iride:a", "iride:b"]));
    expect([...p.tools].sort()).toEqual(["edit", "info", "table"]);
    expect(layerAllowed(p, "iride:b")).toBe(true);
    expect(layerAllowed(p, "segreto")).toBe(false);
  });

  it("un layer '*' in una regola qualsiasi apre tutti i layer", () => {
    const p = computePermissions(["ops"], [rule("ops", ["iride:a", "*"], ["info"])], acc);
    expect(p.layers).toBe("*");
  });

  it("senza regole corrispondenti non autorizza nulla", () => {
    const p = computePermissions(["ops"], [rule("viewer", ["*"], ["info"])], acc);
    expect(p.none).toBe(true);
    expect(layerAllowed(p, "a")).toBe(false);
  });
});

describe("slug / roleList", () => {
  it("slug toglie gli spazi esterni", () => {
    expect(slug("  fss-etl-ops  ")).toBe("fss-etl-ops");
  });

  it("elenca i ruoli noti, usati e extra, escluso l'admin, in ordine", () => {
    const rules: RoleRule[] = [rule("zeta", [], []), rule("fss-etl-admin", [], []), rule("", [], [])];
    const dashes: DashboardDef[] = [{
      title: "D", description: "", roles: ["ops-dash", "fss-etl-admin"], widgets: [],
    }];
    expect(roleList(acc, rules, dashes, ["extra", "zeta", ""])).toEqual([
      "extra", "fss-etl-ops", "fss-etl-viewer", "ops-dash", "zeta",
    ]);
  });
});
