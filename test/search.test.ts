// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSearchCql, featureLabel, matchedField, MAX_TEXT_FIELDS, searchableFields, searchLayers } from "../src/search";
import { el, mockFetch, XSD } from "./support";

afterEach(() => vi.unstubAllGlobals());
const fields = (...f: [string, string][]) => ({ fields: f.map(([name, type]) => ({ name, type })) });

describe("searchableFields", () => {
  it("separa testo e numeri; scarta nomi non semplici; mette gli attributi 'nome' per primi", () => {
    const r = searchableFields(fields(["note", "string"], ["pop", "int"], ["nome", "string"], ["con spazio", "string"], ["d-x", "string"], ["area", "double"], ["data", "date"]));
    expect(r.text).toEqual(["nome", "note"]);
    expect(r.num).toEqual(["pop", "area"]);
  });
  it(`al massimo ${MAX_TEXT_FIELDS} attributi di testo, tenendo i più utili`, () => {
    const many = Array.from({ length: 20 }, (_, i) => [`campo${i}`, "string"] as [string, string]);
    const r = searchableFields(fields(...many, ["denominazione", "string"]));
    expect(r.text.length).toBe(MAX_TEXT_FIELDS);
    expect(r.text[0]).toBe("denominazione");
  });
});

describe("buildSearchCql", () => {
  it("ILIKE in OR su tutti gli attributi di testo", () => {
    expect(buildSearchCql("bari", { text: ["nome", "comune"], num: [] })).toBe("nome ILIKE '%bari%' OR comune ILIKE '%bari%'");
  });
  it("raddoppia gli apostrofi: nessuna iniezione nel CQL", () => {
    const c = buildSearchCql("l'aquila' OR 1=1 --", { text: ["nome"], num: [] })!;
    expect(c).toBe("nome ILIKE '%l''aquila'' OR 1=1 --%'");
    expect(c.match(/'/g)!.length % 2).toBe(0);
  });
  it("un termine numerico cerca anche nei campi numerici", () => {
    expect(buildSearchCql("42", { text: ["nome"], num: ["pop"] })).toBe("nome ILIKE '%42%' OR pop = 42");
    expect(buildSearchCql("-3.5", { text: [], num: ["x"] })).toBe("x = -3.5");
    expect(buildSearchCql("42abc", { text: ["nome"], num: ["pop"] })).toBe("nome ILIKE '%42abc%'");
  });
  it("niente da cercare -> null (termine vuoto o nessun attributo adatto)", () => {
    expect(buildSearchCql("   ", { text: ["a"], num: [] })).toBeNull();
    expect(buildSearchCql("x", { text: [], num: ["n"] })).toBeNull();
  });
  it("termine troncato a 80 caratteri", () => {
    expect(buildSearchCql("a".repeat(500), { text: ["n"], num: [] })!.length).toBeLessThan(120);
  });
});

describe("featureLabel / matchedField", () => {
  it("preferisce l'attributo nome (senza badare alle maiuscole), poi il primo testo, poi l'id", () => {
    expect(featureLabel({ geometry: null, properties: { x: "zzz", Nome: "Bari" } })).toBe("Bari");
    expect(featureLabel({ geometry: null, properties: { n: 5, altro: "uno" } })).toBe("uno");
    expect(featureLabel({ id: "t.9", geometry: null, properties: { n: 5 } })).toBe("t.9");
    expect(featureLabel({ geometry: null, properties: null })).toBe("(oggetto)");
  });
  it("matchedField mostra dove compare il termine, se non è già l'etichetta", () => {
    const f = { geometry: null, properties: { nome: "Bari", provincia: "Città di BARI" } };
    expect(matchedField(f, "bari", "Bari")).toBe("provincia: Città di BARI");
    expect(matchedField({ geometry: null, properties: { nome: "Bari" } }, "bari", "Bari")).toBeUndefined();
  });
});

describe("searchLayers", () => {
  const SCHEMA = (n: string) => XSD(n, el("nome", "xsd:string") + el("pop", "xsd:int") + el("the_geom", "gml:PointPropertyType"), "http://x/t");
  const feat = (id: string, nome: string) => ({ id, geometry: { type: "Point", coordinates: [1, 2] }, properties: { nome } });
  const layers = [{ name: "t:citta", title: "Città" }, { name: "t:raster", title: "Ortofoto" }, { name: "t:rotto", title: "Rotto" }, { name: "t:strade", title: "Strade" }];

  it("cerca in parallelo, salta i raster, riporta gli errori per layer e ordina come l'elenco", async () => {
    const urls: string[] = [];
    mockFetch((u) => {
      urls.push(u);
      if (u.includes("DescribeFeatureType")) {
        if (u.includes("raster")) return { status: 400, body: `<ServiceException>Could not find type t:raster</ServiceException>` };
        return { type: "text/xml", body: SCHEMA(u.includes("citta") ? "citta" : u.includes("rotto") ? "rotto" : "strade") };
      }
      if (u.includes("typeName=t%3Arotto")) return { status: 500, body: "<ServiceException>boom</ServiceException>" };
      if (u.includes("typeName=t%3Astrade")) return { type: "application/json", body: JSON.stringify({ features: [feat("strade.1", "Via Bari")] }) };
      return { type: "application/json", body: JSON.stringify({ features: [feat("citta.1", "Bari"), feat("citta.2", "Bari vecchia")] }) };
    });
    const r = await searchLayers("http://gs/geoserver", null, layers, "bari", 5);
    expect(r.hits.map((h) => `${h.title}:${h.label}`)).toEqual(["Città:Bari", "Città:Bari vecchia", "Strade:Via Bari"]);
    expect(r.skipped).toEqual(["Ortofoto"]);
    expect(r.errors).toEqual([{ layer: "Rotto", message: "boom" }]);
    const wfs = urls.filter((u) => u.includes("GetFeature"));
    expect(wfs.length).toBe(3);
    expect(decodeURIComponent(wfs[0])).toContain("cql_filter=nome ILIKE '%bari%'");
    expect(wfs[0]).toContain("maxFeatures=5");
  });
});
