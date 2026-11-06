import { useMemo } from "react";
import type { ConversationExtensions } from "../conversation/contracts";
import {
  PLAIN_TEXT_LIMIT,
  plainText,
  shortText,
} from "../notifications/content";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { MessageMarkdown } from "./MessageMarkdown";
import { useReferenceDirectory } from "./ReferenceText";

/** A body's bounded plain text, else what it attaches. */
export const plainPreview = (
  row: Pick<ChannelMessage, "content" | "attachments">,
  text = plainText(row.content),
) => text || attachmentLabel(row.attachments) || "New message";

const attachmentNouns = {
  image: ["Image", "images"],
  video: ["Video", "videos"],
  audio: ["Audio", "audio files"],
  file: ["File", "files"],
} as const;

/** Names an attachment-only message: "GIF", "Voice message", "report.pdf",
 * "3 images" or, for mixed kinds, "3 attachments". */
export function attachmentLabel(
  attachments: ChannelMessage["attachments"],
): string | undefined {
  const [first, ...rest] = attachments;
  if (!first) return undefined;
  if (!rest.length) {
    if (first.voiceNote) return "Voice message";
    // A sender-supplied name: one bounded line, without bidi overrides.
    const name =
      first.kind === "file" && shortText(first.name ?? "", PLAIN_TEXT_LIMIT);
    if (name) return name;
    if (
      first.kind === "image" &&
      (first.mime === "image/gif" || /\.gif(?:[?#]|$)/i.test(first.url))
    )
      return "GIF";
    return attachmentNouns[first.kind][0];
  }
  return rest.every((attachment) => attachment.kind === first.kind)
    ? `${attachments.length} ${attachmentNouns[first.kind][1]}`
    : `${attachments.length} attachments`;
}

/** The message body as its timeline row renders it, inert inside the row's button. */
export function MessagePreview({
  row,
  session,
  extensions,
}: {
  row: ChannelMessage;
  session: RelaySession;
  extensions?: ConversationExtensions | undefined;
}) {
  const directory = useReferenceDirectory(session);
  const text = useMemo(() => plainText(row.content), [row.content]);
  const fallback = plainPreview(row, text);
  // Attachment-only and fully hidden bodies keep the plain text, as does a
  // diff, whose content is a raw patch the timeline never renders as Markdown.
  if (row.diff || !text) return fallback;
  return (
    <MessageMarkdown
      row={row}
      directory={directory}
      session={session}
      scope={session.scope}
      extensions={extensions}
      media={session.media}
      onOpenLink={() => false}
      interactive={false}
      compact
      fallback={fallback}
    />
  );
}
