import {
  DOMSerializer,
  Fragment,
  type Node as EditorNode,
} from "prosemirror-model";
import { parseBuzzLink } from "../navigation/buzz-links";
import { profileKey, profileTarget } from "../profiles/target";
import { safeLinkUrl, scanMarkdown } from "../relay/message-content";
import {
  composerSchema,
  projectComposerDocument,
  readComposerSnapshot,
} from "./composer-document";
import {
  composerMarkdown,
  type ComposerMarkdownMode,
} from "./composer-markdown";
import { bareHostParts, messageLinkParts } from "./message-link-parts";
import { documentEditorDraft } from "./document-editor-markdown";
import {
  copyDocument,
  serializeNode,
  spoilerDelimiter,
} from "./selection-copy";

/** The identity locator a whole source is: `[@Name](nostr:npub…)`. */
export function identityLink(
  source: string,
): { pubkey: string; name: string } | undefined {
  const link = markdownLink(source);
  const pubkey = link && profileKey(link.href);
  const name = link?.label.replace(/^@/, "");
  return pubkey && name ? { pubkey, name } : undefined;
}

/** Read labels with Markdown semantics, including escapes and entities. */
function markdownLink(
  source: string,
): { href: string; label: string } | undefined {
  const { links } = scanMarkdown(source);
  const link = links.length === 1 ? links[0] : undefined;
  if (
    !link?.url ||
    link.position?.start.offset !== 0 ||
    link.position.end.offset !== source.length
  )
    return;
  let name = "";
  const pending = [...(link.children ?? [])].reverse();
  while (pending.length) {
    const node = pending.pop();
    if (node?.value) name += node.value;
    else pending.push(...(node?.children ?? []).slice().reverse());
  }
  return { href: link.url, label: name };
}

/** The anchor a token stands for: a recipient, a resource, a link the
 * normalize plugin recognised, or an identity locator. Other tokens are text. */
function tokenLink(
  node: EditorNode,
): { href: string; label: string } | undefined {
  const { source, recipient, resource } = node.attrs;
  if (node.attrs.semantic) return;
  if (recipient) {
    const href = profileTarget(recipient.pubkey);
    return href ? { href, label: source } : undefined;
  }
  if (resource) return { href: resource.uri, label: resource.label };
  let link: { href: string; label: string } | undefined;
  messageLinkParts(
    source,
    (start, end, label, href) => {
      if (start === 0 && end === source.length)
        link = { href, label: markdownLink(source)?.label ?? label };
    },
    (start, end, href) => {
      if (start === 0 && end === source.length) link ??= { href, label: href };
    },
  );
  if (link) return link;
  const identity = identityLink(source);
  const href = identity && profileTarget(identity.pubkey);
  return identity && href ? { href, label: `@${identity.name}` } : undefined;
}

// The semantic `text/html` flavor, in the shapes selection-copy.ts reads back.
// Marks without a spec (recipient, literal) are plain text.
const serializer = new DOMSerializer(
  {
    paragraph: () => ["p", 0],
    blockquote: () => ["blockquote", 0],
    code_block: (node) => [
      "pre",
      [
        "code",
        node.attrs.language ? { class: `language-${node.attrs.language}` } : {},
        `${node.textContent}\n`,
      ],
    ],
    bullet_list: () => ["ul", 0],
    ordered_list: (node) => [
      "ol",
      node.attrs.order === 1 ? {} : { start: node.attrs.order },
      0,
    ],
    list_item: () => ["li", 0],
    hard_break: () => ["br"],
    token: (node) => {
      const link = tokenLink(node);
      return link
        ? ["a", { href: link.href }, link.label]
        : ["span", node.attrs.source];
    },
  },
  {
    bold: () => ["strong", 0],
    italic: () => ["em", 0],
    strike: () => ["s", 0],
    code: () => ["code", 0],
    link: (mark) => ["a", { href: mark.attrs.href }, 0],
    spoiler: () => ["span", { "data-spoiler": "" }, 0],
  },
);

/** Identity and channel locators read as their sigil-prefixed names outside the app. */
function humanised(node: EditorNode): EditorNode {
  if (node.type.name === "token") {
    if (node.attrs.semantic)
      return composerSchema.text(node.attrs.source, node.marks);
    const link = node.attrs.recipient ? undefined : tokenLink(node);
    const buzz = link && parseBuzzLink(link.href);
    return link &&
      link.label !== link.href &&
      (profileKey(link.href) || (buzz?.format === "legacy" && !buzz.messageId))
      ? composerSchema.text(link.label, node.marks)
      : node;
  }
  return node.isLeaf
    ? node
    : node.copy(Fragment.fromArray(node.content.content.map(humanised)));
}

/** Both clipboard flavors of a composer document. `text` is the Markdown source
 * as a reader expects it; `html` carries every locator for this app's own paste
 * handler and other rich editors. */
export function composerClipboard(
  doc: EditorNode,
  document: Document,
  mode: ComposerMarkdownMode = "chat",
) {
  const spread = (node: EditorNode) => ({
    "data-buzz-spread": String(node.attrs.spread === true),
  });
  const writer =
    mode === "document"
      ? new DOMSerializer(
          {
            ...serializer.nodes,
            heading: (node) => [`h${node.attrs.level}`, 0],
            markdown_table: (node) => ["p", node.attrs.source],
            bullet_list: (node) => ["ul", spread(node), 0],
            ordered_list: (node) => [
              "ol",
              { start: node.attrs.order, ...spread(node) },
              0,
            ],
            list_item: (node) => ["li", spread(node), 0],
          },
          serializer.marks,
        )
      : serializer;
  const fragment = writer.serializeFragment(doc.content, { document });
  // Spoilers have no HTML of their own: their delimiters stay visible inside
  // the mark's span, marked so this app's paste reads the mark alone.
  for (const spoiler of fragment.querySelectorAll("[data-spoiler]"))
    for (const position of ["afterbegin", "beforeend"] as const)
      spoiler.insertAdjacentHTML(position, spoilerDelimiter);
  // Line breaks inside prose are whitespace to HTML; code blocks keep theirs.
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  const breaks: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (
      (node as Text).data.includes("\n") &&
      !node.parentElement?.closest("pre")
    )
      breaks.push(node as Text);
  for (const text of breaks) {
    const lines = text.data
      .split("\n")
      .flatMap((line, index) =>
        index ? [document.createElement("br"), line] : [line],
      );
    if (mode === "document") {
      // Embedded source lines are not semantic hard-break nodes. The existing
      // source-span importer restores these bytes instead of interpreting <br>.
      const source = document.createElement("span");
      source.setAttribute("data-source", text.data);
      source.append(...lines);
      text.replaceWith(source);
    } else text.replaceWith(...lines);
  }
  const container = document.createElement("div");
  container.appendChild(fragment);
  return {
    text: composerMarkdown(projectComposerDocument(humanised(doc)).draft, {
      authored: true,
      mode,
    }),
    html: `<div data-buzz-copy="${mode === "document" ? "document" : "composer"}">${container.innerHTML}</div>`,
  };
}

/** This app's own `text/html` payload as editor content; other HTML is never
 * read. Its blocks and marks paste as they are, while anchors and line breaks
 * become source text: the host's decorations decide which links are chips, as
 * for typed source. Chat keeps line breaks as source text; document mode retains
 * hard-break nodes and list spacing. */
export function buzzCopyDocument(
  html: string,
  mode: ComposerMarkdownMode = "chat",
): EditorNode | undefined {
  if (!html.includes("data-buzz-copy")) return;
  const copy = new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector("[data-buzz-copy]");
  return (
    (copy && sourced(copyDocument(copy, undefined, mode), mode)) ?? undefined
  );
}

function sourced(
  node: EditorNode,
  mode: ComposerMarkdownMode,
): EditorNode | null {
  if (node.isText || (mode === "document" && node.type.name === "hard_break"))
    return node;
  const first = node.firstChild;
  if (
    mode === "document" &&
    node.type === composerSchema.nodes.paragraph &&
    node.childCount === 1 &&
    first?.type === composerSchema.nodes.token &&
    /[\r\n]/.test(first.attrs.source)
  ) {
    const parsed = readComposerSnapshot(
      documentEditorDraft(first.attrs.source).document,
      mode,
    );
    if (
      parsed?.childCount === 1 &&
      parsed.firstChild?.type === composerSchema.nodes.markdown_table
    )
      return parsed.firstChild;
  }
  // The schema refuses empty text nodes; a leaf without text contributes none.
  if (node.isLeaf)
    return node.textContent
      ? composerSchema.text(node.textContent, node.marks)
      : null;
  return node.copy(
    Fragment.fromArray(
      node.content.content.flatMap((child) => sourced(child, mode) ?? []),
    ),
  );
}

/** The files a paste attaches. Office and iWork put a picture of copied text
 * beside it, which WebKit offers as an image file; when the HTML flavor has
 * text, those images render it and the paste is that text. Every text path,
 * raw and code included, can fall back to plain text, so it must have some. */
export function pastedFiles(data: DataTransfer | null): File[] {
  const files = Array.from(data?.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  const html =
    files.length &&
    files.every((file) => file.type.startsWith("image/")) &&
    data?.getData("text/plain").trim()
      ? data.getData("text/html")
      : "";
  return html &&
    new DOMParser().parseFromString(html, "text/html").body.textContent?.trim()
    ? []
    : files;
}

const hiddenStylePattern =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i;
const blockElementTag =
  /^(DIV|P|LI|OL|UL|SECTION|ARTICLE|HEADER|FOOTER|MAIN|ASIDE|NAV|TABLE|THEAD|TBODY|TFOOT|TR|TD|TH|BLOCKQUOTE|PRE|H[1-6]|BR|DT|DD|DL|FIGCAPTION)$/;
const tokenPattern =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc\u3005\u3006]|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc\u3005\u3006])[\p{L}\p{N}_])+|[^\s\u200b\ufeff]/gu;
const wordPattern = /^[\p{L}\p{N}_]+$/u;

type TextToken = {
  value: string;
  word: boolean;
  start: number;
  end: number;
};

type HtmlToken = TextToken & {
  fullyLinked: boolean;
};

type ExtractedLink = {
  href: string;
  rawHref: string;
  start: number;
  end: number;
};

type TextRange = { start: number; end: number };

function tokenize(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  for (const match of text.matchAll(tokenPattern)) {
    const value = match[0];
    const start = match.index ?? 0;
    tokens.push({
      value,
      word: wordPattern.test(value),
      start,
      end: start + value.length,
    });
  }
  return tokens;
}

/** Longest increasing subsequence of `[htmlIndex, plainIndex]` pairs by `plainIndex`. */
function increasingAnchors(
  pairs: readonly [number, number][],
): Array<[number, number]> {
  if (pairs.length <= 1) return [...pairs];
  const tails: number[] = [];
  const prev = new Int32Array(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (!pair) continue;
    const target = pair[1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const tailIndex = tails[mid];
      const tailPair = tailIndex !== undefined ? pairs[tailIndex] : undefined;
      if (tailPair && tailPair[1] < target) lo = mid + 1;
      else hi = mid;
    }
    const previousTail = lo > 0 ? tails[lo - 1] : undefined;
    if (previousTail !== undefined) prev[i] = previousTail;
    tails[lo] = i;
  }
  const result: Array<[number, number]> = [];
  let idx = tails[tails.length - 1] ?? -1;
  while (idx >= 0) {
    const pair = pairs[idx];
    if (pair) result.push(pair);
    idx = prev[idx] ?? -1;
  }
  return result.reverse();
}

/** Align `htmlTokens` to `plainTokens` in monotonic order using Patience-style
 * unique-token anchors with exact LCS DP on small unresolved gaps. */
function alignTokens(
  htmlTokens: readonly HtmlToken[],
  plainTokens: readonly TextToken[],
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const alignRange = (
    hStart: number,
    hEnd: number,
    pStart: number,
    pEnd: number,
  ) => {
    while (
      hStart < hEnd &&
      pStart < pEnd &&
      htmlTokens[hStart]?.value === plainTokens[pStart]?.value
    ) {
      out.push([hStart, pStart]);
      hStart++;
      pStart++;
    }
    const suffix: Array<[number, number]> = [];
    while (
      hStart < hEnd &&
      pStart < pEnd &&
      htmlTokens[hEnd - 1]?.value === plainTokens[pEnd - 1]?.value
    ) {
      suffix.push([hEnd - 1, pEnd - 1]);
      hEnd--;
      pEnd--;
    }
    if (hStart < hEnd && pStart < pEnd) {
      const htmlUnique = new Map<string, number>();
      for (let i = hStart; i < hEnd; i++) {
        const token = htmlTokens[i];
        if (!token) continue;
        htmlUnique.set(token.value, htmlUnique.has(token.value) ? -1 : i);
      }
      const plainUnique = new Map<string, number>();
      for (let j = pStart; j < pEnd; j++) {
        const token = plainTokens[j];
        if (!token) continue;
        plainUnique.set(token.value, plainUnique.has(token.value) ? -1 : j);
      }
      const uniquePairs: Array<[number, number]> = [];
      for (let i = hStart; i < hEnd; i++) {
        const token = htmlTokens[i];
        if (!token || htmlUnique.get(token.value) !== i) continue;
        const pj = plainUnique.get(token.value);
        if (pj !== undefined && pj >= 0) uniquePairs.push([i, pj]);
      }
      const anchors = increasingAnchors(uniquePairs);
      if (anchors.length) {
        let curH = hStart;
        let curP = pStart;
        for (const [ah, ap] of anchors) {
          alignRange(curH, ah, curP, ap);
          out.push([ah, ap]);
          curH = ah + 1;
          curP = ap + 1;
        }
        alignRange(curH, hEnd, curP, pEnd);
      } else {
        const hLen = hEnd - hStart;
        const pLen = pEnd - pStart;
        if (hLen * pLen <= 10_000) {
          const stride = pLen + 1;
          const dp = new Int32Array((hLen + 1) * stride);
          for (let i = hLen - 1; i >= 0; i--) {
            const hVal = htmlTokens[hStart + i]?.value;
            const row = i * stride;
            const nextRow = (i + 1) * stride;
            for (let j = pLen - 1; j >= 0; j--) {
              dp[row + j] =
                hVal !== undefined && hVal === plainTokens[pStart + j]?.value
                  ? (dp[nextRow + j + 1] ?? 0) + 1
                  : Math.max(dp[nextRow + j] ?? 0, dp[row + j + 1] ?? 0);
            }
          }
          let i = 0;
          let j = 0;
          while (i < hLen && j < pLen) {
            if (
              htmlTokens[hStart + i]?.value === plainTokens[pStart + j]?.value
            ) {
              out.push([hStart + i, pStart + j]);
              i++;
              j++;
            } else if (
              (dp[(i + 1) * stride + j] ?? 0) >= (dp[i * stride + j + 1] ?? 0)
            ) {
              i++;
            } else {
              j++;
            }
          }
        } else {
          // Bounded fallback for pathological repetitive inputs.
          let j = pStart;
          for (let i = hStart; i < hEnd && j < pEnd; i++) {
            const hVal = htmlTokens[i]?.value;
            const limit = Math.min(pEnd, j + 32);
            for (let k = j; k < limit; k++) {
              if (hVal !== undefined && plainTokens[k]?.value === hVal) {
                out.push([i, k]);
                j = k + 1;
                break;
              }
            }
          }
        }
      }
    }
    for (let i = suffix.length - 1; i >= 0; i--) {
      const pair = suffix[i];
      if (pair) out.push(pair);
    }
  };
  alignRange(0, htmlTokens.length, 0, plainTokens.length);
  return out;
}

function markdownRanges(plain: string): {
  blocked: TextRange[];
  inlineCodes: TextRange[];
  bareHosts: TextRange[];
} {
  const blocked: TextRange[] = [];
  const inlineCodes: TextRange[] = [];
  const bareHosts: TextRange[] = [];
  const { tree } = scanMarkdown(plain);
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      if (
        (node.type === "code" &&
          /^ {0,3}(`{3,}|~{3,})/.test(plain.slice(start, end))) ||
        node.type === "link" ||
        node.type === "linkReference" ||
        node.type === "image" ||
        node.type === "imageReference"
      ) {
        blocked.push({ start, end });
        continue;
      }
      if (node.type === "inlineCode") {
        inlineCodes.push({ start, end });
        continue;
      }
    }
    for (const child of node.children ?? []) pending.push(child);
  }
  messageLinkParts(plain, undefined, (start, end) => {
    if (!overlaps(blocked, start, end) && !overlaps(inlineCodes, start, end))
      blocked.push({ start, end });
  });
  let offset = 0;
  for (const part of bareHostParts(plain)) {
    const end = offset + part.text.length;
    if (
      part.url &&
      !overlaps(blocked, offset, end) &&
      !overlaps(inlineCodes, offset, end)
    )
      bareHosts.push({ start: offset, end });
    offset = end;
  }
  return { blocked, inlineCodes, bareHosts };
}

function overlaps(
  ranges: readonly TextRange[],
  start: number,
  end: number,
): boolean {
  return ranges.some((range) => start < range.end && end > range.start);
}

function containsTokenValues(
  haystack: readonly TextToken[],
  start: number,
  end: number,
  needle: readonly TextToken[],
  needleStart: number,
  needleEnd: number,
): boolean {
  const len = needleEnd - needleStart;
  if (len <= 0 || end - start < len) return false;
  const first = needle[needleStart]?.value;
  for (let i = start; i <= end - len; i++) {
    if (haystack[i]?.value !== first) continue;
    let match = true;
    for (let k = 1; k < len; k++) {
      if (haystack[i + k]?.value !== needle[needleStart + k]?.value) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

function hasUnmatchedTokenSequence(
  tokens: readonly TextToken[],
  matchedMap: Int32Array,
  needle: readonly TextToken[],
  needleStart: number,
  needleEnd: number,
): boolean {
  const len = needleEnd - needleStart;
  if (len <= 0 || tokens.length < len) return false;
  const first = needle[needleStart]?.value;
  for (let i = 0; i <= tokens.length - len; i++) {
    if (tokens[i]?.value !== first) continue;
    let match = true;
    let hasUnmatched = false;
    for (let k = 0; k < len; k++) {
      if (tokens[i + k]?.value !== needle[needleStart + k]?.value) {
        match = false;
        break;
      }
      if ((matchedMap[i + k] ?? -1) < 0) hasUnmatched = true;
    }
    if (match && hasUnmatched) return true;
  }
  return false;
}

function isEntireInlineCodeContent(
  plain: string,
  codeStart: number,
  codeEnd: number,
  start: number,
  end: number,
): boolean {
  if (!(codeStart < start && end < codeEnd)) return false;
  return (
    /^`+\s*$/.test(plain.slice(codeStart, start)) &&
    /^\s*`+$/.test(plain.slice(end, codeEnd))
  );
}

function isBareLinkLabel(
  label: string,
  href: string,
  rawHref: string,
): boolean {
  if (label === href || label === rawHref) return true;
  const bare = bareHostParts(label);
  return (
    bare.length === 3 &&
    bare[1]?.text === label &&
    safeLinkUrl(bare[1].url ?? "") === href
  );
}

function formatExternalMarkdownLink(
  label: string,
  href: string,
  rawCode: boolean,
): string {
  const escapedLabel = rawCode
    ? label
    : label.replace(/[\\`[\]*_~<>&|]/g, "\\$&");
  const escapedHref = href
    .replace(/\\|&(?=#?\w+;)/g, "\\$&")
    .replace(/[()]/g, (character) => (character === "(" ? "%28" : "%29"));
  return `[${escapedLabel}](${escapedHref})`;
}

function boundaryIsBlock(
  node: Node | null,
  edge: "firstChild" | "lastChild",
): boolean {
  let current = node;
  while (current) {
    if (current.nodeType === Node.TEXT_NODE) {
      if ((current as Text).data) return false;
      current =
        edge === "firstChild" ? current.nextSibling : current.previousSibling;
      continue;
    }
    if (current instanceof Element) {
      if (blockElementTag.test(current.tagName.toUpperCase())) return true;
      return boundaryIsBlock(current[edge], edge);
    }
    current =
      edge === "firstChild" ? current.nextSibling : current.previousSibling;
  }
  return false;
}

/** External HTML contributes web links, never Buzz identity metadata or styling. */
export function externalLinkMarkdown(
  html: string,
  plain?: string,
): string | undefined {
  if (!html) return;
  const body = new DOMParser().parseFromString(
    /<(?:html|head|body)\b/i.test(html) ? html : `<body>${html}</body>`,
    "text/html",
  ).body;
  // Remove non-content, hidden, and styling-only elements before reading links
  // or text so hidden/scripted markup can never inject text or hijack a link.
  for (const node of body.querySelectorAll(
    "script, style, title, template, iframe, object, noscript, svg, hr, input, button, [hidden]",
  ))
    node.remove();
  for (const element of [...body.querySelectorAll("[style]")]) {
    if (hiddenStylePattern.test(element.getAttribute("style") ?? ""))
      element.remove();
  }
  // Slack uses empty paragraph-break spans instead of <br> or block tags.
  for (const br of body.querySelectorAll(
    '[data-stringify-type="paragraph-break"]',
  )) {
    if (!br.textContent)
      br.replaceWith(body.ownerDocument.createTextNode("\n"));
  }
  // Browser text/plain can include an inline image's alt text or Slack emoji
  // shortcodes. Preserve them as literal text before stripping attributes.
  for (const image of body.querySelectorAll("img")) {
    const alt = image.getAttribute("alt") ?? "";
    const emoji = image.getAttribute("data-stringify-emoji") ?? "";
    const replacement =
      emoji && plain && !plain.includes(alt) && plain.includes(emoji)
        ? emoji
        : alt || emoji;
    image.replaceWith(body.ownerDocument.createTextNode(replacement));
  }
  for (const emojiNode of body.querySelectorAll("[data-stringify-emoji]")) {
    if (!emojiNode.textContent) {
      const emoji = emojiNode.getAttribute("data-stringify-emoji") ?? "";
      if (emoji)
        emojiNode.replaceWith(body.ownerDocument.createTextNode(emoji));
    }
  }
  const rawHrefs = new WeakMap<Element, string>();
  let linked = false;
  for (const element of body.querySelectorAll("*")) {
    const rawHref =
      element.tagName === "A" ? (element.getAttribute("href") ?? "") : "";
    const href = rawHref ? safeLinkUrl(rawHref) : undefined;
    for (const attribute of [...element.attributes])
      element.removeAttribute(attribute.name);
    if (href && element.textContent?.trim()) {
      element.setAttribute("href", href);
      rawHrefs.set(element, rawHref);
      linked = true;
    }
    // Keep text and line boundaries; importing other rich formatting is separate.
    if (/^(STRONG|B|EM|I|S|DEL|CODE)$/.test(element.tagName))
      element.replaceWith(...element.childNodes);
    else if (/^(UL|OL|LI|BLOCKQUOTE|PRE|H[1-6])$/.test(element.tagName)) {
      const block = body.ownerDocument.createElement("div");
      block.append(...element.childNodes);
      element.replaceWith(block);
    }
  }
  if (!linked) return;
  // External labels must fit one Markdown paragraph. Read child boundaries
  // before collapsing whitespace so adjacent blocks and <br> do not join words.
  const anchorWhitespace = new WeakMap<
    Element,
    { leading: boolean; trailing: boolean }
  >();
  for (const anchor of body.querySelectorAll("a[href]")) {
    const startsBlock = boundaryIsBlock(anchor.firstChild, "firstChild");
    const endsBlock = boundaryIsBlock(anchor.lastChild, "lastChild");
    const label = body.ownerDocument.createElement("div");
    label.append(...anchor.childNodes);
    const raw = serializeNode(label, "text");
    const normalized = raw.replace(/\s+/g, " ").trim();
    if (!normalized) {
      anchor.removeAttribute("href");
      if (/\s/.test(raw) || startsBlock || endsBlock) anchor.textContent = " ";
    } else {
      anchor.textContent = normalized;
      anchorWhitespace.set(anchor, {
        leading: /^\s/.test(raw) || startsBlock,
        trailing: /\s$/.test(raw) || endsBlock,
      });
    }
  }
  if (!body.querySelector("a[href]")) return;
  if (plain === undefined) return serializeNode(body, "markdown");
  // Keep `text/plain` authoritative: project safe links from HTML onto the
  // aligned spans in `plain` so extra HTML chrome, emojis, list markers, or
  // timestamp formatting differences never inject text or drop links.
  let htmlText = "";
  const links: ExtractedLink[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      htmlText += (node as Text).data;
      return;
    }
    if (!(node instanceof Element)) {
      for (const child of node.childNodes) walk(child);
      return;
    }
    const tag = node.tagName.toUpperCase();
    if (tag === "BR") {
      htmlText += "\n";
      return;
    }
    if (tag === "A" && node.hasAttribute("href")) {
      const href = node.getAttribute("href") ?? "";
      const label = node.textContent ?? "";
      if (href && label) {
        const ws = anchorWhitespace.get(node);
        if (ws?.leading) htmlText += " ";
        const start = htmlText.length;
        htmlText += label;
        const end = htmlText.length;
        if (ws?.trailing) htmlText += " ";
        links.push({
          href,
          rawHref: rawHrefs.get(node) ?? href,
          start,
          end,
        });
        return;
      }
    }
    const isBlock = blockElementTag.test(tag);
    if (isBlock) htmlText += "\n";
    for (const child of node.childNodes) walk(child);
    if (isBlock) htmlText += "\n";
  };
  walk(body);
  const htmlTokens: HtmlToken[] = tokenize(htmlText).map((token) => ({
    ...token,
    fullyLinked: false,
  }));
  let linkCursor = 0;
  for (const token of htmlTokens) {
    while (
      linkCursor < links.length &&
      (links[linkCursor]?.end ?? 0) <= token.start
    )
      linkCursor++;
    let covered = token.start;
    for (let k = linkCursor; k < links.length; k++) {
      const link = links[k];
      if (!link || link.start >= token.end || link.start > covered) break;
      covered = Math.max(covered, link.end);
      if (covered >= token.end) break;
    }
    token.fullyLinked = covered >= token.end;
  }
  const plainTokens = tokenize(plain);
  if (!links.length || !htmlTokens.length || !plainTokens.length) return;
  const matches = alignTokens(htmlTokens, plainTokens);
  if (!matches.length) return;
  const plainWords = plainTokens.filter((token) => token.word).length;
  const htmlWords = htmlTokens.filter((token) => token.word).length;
  const matchedWords = matches.filter(([hi]) => htmlTokens[hi]?.word).length;
  if (plainWords > 0 && htmlWords > 0) {
    if (matchedWords * 2 < plainWords || matchedWords * 2 < htmlWords) return;
  } else if (
    matches.length * 2 < plainTokens.length ||
    matches.length * 2 < htmlTokens.length
  ) {
    return;
  }
  const htmlToPlain = new Int32Array(htmlTokens.length).fill(-1);
  const plainToHtml = new Int32Array(plainTokens.length).fill(-1);
  const matchedPlainFullyLinked = new Set<number>();
  let matchedNonLinkWords = 0;
  for (const [hi, pi] of matches) {
    htmlToPlain[hi] = pi;
    plainToHtml[pi] = hi;
    const token = htmlTokens[hi];
    if (!token) continue;
    if (token.fullyLinked) {
      matchedPlainFullyLinked.add(pi);
    } else if (token.word) {
      matchedNonLinkWords++;
    }
  }
  const htmlNonLinkWords = htmlTokens.filter(
    (token) => token.word && !token.fullyLinked,
  ).length;
  const plainNonLinkWords = plainTokens.filter(
    (token, index) => token.word && !matchedPlainFullyLinked.has(index),
  ).length;
  if (
    plainNonLinkWords > 0 &&
    htmlNonLinkWords > 0 &&
    matchedNonLinkWords === 0
  )
    return;
  const { blocked, inlineCodes, bareHosts } = markdownRanges(plain);
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  let tokenCursor = 0;
  for (const link of links) {
    while (
      tokenCursor < htmlTokens.length &&
      (htmlTokens[tokenCursor]?.end ?? 0) <= link.start
    )
      tokenCursor++;
    const firstHi = tokenCursor;
    let lastHi = -1;
    for (let hi = tokenCursor; hi < htmlTokens.length; hi++) {
      const token = htmlTokens[hi];
      if (!token || token.start >= link.end) break;
      lastHi = hi;
    }
    if (lastHi < firstHi) continue;
    const firstPlainIndex = htmlToPlain[firstHi];
    if (firstPlainIndex === undefined || firstPlainIndex < 0) continue;
    let contiguous = true;
    for (let hi = firstHi + 1; hi <= lastHi; hi++) {
      if (htmlToPlain[hi] !== firstPlainIndex + (hi - firstHi)) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous) continue;
    const lastPlainIndex = firstPlainIndex + (lastHi - firstHi);
    let runStartH = firstHi;
    while (
      runStartH > 0 &&
      htmlToPlain[runStartH - 1] ===
        firstPlainIndex - (firstHi - (runStartH - 1))
    )
      runStartH--;
    let runEndH = lastHi;
    while (
      runEndH + 1 < htmlTokens.length &&
      htmlToPlain[runEndH + 1] === lastPlainIndex + (runEndH + 1 - lastHi)
    )
      runEndH++;
    const runStartP = firstPlainIndex - (firstHi - runStartH);
    const runEndP = lastPlainIndex + (runEndH - lastHi);
    let prevMatchedH = runStartH - 1;
    while (prevMatchedH >= 0 && (htmlToPlain[prevMatchedH] ?? -1) < 0)
      prevMatchedH--;
    const prevMatchedP =
      prevMatchedH >= 0 ? (htmlToPlain[prevMatchedH] ?? -1) : -1;
    let nextMatchedH = runEndH + 1;
    while (
      nextMatchedH < htmlTokens.length &&
      (htmlToPlain[nextMatchedH] ?? -1) < 0
    )
      nextMatchedH++;
    const nextMatchedP =
      nextMatchedH < htmlTokens.length
        ? (htmlToPlain[nextMatchedH] ?? plainTokens.length)
        : plainTokens.length;
    const ambiguous =
      (firstHi === runStartH &&
        (containsTokenValues(
          htmlTokens,
          prevMatchedH + 1,
          runStartH,
          htmlTokens,
          firstHi,
          lastHi + 1,
        ) ||
          containsTokenValues(
            plainTokens,
            prevMatchedP + 1,
            runStartP,
            htmlTokens,
            firstHi,
            lastHi + 1,
          ))) ||
      (lastHi === runEndH &&
        (containsTokenValues(
          htmlTokens,
          runEndH + 1,
          nextMatchedH,
          htmlTokens,
          firstHi,
          lastHi + 1,
        ) ||
          containsTokenValues(
            plainTokens,
            runEndP + 1,
            nextMatchedP,
            htmlTokens,
            firstHi,
            lastHi + 1,
          ))) ||
      containsTokenValues(
        htmlTokens,
        prevMatchedH + 1,
        runStartH,
        htmlTokens,
        runStartH,
        runEndH + 1,
      ) ||
      containsTokenValues(
        htmlTokens,
        runEndH + 1,
        nextMatchedH,
        htmlTokens,
        runStartH,
        runEndH + 1,
      ) ||
      containsTokenValues(
        plainTokens,
        prevMatchedP + 1,
        runStartP,
        htmlTokens,
        runStartH,
        runEndH + 1,
      ) ||
      containsTokenValues(
        plainTokens,
        runEndP + 1,
        nextMatchedP,
        htmlTokens,
        runStartH,
        runEndH + 1,
      ) ||
      (firstHi === runStartH &&
        lastHi === runEndH &&
        (hasUnmatchedTokenSequence(
          htmlTokens,
          htmlToPlain,
          htmlTokens,
          firstHi,
          lastHi + 1,
        ) ||
          hasUnmatchedTokenSequence(
            plainTokens,
            plainToHtml,
            htmlTokens,
            firstHi,
            lastHi + 1,
          )));
    if (ambiguous) continue;
    const firstHtml = htmlTokens[firstHi];
    const lastHtml = htmlTokens[lastHi];
    const firstPlain = plainTokens[firstPlainIndex];
    const lastPlain = plainTokens[lastPlainIndex];
    if (!firstHtml || !lastHtml || !firstPlain || !lastPlain) continue;
    const startOffset = Math.max(0, link.start - firstHtml.start);
    const endOffset = Math.min(
      lastHtml.end - lastHtml.start,
      link.end - lastHtml.start,
    );
    let start = firstPlain.start + startOffset;
    let end = lastPlain.start + endOffset;
    if (start >= end) continue;
    if (overlaps(blocked, start, end)) continue;
    if (
      bareHosts.some(
        (range) =>
          start < range.end &&
          end > range.start &&
          !(start === range.start && end === range.end),
      )
    )
      continue;
    let rawCode = false;
    const codeSpan = inlineCodes.find(
      (range) => start < range.end && end > range.start,
    );
    if (codeSpan) {
      if (
        isEntireInlineCodeContent(
          plain,
          codeSpan.start,
          codeSpan.end,
          start,
          end,
        )
      ) {
        start = codeSpan.start;
        end = codeSpan.end;
        rawCode = true;
      } else {
        continue;
      }
    }
    const previous = replacements[replacements.length - 1];
    if (previous && start < previous.end) continue;
    if (start > 0 && plain[start - 1] === "!" && plain[start - 2] !== "\\")
      continue;
    const label = plain.slice(start, end).replace(/\s+/g, " ").trim();
    if (!label || isBareLinkLabel(label, link.href, link.rawHref)) continue;
    replacements.push({
      start,
      end,
      text: formatExternalMarkdownLink(label, link.href, rawCode),
    });
  }
  if (!replacements.length) return;
  let result = "";
  let cursor = 0;
  for (const replacement of replacements) {
    result += plain.slice(cursor, replacement.start) + replacement.text;
    cursor = replacement.end;
  }
  return result + plain.slice(cursor);
}
