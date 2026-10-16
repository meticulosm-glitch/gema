import { describe, expect, it } from "vitest";
import type { Schema } from "../src/api";
import {
  buildDelete, buildGeometry, buildInsert, buildUpdate, gml, insertVertex, kindFor, minPoints,
  moveVertex, parsePath, removeVertex, segments, vertices, type Geom,
} from "../src/edit";

const schema: Schema = {
  prefix: "iride",
  ns: "http://example.com/ns",
  typeName: "parcels",
  geomName: "geom",
  geomType: "Polygon",
  fields: [],
};

describe("gml / transazioni WFS-T", () => {
  it("serializza i tipi GML2 in lon/lat", () => {
    expect(gml({ type: "Point", coordinates: [12.5, 42] })).toBe(
      '<gml:Point srsName="EPSG:4326"><gml:coordinates>12.5,42</gml:coordinates></gml:Point>',
    );
    expect(gml({ type: "LineString", coordinates: [[0, 0], [1, 1]] })).toContain("0,0 1,1");
    const poly = gml({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]], [[0.2, 0.2], [0.3, 0.2], [0.2, 0.2]]] });
    expect(poly).toContain("<gml:outerBoundaryIs>");
    expect(poly).toContain("<gml:innerBoundaryIs>");
    expect(gml({ type: "MultiPoint", coordinates: [[1, 2]] })).toContain("<gml:pointMember>");
    expect(gml({ type: "MultiLineString", coordinates: [[[1, 2], [3, 4]]] })).toContain("<gml:lineStringMember>");
    expect(gml({ type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [0, 0]]]] })).toContain("<gml:polygonMember>");
  });

  it("rifiuta geometrie non supportate", () => {
    expect(() => gml({ type: "GeometryCollection" })).toThrow(/non supportata/);
  });

  it("costruisce insert, update e delete con escape XML", () => {
    const point: Geom = { type: "Point", coordinates: [1, 2] };
    const ins = buildInsert(schema, { nome: `A & B <"x">` }, point);
    expect(ins).toContain('xmlns:iride="http://example.com/ns"');
    expect(ins).toContain("<wfs:Insert><iride:parcels>");
    const amp = "&" + "amp;";
    const lt = "&" + "lt;";
    const gt = "&" + "gt;";
    const quot = "&" + "quot;";
    expect(ins).toContain(`<iride:nome>A ${amp} B ${lt}${quot}x${quot}${gt}</iride:nome>`);
    expect(ins).toContain("<iride:geom><gml:Point");

    const upd = buildUpdate(schema, `id&"1"`, { note: null, nome: "ok" }, point);
    expect(upd).toContain("<wfs:Name>note</wfs:Name></wfs:Property>");
    expect(upd).not.toContain("<wfs:Name>note</wfs:Name><wfs:Value>");
    expect(upd).toContain("<wfs:Name>nome</wfs:Name><wfs:Value>ok</wfs:Value>");
    expect(upd).toContain("<wfs:Name>geom</wfs:Name><wfs:Value><gml:Point");
    expect(upd).toContain(`fid="id${amp}${quot}1${quot}"`);

    const del = buildDelete(schema, "parcels.7");
    expect(del).toContain('<wfs:Delete typeName="iride:parcels"><ogc:Filter><ogc:FeatureId fid="parcels.7"/></ogc:Filter></wfs:Delete>');
  });

  it("non aggiunge la geometria all'update se non è cambiata", () => {
    const upd = buildUpdate(schema, "parcels.1", { nome: "x" });
    expect(upd).not.toContain("gml:Point");
    expect(upd).toContain("<wfs:Name>nome</wfs:Name>");
  });
});

describe("disegno", () => {
  it("deduce il tipo di disegno dal geometry type del layer", () => {
    expect(kindFor("Point")).toBe("point");
    expect(kindFor("MultiPoint")).toBe("point");
    expect(kindFor("LineString")).toBe("line");
    expect(kindFor("MultiLineString")).toBe("line");
    expect(kindFor("Polygon")).toBe("polygon");
    expect(kindFor("MultiPolygon")).toBe("polygon");
    expect(kindFor("Geometry")).toBeNull();
    expect(minPoints("point")).toBe(1);
    expect(minPoints("line")).toBe(2);
    expect(minPoints("polygon")).toBe(3);
  });

  it("chiude l'anello e avvolge i Multi*", () => {
    const pts: [number, number][] = [[0, 0], [1, 0], [1, 1]];
    expect(buildGeometry("point", pts, "Point")).toEqual({ type: "Point", coordinates: [0, 0] });
    expect(buildGeometry("point", pts, "MultiPoint")).toEqual({ type: "MultiPoint", coordinates: [[0, 0]] });
    expect(buildGeometry("line", pts, "LineString").type).toBe("LineString");
    expect(buildGeometry("line", pts, "MultiLineString")).toEqual({ type: "MultiLineString", coordinates: [pts] });
    expect(buildGeometry("polygon", pts, "Polygon")).toEqual({
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
    });
    expect(buildGeometry("polygon", pts, "MultiPolygon").type).toBe("MultiPolygon");
  });
});

describe("vertici", () => {
  it("elenca i vertici escludendo la chiusura degli anelli", () => {
    expect(vertices({ type: "Point", coordinates: [1, 2] })).toEqual([{ path: [], c: [1, 2] }]);
    expect(vertices({ type: "LineString", coordinates: [[0, 0], [1, 1]] }).map((v) => v.path)).toEqual([[0], [1]]);
    expect(vertices({ type: "MultiLineString", coordinates: [[[0, 0], [1, 1]], [[2, 2]]] }).map((v) => v.path)).toEqual([[0, 0], [0, 1], [1, 0]]);
    const poly = vertices({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] });
    expect(poly).toHaveLength(3);
    expect(poly.map((v) => v.path)).toEqual([[0, 0], [0, 1], [0, 2]]);
    const multi = vertices({ type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [0, 0]]]] });
    expect(multi.map((v) => v.path)).toEqual([[0, 0, 0], [0, 0, 1]]);
  });

  it("calcola i punti medi dei segmenti, anello chiuso compreso", () => {
    expect(segments({ type: "Point", coordinates: [0, 0] })).toEqual([]);
    expect(segments({ type: "LineString", coordinates: [[0, 0], [2, 4]] })).toEqual([
      { container: [], at: 1, mid: [1, 2] },
    ]);
    const segs = segments({ type: "Polygon", coordinates: [[[0, 0], [2, 0], [0, 0]]] });
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ container: [0], at: 1, mid: [1, 0] });
    expect(segments({ type: "MultiPolygon", coordinates: [[[[0, 0], [2, 0], [0, 0]]]] })[0].container).toEqual([0, 0]);
  });

  it("sposta un vertice arrotondando e tiene chiuso l'anello", () => {
    const point: Geom = { type: "Point", coordinates: [0, 0] };
    moveVertex(point, [], [1.123456789, -2]);
    expect(point.coordinates).toEqual([1.12345679, -2]);

    const poly: Geom = { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    moveVertex(poly, [0, 0], [5, 6]);
    expect(poly.coordinates[0][0]).toEqual([5, 6]);
    expect(poly.coordinates[0][3]).toEqual([5, 6]);
    expect(poly.coordinates[0][3]).not.toBe(poly.coordinates[0][0]);
  });

  it("inserisce e rimuove vertici solo se la geometria resta valida", () => {
    expect(parsePath("")).toEqual([]);
    expect(parsePath("0,1,2")).toEqual([0, 1, 2]);

    const line: Geom = { type: "LineString", coordinates: [[0, 0], [2, 0]] };
    expect(removeVertex(line, [0])).toBe(false);
    const path = insertVertex(line, { container: [], at: 1, mid: [1, 0] }, [1.000000004, 0]);
    expect(path).toEqual([1]);
    expect(line.coordinates).toEqual([[0, 0], [1, 0], [2, 0]]);
    expect(removeVertex(line, [1])).toBe(true);
    expect(line.coordinates).toEqual([[0, 0], [2, 0]]);

    const tri: Geom = { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    expect(removeVertex(tri, [0, 1])).toBe(false);
    const quad: Geom = { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
    expect(removeVertex(quad, [0, 0])).toBe(true);
    expect(quad.coordinates[0][0]).toEqual([1, 0]);
    expect(quad.coordinates[0].at(-1)).toEqual([1, 0]);

    expect(removeVertex({ type: "Point", coordinates: [0, 0] }, [])).toBe(false);
    const mp: Geom = { type: "MultiPoint", coordinates: [[0, 0], [1, 1]] };
    expect(removeVertex(mp, [0])).toBe(true);
    expect(mp.coordinates).toEqual([[1, 1]]);
    expect(removeVertex(mp, [0])).toBe(false);
  });
});
