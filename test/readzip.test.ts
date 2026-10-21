// Il lettore zip dei test di integrazione (Shapefile di GeoServer): unit test con zip costruiti a mano.
import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { readZip } from "./integration/support";

/** Zip come lo scrive java.util.zip in streaming: deflate, flag 8 e dimensioni nella sola directory centrale. */
function javaStyleZip(files: Record<string, string>, method: 0 | 8 = 8): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const n = Buffer.from(name);
    const crc = zlib.crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(method === 8 ? 8 : 0, 6); h.writeUInt16LE(method, 8);
    h.writeUInt16LE(n.length, 26); // crc e dimensioni a zero: arrivano nel data descriptor
    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(body.length, 8); dd.writeUInt32LE(data.length, 12);
    parts.push(h, n, body, dd);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, n);
    off += 30 + n.length + body.length + 16;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

describe("readZip", () => {
  it("legge voci compresse con data descriptor (zip di Java)", () => {
    const z = readZip(javaStyleZip({ "punti.shp": "x".repeat(500), "punti.dbf": "Città di Castello", "punti.cst": "UTF-8" }));
    expect([...z.keys()]).toEqual(["punti.shp", "punti.dbf", "punti.cst"]);
    expect(z.get("punti.dbf")!.toString("utf8")).toBe("Città di Castello");
    expect(z.get("punti.shp")!.length).toBe(500);
  });
  it("legge voci non compresse", () => {
    expect(readZip(javaStyleZip({ "a.txt": "ciao" }, 0)).get("a.txt")!.toString()).toBe("ciao");
  });
  it("rifiuta ciò che non è uno zip", () => {
    expect(() => readZip(Buffer.from("<ServiceException>no</ServiceException>".padEnd(40)))).toThrow("zip non valido");
  });
});
