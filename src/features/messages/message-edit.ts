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

/** A sent attachment the edit keeps, with the Markdown that placed it. */
export type EditAttachment = Readonly<{
  attachment: Attachment;
  markdown: readonly string[];
}>;

/** Editable prose without attachment Markdown; attachments are kept separately.
 * Only Markdown that places a row attachment leaves the prose, outermost first. */
export function messageEditDraft(
  row: ChannelMessage,
  profiles: ReadonlyMap<string, Profile>,
  agents: AgentLibrary["identities"] = [],
) {
  const body = messageEditText(row, profiles, agents);
  const urls = new Set(row.attachments.map(({ url }) => url));
  const ranges: { url: string; start: number; end: number }[] = [];
  for (const range of [...projectMarkdownAttachments(body, urls).sources].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  ))
    if (urls.has(range.url) && !(range.start < (ranges.at(-1)?.end ?? 0)))
      ranges.push(range);
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
        .map(({ start, end }) => body.slice(start, end)),
    })),
  };
}

/** Kept attachments follow the prose, as a new message places its uploads. */
export function messageEditContent(
  text: string,
  attachments: readonly EditAttachment[],
) {
  const files = attachments.flatMap(({ markdown }) => markdown);
  return files.length
    ? [text.trim(), ...files].filter(Boolean).join("\n\n")
    : text;
}
