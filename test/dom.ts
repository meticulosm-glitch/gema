import { DOMParser as XmlDOMParser } from "@xmldom/xmldom";

/**
 * DOMParser allineato al browser per i test Node.
 * @xmldom implementa localName / children / getElementsByTagName("*");
 * non ha querySelector e, a differenza del browser, lancia su XML non valido.
 */
function withQuery(doc: { getElementsByTagName: (t: string) => { length: number; [i: number]: unknown } }) {
  const anyDoc = doc as { querySelector?: (sel: string) => unknown };
  if (typeof anyDoc.querySelector !== "function") {
    anyDoc.querySelector = (sel: string) => {
      if (sel !== "parsererror") return null;
      const found = doc.getElementsByTagName("parsererror");
      return found.length ? found[0] : null;
    };
  }
  return doc;
}

class DOMParser {
  parseFromString(xml: string, type: string) {
    try {
      const doc = new XmlDOMParser({
        onError(level, msg) {
          if (level === "fatalError") throw new Error(String(msg));
        },
      }).parseFromString(xml, type as "text/xml");
      return withQuery(doc);
    } catch {
      const doc = new XmlDOMParser().parseFromString("<parsererror>not xml</parsererror>", "text/xml");
      return withQuery(doc);
    }
  }
}

export function installDom(): void {
  (globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser = DOMParser;
}
