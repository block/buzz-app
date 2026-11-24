import type { Attachment } from "./contracts";

/** A plain description of attachments, for a line of text that attachment
 * presentation left empty: "Image", "2 videos", "3 attachments". Empty when
 * there are none. */
export function attachmentSummary(
  attachments: readonly Pick<Attachment, "kind">[],
): string {
  const count = attachments.length;
  if (!count) return "";
  const [first] = attachments;
  const kind = attachments.every((item) => item.kind === first?.kind)
    ? first?.kind
    : undefined;
  const noun =
    kind === "image" ? "image" : kind === "video" ? "video" : "attachment";
  return count === 1
    ? `${noun[0]?.toUpperCase()}${noun.slice(1)}`
    : `${count} ${noun}s`;
}

/** An embed no `imeta` describes: a video by its extension, else an image. */
export const markdownImageKind = (url: string): Attachment["kind"] =>
  /\.(mp4|webm)(?:\?|$)/i.test(url) ? "video" : "image";
