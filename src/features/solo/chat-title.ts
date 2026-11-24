import { stageChatCards } from "../messages/composer-chat-cards";
import { composerMarkdown } from "../messages/composer-markdown";
import { mentionDraft, type MentionDraft } from "../messages/mention-draft";
import { canonicalDetailsName } from "../relay/channel-details-protocol";
import { isBuzzLink } from "../navigation/buzz-links";
import {
  projectMarkdownAttachments,
  scanMarkdown,
} from "../relay/message-content";
import {
  attachmentSummary,
  markdownImageKind,
} from "../relay/attachment-summary";
import type { Attachment } from "../relay/contracts";
import { linkTitle } from "./shown-title";

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

/** Whether `name` is still the title its first message gave it, as this or
 * any earlier client wrote it; automatic naming replaces only that. */
export function isStartingChatTitle(
  name: string,
  value: MentionDraft | string,
  attachments: readonly TitleAttachment[] = [],
): boolean {
  const current = canonicalDetailsName(name);
  return (["described", "undescribed", "embedded", "literal"] as const).some(
    (style) => current === chatTitle(value, style, attachments),
  );
}

const titleLength = (text: string) =>
  canonicalDetailsName([...text].slice(0, 80).join(""));

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
