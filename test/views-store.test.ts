// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { deleteView, isConfigLayer, loadLocalViews, loadViews, saveView, storeLocalViews, viewOwner, VIEWS_TABLE } from "../src/configStore";
import { ACC, el, fakeKc, mockFetch, XSD } from "./support";

const T = { ...ACC, workspace: "test" };
const VIEWS_XSD = XSD("saved_views", el("owner", "xsd:string") + el("name", "xsd:string") + el("definition", "xsd:string") + el("created_at", "xsd:string"), "http://x/test");
const OK = `<wfs:SUCCESS/>`;
const ST = { v: [1, 2, 3, 0, 0], l: [["a:b", 1, "", "", ""]], b: "sat" } as any;

describe("viste salvate su PostGIS", () => {
  it("la tabella saved_views non è un prodotto", () => {
    expect(VIEWS_TABLE).toBe("saved_views");
    expect(isConfigLayer(T, "test:saved_views")).toBe(true);
    expect(isConfigLayer(T, "altro:saved_views")).toBe(false);
  });
  it("viewOwner: nome utente, altrimenti sub, altrimenti vuoto", () => {
    expect(viewOwner(fakeKc({ preferred_username: "pippo", sub: "1" }))).toBe("pippo");
    expect(viewOwner(fakeKc({ sub: "uuid-1" }))).toBe("uuid-1");
    expect(viewOwner(fakeKc({}))).toBe("");
    expect(viewOwner(null)).toBe("");
  });
  it("loadViews: chiede solo le viste dell'utente (apostrofi raddoppiati), ordina per data e ripulisce lo stato", async () => {
    const f = mockFetch(() => ({
      type: "application/json",
      body: JSON.stringify({ features: [
        { id: "saved_views.1", geometry: null, properties: { owner: "o'neil", name: "Vecchia", definition: JSON.stringify(ST), created_at: "2026-01-01T00:00:00Z" } },
        { id: "saved_views.2", geometry: null, properties: { owner: "o'neil", name: "Nuova", definition: "{rotto", created_at: "2026-02-01T00:00:00Z" } },
      ] }),
    }));
    const r = await loadViews("http://gs", fakeKc({ preferred_username: "o'neil" }), T);
    const u = decodeURIComponent(String(f.mock.calls[0][0]));
    expect(u).toContain("typeName=test:saved_views");
    expect(u).toContain("cql_filter=owner = 'o''neil'");
    expect(r.map((x) => x.name)).toEqual(["Nuova", "Vecchia"]);
    expect(r[0].state).toEqual({ v: undefined, l: [] });      // definizione illeggibile: vista vuota, non un crash
    expect(r[1].state.b).toBe("sat");
  });
  it("senza utente non interroga nulla", async () => {
    const f = mockFetch(() => ({ body: "{}" }));
    expect(await loadViews("http://gs", fakeKc({}), T)).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
  it("saveView: nuovo = Insert con proprietario, data, nome e definizione; esistente = Update senza cambiare proprietario", async () => {
    const bodies: string[] = [];
    mockFetch((u, init) => {
      if (u.includes("DescribeFeatureType")) return { type: "text/xml", body: VIEWS_XSD };
      bodies.push(String(init?.body));
      return { type: "text/xml", body: OK };
    });
    const kc = fakeKc({ preferred_username: "pippo" });
    await saveView("http://gs", kc, T, { name: "Mia <vista> & co", state: ST });
    expect(bodies[0]).toContain("<wfs:Insert>");
    expect(bodies[0]).toContain("<test:owner>pippo</test:owner>");
    expect(bodies[0]).toContain("<test:name>Mia &lt;vista&gt; &amp; co</test:name>");
    expect(bodies[0]).toMatch(/<test:created_at>\d{4}-\d\d-\d\dT/);
    expect(bodies[0]).toContain("&quot;b&quot;:&quot;sat&quot;");
    await saveView("http://gs", kc, T, { fid: "saved_views.5", name: "Rinominata", state: ST });
    expect(bodies[1]).toContain("<wfs:Update");
    expect(bodies[1]).toContain('fid="saved_views.5"');
    expect(bodies[1]).not.toContain("owner");
  });
  it("deleteView: Delete per fid; un rifiuto di GeoServer arriva come errore", async () => {
    let n = 0;
    const bodies: string[] = [];
    mockFetch((u, init) => {
      if (u.includes("DescribeFeatureType")) return { type: "text/xml", body: VIEWS_XSD };
      bodies.push(String(init?.body));
      return ++n === 1 ? { type: "text/xml", body: OK } : { status: 403 };
    });
    await deleteView("http://gs", fakeKc({ preferred_username: "p" }), T, "saved_views.7");
    expect(bodies[0]).toContain("<wfs:Delete");
    await expect(deleteView("http://gs", fakeKc({ preferred_username: "p" }), T, "saved_views.8")).rejects.toThrow(/403/);
  });
});

describe("viste nel browser (senza controllo accessi)", () => {
  beforeEach(() => localStorage.clear());
  it("andata e ritorno; owner 'locale'; stato ripulito", () => {
    storeLocalViews([{ fid: "a", owner: "x", name: "Una", state: ST, createdAt: "2026-01-01" }]);
    const r = loadLocalViews();
    expect(r).toEqual([{ fid: "a", owner: "locale", name: "Una", state: ST, createdAt: "2026-01-01" }]);
  });
  it("contenuto rovinato o storage che lancia: lista vuota senza eccezioni", () => {
    localStorage.setItem("mapp.savedViews", "{non json");
    expect(loadLocalViews()).toEqual([]);
    localStorage.setItem("mapp.savedViews", JSON.stringify([{ x: 1 }, null, { fid: "1", name: "ok", state: {} }]));
    expect(loadLocalViews().map((v) => v.name)).toEqual(["ok"]);
    const spy = Object.getPrototypeOf(localStorage);
    const orig = spy.setItem;
    spy.setItem = () => { throw new Error("quota"); };
    try { expect(() => storeLocalViews([])).not.toThrow(); } finally { spy.setItem = orig; }
  });
});
