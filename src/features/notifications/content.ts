import { workflowLabel } from "../relay/workflow-attribution";
import type { ChannelSummary, Profile } from "../relay/contracts";
import type { IncomingMessage } from "../relay/incoming";
import { scanMarkdown, visibleHtmlSource } from "../relay/message-content";
import type { NotificationCategory } from "./preferences";
import { prepareMarkdown } from "../messages/markdown-preparation";
import { remarkSpoilers } from "../messages/remark-spoilers";
import { messageLinkParts } from "../messages/message-link-parts";
import { placeholderCharacters } from "../messages/placeholder-characters";

export type NotificationText = Readonly<{ title: string; body: string }>;

// An isolated surrogate is not valid Unicode; native JSON rejects it.
const loneSurrogate =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function shortText(value: string, limit: number) {
  const points = Array.from(
    value
      .replace(loneSurrogate, "\uFFFD")
      .replace(/[\p{Cc}\p{Bidi_Control}]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  );
  return points.length > limit
    ? `${points.slice(0, limit - 1).join("")}…`
    : points.join("");
}

type TextNode = {
  type: string;
  value?: string;
  url?: string;
  children?: TextNode[];
};
/** A link's text in place of a URL that reads as itself, or undefined to keep
 * the URL. */
type LinkText = (url: string) => string | undefined;

/** Each run of text between placeholder characters. */
const placeholderRuns = new RegExp(`[^${placeholderCharacters}]+`, "g");

/** `value` with each bare URL in it through `link`, as the conversation splits
 * text into links. A caller's placeholders are private-use characters, and
 * each ends a URL, as the protected part it holds does in the conversation. */
function textLinks(value: string, link: LinkText) {
  let result = "";
  let at = 0;
  for (const { 0: run, index: offset } of value.matchAll(placeholderRuns))
    messageLinkParts(run, undefined, (start, end, url) => {
      // Only a URL that reads as itself; a labelled or wrapped one keeps its
      // text.
      if (run.slice(start, end) !== url) return;
      const text = link(url);
      if (text === undefined) return;
      result += value.slice(at, offset + start) + text;
      at = offset + end;
    });
  return result + value.slice(at);
}

function prose(node: TextNode, link?: LinkText): string {
  if (node.type === "spoiler") return "[Spoiler]";
  if (node.type === "definition") return "";
  if (node.type === "html") return visibleHtmlSource(node.value ?? "");
  if (node.type === "image" || node.type === "imageReference") return "[Image]";
  if (node.type === "break" || node.type === "thematicBreak") return " ";
  if (link && node.type === "text" && node.value !== undefined)
    return textLinks(node.value, link);
  if (node.value !== undefined) return node.value;
  if (link && (node.type === "link" || node.type === "linkReference")) {
    // A label is its own text; only a link that reads as its URL resolves.
    const text = (node.children ?? []).map((child) => prose(child)).join("");
    return (text === node.url && link(text)) || text;
  }
  const separator = [
    "paragraph",
    "heading",
    "emphasis",
    "strong",
    "link",
    "linkReference",
  ].includes(node.type)
    ? ""
    : " ";
  return (node.children ?? [])
    .map((child) => prose(child, link))
    .join(separator);
}

type PreviewOptions = Readonly<{
  storedPreview?: boolean;
  /** The most characters kept; 200 unless given. */
  limit?: number;
}>;

/** Flattened, bounded prose; empty when nothing displayable remains.
 * Stored previews have lost code/escape provenance and may have been cut. */
export function plainText(content: string, options: PreviewOptions = {}) {
  // Cut the source on a whole code point, never between a surrogate pair.
  const end = /[\uD800-\uDBFF]/.test(content.charAt(4095)) ? 4095 : 4096;
  let bounded = content.slice(0, end);
  // Old flattened text cannot distinguish a real closing delimiter from
  // literal pipes inside the hidden text. Hide everything after its first
  // possible opener; newly saved redacted previews contain no such delimiter.
  const opener = options.storedPreview ? bounded.indexOf("||") : -1;
  if (opener >= 0) bounded = `${bounded.slice(0, opener)}[Spoiler]`;
  // Read the body as its conversation renders it, wrapped links repaired.
  let scan: ReturnType<typeof scanMarkdown> | undefined;
  const prepared = prepareMarkdown(bounded, (made) => {
    scan = made;
  });
  if (prepared.kind === "plain") return "";
  const original = scan ?? scanMarkdown(prepared.content);
  if (original.tooDeep) return "";
  if (!prepared.content.includes("||"))
    return shortText(prose(original.tree), options.limit ?? 200);
  // Protect only authored spoiler delimiters, using the renderer's source
  // rules. A collision-free text token survives Markdown decoding without
  // turning escaped pipes, code or table grammar into hidden content.
  // Preserve the renderer's punctuation flanking around emphasis delimiters.
  let delimiter = "<\uE000>";
  const decoded = JSON.stringify(original.tree);
  while (prepared.content.includes(delimiter) || decoded.includes(delimiter))
    delimiter = `<${delimiter}>`;
  let source = prepared.content;
  for (const offset of [...prepared.spoilerDelimiters].reverse())
    source = source.slice(0, offset) + delimiter + source.slice(offset + 2);
  return spoilerText(source, delimiter, {
    truncated: content.length > end,
    limit: options.limit,
  });
}

/** Flattened, bounded prose of `source`, where `delimiter` stands for each
 * authored spoiler delimiter; empty when it nests too deeply. */
export function spoilerText(
  source: string,
  delimiter: string,
  options: Readonly<{
    truncated?: boolean;
    limit?: number | undefined;
    /** Text for a URL that reads as itself, outside code; the URL when
     * undefined. */
    link?: LinkText | undefined;
  }> = {},
) {
  const { tree, tooDeep } = scanMarkdown(source);
  if (tooDeep) return "";
  remarkSpoilers(delimiter, options.truncated ?? false)(tree);
  return shortText(prose(tree, options.link), options.limit ?? 200);
}

/** Bounded CommonMark text, not rendered HTML or a fetch of linked/attached content. */
export function messagePreview(
  content: string,
  options: PreviewOptions = {},
): string {
  return plainText(content, options) || "New message";
}

/** Plugin text gets the same flattening and bounds; missing text keeps the category fallback. */
export function pluginNotificationText(
  input: Readonly<{ title?: string; body?: string }>,
  label: string,
): NotificationText {
  return Object.freeze({
    title: shortText(input.title ?? "", 128) || "Buzz",
    body: plainText(input.body ?? "") || `New ${label.toLowerCase()}`,
  });
}

/** Names are optional cached enrichment; notifications never wait for profile reads. */
export function messageNotificationText(
  message: IncomingMessage,
  category: NotificationCategory,
  channel: ChannelSummary | undefined,
  profile: Profile | undefined,
  resolvedName?: string | undefined,
): NotificationText {
  const name =
    shortText(resolvedName ?? profile?.name ?? "", 64) ||
    (message.workflowOwnerId ?? message.authorId).slice(0, 10);
  const sender = message.workflowOwnerId ? workflowLabel(name) : name;
  const destination =
    channel?.channelType === "dm"
      ? "a direct message"
      : `#${shortText(channel?.name ?? "", 64) || message.channelId.slice(0, 8)}`;
  const title =
    category === "mention"
      ? `${sender} mentioned you in ${destination}`
      : category === "direct"
        ? `${sender} sent you a direct message`
        : category === "post"
          ? `${sender} posted in ${destination}`
          : `${sender} replied in ${destination}`;
  return Object.freeze({ title, body: messagePreview(message.previewContent) });
}
