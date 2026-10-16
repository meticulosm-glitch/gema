import { vi } from "vitest";
import type { AccessConfig } from "../src/config";

export const ACC: AccessConfig = {
  enabled: true, adminRole: "fss-etl-admin", viewerRole: "fss-etl-viewer", rolesClient: "mapp", knownRoles: [], workspace: "mapp",
};

/** Keycloak finto: solo i campi che l'app legge. */
export const fakeKc = (claims: Record<string, unknown> = {}, token = "tok") => ({ token, tokenParsed: claims }) as any;

/** Sostituisce fetch con una funzione che risponde in sequenza o in base all'URL. */
export function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: string; type?: string } | Promise<{ status?: number; body?: string; type?: string }>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = await handler(String(input), init);
    return new Response(r.body ?? "", { status: r.status ?? 200, headers: { "Content-Type": r.type ?? "text/plain" } });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

export const XSD = (typeName: string, body: string, ns = "http://x/ns") =>
  `<?xml version="1.0"?><xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:gml="http://www.opengis.net/gml" targetNamespace="${ns}" elementFormDefault="qualified">` +
  `<xsd:element name="${typeName}" substitutionGroup="gml:_Feature" type="ns:${typeName}Type"/>` +
  `<xsd:complexType name="${typeName}Type"><xsd:complexContent><xsd:extension base="gml:AbstractFeatureType"><xsd:sequence>${body}</xsd:sequence></xsd:extension></xsd:complexContent></xsd:complexType></xsd:schema>`;
export const el = (name: string, type: string) => `<xsd:element name="${name}" type="${type}" minOccurs="0"/>`;
