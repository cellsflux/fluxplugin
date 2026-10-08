import React, { type ReactNode } from "react";

/** Only https links (and in-page anchors) are clickable; everything else is rendered as text. */
const safeHref = (h: string): string | undefined => (/^https:\/\/[^\s]+$/i.test(h) || h.startsWith("#") ? h : undefined);

function inline(src: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const tok = m[0];
    const k = `${key}-${i++}`;
    if (tok.startsWith("`")) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**")) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("*")) out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    else {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      const href = safeHref(mm[2]!);
      out.push(href ? <a key={k} href={href} target="_blank" rel="noopener noreferrer">{mm[1]}</a> : mm[1]);
    }
    last = m.index + tok.length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

/**
 * Small, safe Markdown renderer for plugin descriptions: headings, paragraphs, lists, quotes, code blocks, rules,
 * bold/italic/inline code and https links. Raw HTML is never interpreted (it is shown as text) and images are not loaded.
 */
export function Markdown({ source }: { source: string }): React.ReactElement {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    if (line.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) buf.push(lines[i++]!);
      i++;
      blocks.push(<pre key={k++}><code>{buf.join("\n")}</code></pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { const L = `h${h[1]!.length + 1}` as "h2"; blocks.push(React.createElement(L, { key: k++ }, inline(h[2]!))); i++; continue; }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { blocks.push(<hr key={k++} />); i++; continue; }
    if (line.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) buf.push(lines[i++]!.replace(/^>\s?/, ""));
      blocks.push(<blockquote key={k++}>{inline(buf.join(" "))}</blockquote>);
      continue;
    }
    // GFM-style table: header row, separator row (---), body rows.
    if (line.includes("|") && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] ?? "")) {
      const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      blocks.push(
        <table key={k++}>
          <thead><tr>{head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead>
          <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>)}</tbody>
        </table>,
      );
      continue;
    }
    const li = /^(\s*)([-*]|\d+\.)\s+/;
    if (li.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && li.test(lines[i]!)) items.push(<li key={items.length}>{inline(lines[i++]!.replace(li, ""))}</li>);
      blocks.push(ordered ? <ol key={k++}>{items}</ol> : <ul key={k++}>{items}</ul>);
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|```|>|\s*([-*]|\d+\.)\s)/.test(lines[i]!) && !(lines[i]!.includes("|") && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? ""))) buf.push(lines[i++]!);
    blocks.push(<p key={k++}>{inline(buf.join(" "))}</p>);
  }
  return <div className="flux-md">{blocks}</div>;
}
