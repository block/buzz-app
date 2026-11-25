import { stageChatCards } from "../messages/composer-chat-cards";
import { composerMarkdown } from "../messages/composer-markdown";
import { mentionDraft, type MentionDraft } from "../messages/mention-draft";
import { canonicalDetailsName } from "../relay/channel-details-protocol";
import { isBuzzLink } from "../navigation/buzz-links";
import {
  projectMarkdownAttachments,
  safeMessageUrl,
  scanMarkdown,
} from "../relay/message-content";
import {
  attachmentSummary,
  markdownImageKind,
} from "../relay/attachment-summary";
import type { Attachment } from "../relay/contracts";

/** What a first message attaches. An address finds its link in sent text. */
export type TitleAttachment = Readonly<{
  kind: Attachment["kind"];
  url?: string | undefined;
}>;

/**
 * How a title reads its message. `described` leaves media out of the text and
 * names what was sent when nothing else is said. The rest are what earlier
 * and other clients stored: `undescribed` leaves media out and names nothing,
 * `embedded` keeps media and bare links as source, and `literal` keeps every
 * link as source too.
 */
type TitleStyle = "described" | "undescribed" | "embedded" | "literal";

/** Remove only structured leading recipient tags; literal @ text remains title content. */
export function startingChatTitle(
  value: MentionDraft | string,
  attachments: readonly TitleAttachment[] = [],
): string {
  return chatTitle(value, "described", attachments);
}

/** Whether `name` is a title a client can have derived from this first
 * message: this build, an earlier one, or the mobile app, whose rule is its
 * own. Automatic naming falls back to this only when it cannot read the name
 * the chat was created with; the apps need not derive the same title. */
export function isStartingChatTitle(
  name: string,
  value: MentionDraft | string,
  attachments: readonly TitleAttachment[] = [],
): boolean {
  const current = canonicalDetailsName(name);
  return (
    (["described", "undescribed", "embedded", "literal"] as const).some(
      (style) => current === chatTitle(value, style, attachments),
    ) || current === captionTitle(mentionDraft(value).text, attachments)
  );
}

const titleLength = (text: string) =>
  canonicalDetailsName([...text].slice(0, 80).join(""));

/** The caption case of the mobile app's title, not its whole rule: the `text`
 * it published without the attachment lines its composer appended, as
 * written, with no Markdown read. Alone, attachments and web addresses are
 * described. The app also skips a leading block quote and a leading `buzz://`
 * link; a name it derives that way is not recognized here, and is kept. */
function captionTitle(
  text: string,
  attachments: readonly TitleAttachment[],
): string {
  const sent = new Set(attachments.flatMap(({ url }) => (url ? [url] : [])));
  const lines = text.split("\n");
  // One line each, after the text: `![image](address)` or `[name](address)`.
  for (let left = attachments.length; left > 0; left -= 1) {
    const line = lines.at(-1)?.trim() ?? "";
    const address = line.lastIndexOf("](");
    if (address < 1 || !/^!?\[/.test(line) || !line.endsWith(")")) break;
    const url = safeMessageUrl(
      line.slice(address + 2, -1).replace(/^<(.*)>$/, "$1"),
    );
    if (!url || !sent.has(url)) break;
    lines.pop();
  }
  const flat = lines.join("\n").trim().replace(/\s+/g, " ");
  return (
    titleLength(linkTitle(flat) ?? (flat || attachmentSummary(attachments))) ||
    "Chat"
  );
}

function chatTitle(
  value: MentionDraft | string,
  style: TitleStyle,
  attachments: readonly TitleAttachment[],
): string {
  const draft = stageChatCards(mentionDraft(value), []);
  // Match main’s caption-first title; cards remain the fallback for card-only sends.
  const text =
    composerMarkdown({ ...draft, chatCards: [], gifs: [] }).trim() ||
    composerMarkdown({ ...draft, gifs: [] });
  let start = 0;
  let draftStart = 0;
  for (const recipient of [...draft.recipients].sort(
    (a, b) => a.start - b.start,
  )) {
    if (
      recipient.start < draftStart ||
      draft.text.slice(draftStart, recipient.start).trim()
    )
      break;
    const leading = text.slice(start).match(/^\s*/)?.[0].length ?? 0;
    const tag = `@${recipient.name}`;
    if (!text.startsWith(tag, start + leading)) break;
    start += leading + tag.length;
    // A namesake is sent with its full key; that qualifier is part of the tag.
    start += /^ \([0-9a-f]{64}\)/.exec(text.slice(start))?.[0].length ?? 0;
    draftStart = recipient.end;
  }
  const body = text.slice(start).trim();
  // Media shows beside the text, as its conversation shows it: every embed,
  // staged GIFs included, and each link to an attached file.
  const sent = new Set(attachments.flatMap(({ url }) => (url ? [url] : [])));
  const media =
    style === "described" || style === "undescribed"
      ? projectMarkdownAttachments(
          [body, ...(draft.gifs ?? [])].join("\n\n"),
          sent,
        )
      : undefined;
  // A link-only prompt falls back to its cards, then "Chat".
  const source =
    withoutLeadingBuzzLinks(media ? media.content.trim() : body) ||
    (draft.chatCards ?? []).join("\n\n");
  const flat = (
    style === "literal" ? source : readableLinkLabels(source)
  ).replace(/\s+/g, " ");
  const title = titleLength(flat);
  if (style !== "described") return title || "Chat";
  // A message that is only media or web links is titled by what it sent.
  return (
    titleLength(
      linkTitle(flat) ??
        (title ||
          attachmentSummary([
            ...attachments,
            ...(media?.urls ?? [])
              .filter((url) => !sent.has(url))
              .map((url) => ({ kind: markdownImageKind(url) })),
          ])),
    ) || "Chat"
  );
}

/** A title for text that is only web links, which read as noise: the site of
 * one, or how many. Undefined when the text says anything else. */
function linkTitle(text: string): string | undefined {
  const links = text.split(/\s+/).filter(Boolean);
  const sites: string[] = [];
  for (const link of links) {
    const url = /^<?(https?:\/\/[^\s<>]+)>?$/i.exec(link)?.[1];
    if (!url) return undefined;
    try {
      sites.push(new URL(url).hostname.replace(/^www\./, ""));
    } catch {
      sites.push("");
    }
  }
  if (!links.length) return undefined;
  if (links.length > 1) return `${links.length} links`;
  return sites[0] ? `Link to ${sites[0]}` : "Link";
}

/** Project link labels only; code and unrelated authored source remain literal. */
function readableLinkLabels(text: string): string {
  const { links, tooDeep } = scanMarkdown(text);
  if (tooDeep) return text;
  const parts: string[] = [];
  let offset = 0;
  for (const link of links) {
    const start = link.position?.start.offset;
    const end = link.position?.end.offset;
    if (start === undefined || end === undefined || start < offset) continue;
    const label: string[] = [];
    const pending = [...(link.children ?? [])].reverse();
    while (pending.length) {
      const node = pending.pop();
      if (!node) continue;
      if (node.children) pending.push(...[...node.children].reverse());
      else
        label.push(
          node.value ?? node.alt ?? (node.type === "break" ? " " : ""),
        );
    }
    parts.push(text.slice(offset, start), label.join(""));
    offset = end;
  }
  return parts.join("") + text.slice(offset);
}

/** A starting source link, as from Start Solo chat, is context rather than title. */
function withoutLeadingBuzzLinks(text: string) {
  let rest = text;
  for (;;) {
    const [token = ""] = rest.split(/\s/, 1);
    if (!token || !isBuzzLink(token)) return rest;
    rest = rest.slice(token.length).trim();
  }
}
