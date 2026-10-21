import type { ReactNode } from "react";

/**
 * Markdown semplice e sicuro per i widget di testo: titoli (#, ##, ###), paragrafi, elenchi puntati e numerati,
 * **grassetto**, *corsivo*, `codice` e [link](https://...). Nessun HTML: tutto diventa testo React.
 * I link ammessi sono http(s), mailto e percorsi dell'applicazione.
 */
export const safeHref = (h: string) => (/^(https?:\/\/|mailto:|\/(?!\/))/i.test(h.trim()) ? h.trim() : null);

export function inline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\))/g;
  let last = 0, n = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(text));) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[2] !== undefined) out.push(<strong key={k}>{inline(m[2], k)}</strong>);
    else if (m[4] !== undefined) out.push(<em key={k}>{inline(m[4], k)}</em>);
    else if (m[6] !== undefined) out.push(<code key={k}>{m[6]}</code>);
    else {
      const href = safeHref(m[9]);
      out.push(href
        ? <a key={k} href={href} {...(/^https?:/i.test(href) ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{m[8]}</a>
        : <span key={k}>{m[8]}</span>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0, b = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const k = `b${b++}`;
      const content = inline(h[2], k);
      blocks.push(h[1].length === 1 ? <h4 key={k}>{content}</h4> : h[1].length === 2 ? <h5 key={k}>{content}</h5> : <h6 key={k}>{content}</h6>);
      i++; continue;
    }
    const isUl = (l: string) => /^\s*[-*]\s+/.test(l);
    const isOl = (l: string) => /^\s*\d+[.)]\s+/.test(l);
    if (isUl(line) || isOl(line)) {
      const ordered = isOl(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? isOl(lines[i]) : isUl(lines[i]))) { items.push(lines[i].replace(/^\s*([-*]|\d+[.)])\s+/, "")); i++; }
      const k = `b${b++}`;
      const lis = items.map((t, j) => <li key={j}>{inline(t, `${k}-${j}`)}</li>);
      blocks.push(ordered ? <ol key={k}>{lis}</ol> : <ul key={k}>{lis}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^#{1,3}\s/.test(lines[i]) && !isUl(lines[i]) && !isOl(lines[i])) { para.push(lines[i].trim()); i++; }
    const k = `b${b++}`;
    blocks.push(<p key={k}>{inline(para.join(" "), k)}</p>);
  }
  return <div className="md">{blocks}</div>;
}
