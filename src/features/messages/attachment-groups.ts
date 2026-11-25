import type { ChannelMessage } from "../relay/contracts";
import { snapshotAttachments } from "../relay/forwarded-message";
import { safeMessageUrl } from "../relay/message-content";

type Attachment = ChannelMessage["attachments"][number];

/** A message's attachments as its row lists them, in the sender's order,
 * without unsafe links and those a message renderer draws itself. Images and
 * files group with their own kind; where the host opens a gallery, images and
 * videos share a group. */
export function attachmentGroups(
  row: ChannelMessage,
  {
    claimed,
    drawn,
    gallery,
  }: {
    /** A message renderer draws it in its card. */
    claimed(attachment: Attachment): boolean;
    /** A plugin draws it itself, so it stands alone. */
    drawn(attachment: Attachment): boolean;
    gallery: boolean;
  },
) {
  const copiedUrls = new Set(
    row.forward ? snapshotAttachments(row).map(({ url }) => url) : [],
  );
  const groups: Attachment[][] = [];
  for (const attachment of row.attachments) {
    if (!safeMessageUrl(attachment.url) || claimed(attachment)) continue;
    const previous = groups.at(-1);
    if (
      previous?.[0] &&
      copiedUrls.has(previous[0].url) === copiedUrls.has(attachment.url) &&
      !drawn(attachment) &&
      !drawn(previous[0]) &&
      (((attachment.kind === "image" || attachment.kind === "file") &&
        previous[0].kind === attachment.kind) ||
        (gallery &&
          (attachment.kind === "image" || attachment.kind === "video") &&
          (previous[0].kind === "image" || previous[0].kind === "video")))
    )
      previous.push(attachment);
    else groups.push([attachment]);
  }
  return { groups, copiedUrls };
}

/** The videos a row draws as players, named by their safe URLs. A group of
 * four or more is a grid of tiles that open the gallery instead. */
export function playerVideos(groups: readonly (readonly Attachment[])[]) {
  return groups.flatMap((group) =>
    group.length >= 4
      ? []
      : group.flatMap((attachment) => {
          const url =
            attachment.kind === "video" && safeMessageUrl(attachment.url);
          return url ? [{ ...attachment, url }] : [];
        }),
  );
}
