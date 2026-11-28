import {
  projectMarkdownAttachments,
  scanMarkdown,
} from "../relay/message-content";
import type { AgentLibrary } from "../agents/library";
import type { Attachment, ChannelMessage, Profile } from "../relay/contracts";
import { npubEncode } from "nostr-tools/nip19";
import { literalRanges } from "./markdown-preparation";
import type { MentionRecipient } from "./mention-draft";
import { profileMentionParts } from "./profile-mentions";

/** Display-only identity link: literal one-line label, exact profile target, no
 * recipient. CommonMark unescapes every ASCII punctuation mark, so escaping all
 * of them keeps a name from authoring emphasis, code, entities or links. */
export function profileMentionLink(label: string, target: string) {
  const text = label
    .replace(/[\r\n]+/g, " ")
    .replace(/[!-/:-?[-`{-~]/g, "\\$&");
  return `[${text}](${target})`;
}

/** Picker selection during an edit becomes the same link as a preserved
 * mention, followed by the key that ended the name or a space. */
export const editMentionText = (
  { pubkey, name }: MentionRecipient,
  after = " ",
) => `${profileMentionLink(`@${name}`, `nostr:${npubEncode(pubkey)}`)}${after}`;

/** Keep attachment Markdown and turn already-bound names into explicit identities.
 * Edited legacy prose remains unbound; the editor never invents recipients. */
export function messageEditText(
  row: ChannelMessage,
  profiles: ReadonlyMap<string, Profile>,
  agents: AgentLibrary["identities"] = [],
) {
  const { attachmentSeams: _seams, ...source } = row;
  const content = row.sourceContent ?? row.content;
  const ranges = literalRanges(scanMarkdown(content).tree, true);
  let offset = 0;
  let next = 0;
  return profileMentionParts({ ...source, content }, profiles, agents)
    .map(({ text, target }) => {
      const start = offset;
      offset += text.length;
      while ((ranges[next]?.end ?? Infinity) <= start) next++;
      return target && (ranges[next]?.start ?? Infinity) >= offset
        ? profileMentionLink(text, target)
        : text;
    })
    .join("");
}

type Source = Readonly<{ url: string; start: number; end: number }>;

/** A sent attachment the edit keeps, with the Markdown that placed it. Nested
 * sources are other attachments inside that Markdown, relative to it. */
export type EditAttachment = Readonly<{
  attachment: Attachment;
  markdown: readonly Readonly<{ text: string; nested: readonly Source[] }>[];
}>;

/** Editable prose without attachment Markdown; attachments are kept separately.
 * Only Markdown that places a row attachment leaves the prose, outermost first.
 * A forward's media belongs to its quoted copy, so it stays put and is locked. */
export function messageEditDraft(
  row: ChannelMessage,
  profiles: ReadonlyMap<string, Profile>,
  agents: AgentLibrary["identities"] = [],
) {
  const body = messageEditText(row, profiles, agents);
  if (row.forward)
    return {
      text: body.trim(),
      attachments: [] as EditAttachment[],
      locked: row.attachments.map(({ url }) => url),
    };
  const urls = new Set(row.attachments.map(({ url }) => url));
  const sources = [...projectMarkdownAttachments(body, urls).sources]
    .filter(({ url }) => urls.has(url))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const ranges: Source[] = [];
  for (const range of sources)
    if (!(range.start < (ranges.at(-1)?.end ?? 0))) ranges.push(range);
  let text = "";
  let offset = 0;
  for (const { start, end } of ranges) {
    text += body.slice(offset, start);
    offset = end;
  }
  return {
    text: (text + body.slice(offset)).trim(),
    attachments: row.attachments.map((attachment) => ({
      attachment,
      markdown: ranges
        .filter(({ url }) => url === attachment.url)
        .map((outer) => ({
          text: body.slice(outer.start, outer.end),
          nested: sources
            .filter(
              (inner) =>
                inner !== outer &&
                inner.start >= outer.start &&
                inner.end <= outer.end,
            )
            .map((inner) => ({
              url: inner.url,
              start: inner.start - outer.start,
              end: inner.end - outer.start,
            })),
        })),
    })),
    locked: [] as string[],
  };
}

/** Kept attachments follow the prose, as a new message places its uploads.
 * Removed attachments nested in kept Markdown are cut out of it. */
export function messageEditContent(
  text: string,
  attachments: readonly EditAttachment[],
) {
  const kept = new Set(attachments.map(({ attachment }) => attachment.url));
  const files = attachments.flatMap(({ markdown }) =>
    markdown.map(({ text: source, nested }) => {
      let result = "";
      let offset = 0;
      for (const { url, start, end } of nested) {
        if (kept.has(url) || start < offset) continue;
        result += source.slice(offset, start);
        offset = end;
      }
      return result + source.slice(offset);
    }),
  );
  return files.length
    ? [text.trim(), ...files].filter(Boolean).join("\n\n")
    : text;
}
