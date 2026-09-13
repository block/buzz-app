import { parseBuzzLink } from "../navigation/buzz-links";

type LinkPart = { text: string; url?: string; label?: string };

function validUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "buzz:"
      ? !!parseBuzzLink(url)
      : parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

const unescapeLink = (text: string) => text.replace(/\\([[\]()\\])/g, "$1");

/** Find the wrapper's end without cutting parentheses out of a URL. */
function closingParenthesis(content: string, start: number, escaped: boolean) {
  let depth = 1;
  let delimiters = 0;
  for (let index = start; index < content.length; index++) {
    const char = content[index];
    // Bound repeated malformed wrappers without limiting ordinary URL length.
    // A candidate cannot repeatedly rescan an unbounded number of later openers.
    if ((char === "(" || char === ")" || char === "\\") && ++delimiters > 100)
      return undefined;
    if (char === "\n" || char === "\r") return undefined;
    if (char === "\\") {
      // Some pasted links escape the outer parentheses as well as URL syntax.
      if (escaped && content[index + 1] === ")" && depth === 1)
        return { close: index, end: index + 2 };
      index++;
      continue;
    }
    if (char === "(") depth++;
    if (char === ")" && --depth === 0) return { close: index, end: index + 1 };
  }
  return undefined;
}

/** Display-only link syntax. Message storage and navigation keep the original destination. */
export function messageLinkParts(
  content: string,
  onLabeledLink?: (
    start: number,
    end: number,
    label: string,
    url: string,
  ) => void,
): LinkPart[] {
  const parts: LinkPart[] = [];
  let offset = 0;
  for (const match of content.matchAll(
    /(?<!\\)\[((?:\\[^\r\n]|[^[\]\\\r\n])+)\]\\?\(|<(?:https?|buzz):\/\/[^\s<>"`]+>|(?:https?|buzz):\/\/[^\s<>"`]+/g,
  )) {
    if (match.index < offset) continue;
    if (match[1] !== undefined) {
      const start = match.index + match[0].length;
      const closing = closingParenthesis(
        content,
        start,
        match[0].endsWith("\\("),
      );
      if (!closing) continue;
      let url = content.slice(start, closing.close).trim();
      // A pasted autolink can itself be Markdown: [label]([url](url)).
      const nested = /^\[([^\]\r\n]+)\]\((.+)\)$/.exec(url);
      if (nested && nested[1] === nested[2]) url = nested[1] ?? url;
      if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1);
      url = unescapeLink(url);
      const label = unescapeLink(match[1]).trim();
      if (!label || /\s/.test(url) || !validUrl(url)) continue;
      parts.push({ text: content.slice(offset, match.index) });
      parts.push({ text: label, label, url });
      onLabeledLink?.(match.index, closing.end, label, url);
      offset = closing.end;
      continue;
    }
    parts.push({ text: content.slice(offset, match.index) });
    const wrapped = match[0].startsWith("<");
    const candidate = wrapped ? match[0].slice(1, -1) : match[0];
    const url = wrapped ? candidate : candidate.replace(/[.,;:!?)\]}]+$/, "");
    if (validUrl(url)) {
      parts.push({ text: url, url });
      if (!wrapped) parts.push({ text: candidate.slice(url.length) });
    } else {
      parts.push({ text: match[0] });
    }
    offset = match.index + match[0].length;
  }
  parts.push({ text: content.slice(offset) });
  return parts;
}

/** Repair pasted escaped/nested wrappers before Markdown, except in literal contexts. */
export function normalizeWrappedLinks(
  content: string,
  isLiteral: (start: number, end: number) => boolean,
) {
  let result = "";
  let offset = 0;
  messageLinkParts(content, (start, end, label, url) => {
    const source = content.slice(start, end);
    if (
      isLiteral(start, end) ||
      (!source.includes("]\\(") && !source.includes("](["))
    )
      return;
    result += content.slice(offset, start);
    result += `[${label.replace(/[\\[\]]/g, "\\$&")}](${url.replace(/[()]/g, (char) => (char === "(" ? "%28" : "%29"))})`;
    offset = end;
  });
  return result + content.slice(offset);
}
