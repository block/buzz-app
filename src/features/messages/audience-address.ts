import type { ChannelMessage } from "../relay/contracts";
import { profilePanelKey } from "../profiles/target";
import type { profileMentionParts } from "./profile-mentions";

/** Who a message opens by addressing — its leading bound mentions — and the
 * message as shown without them. Display only: a message that is nothing but
 * mentions, or opens with prose, is shown as written. */
export function addressedMessage(
  row: ChannelMessage,
  parts: ReturnType<typeof profileMentionParts>,
): Readonly<{ recipients: readonly string[]; body: ChannelMessage }> {
  const recipients: string[] = [];
  let cut = 0;
  for (const part of parts) {
    const key = part.target && profilePanelKey(part.target);
    if (key) {
      if (!recipients.includes(key)) recipients.push(key);
      cut += part.text.length;
      continue;
    }
    if (part.target) break;
    const gap = /^[ \t,:]*/.exec(part.text)?.[0].length ?? 0;
    cut += gap;
    if (gap < part.text.length) break;
  }
  if (!recipients.length || !row.content.slice(cut).trim())
    return { recipients: [], body: row };
  const seams = row.attachmentSeams
    ?.map((seam) => seam - cut)
    .filter((seam) => seam > 0);
  const { attachmentSeams: _, ...rest } = row;
  return {
    recipients,
    body: {
      ...rest,
      content: row.content.slice(cut),
      ...(seams?.length ? { attachmentSeams: seams } : {}),
    },
  };
}

/** An agent's message for other people reads to this viewer as coordination
 * between agents: its signed `p` tags name someone other than its author, and
 * none of them is the viewer. Display only; notifications still follow the
 * signed `audience` tag. */
export function viewerAudience<Row extends ChannelMessage>(
  row: Row,
  viewer: string | undefined,
  agents: ReadonlySet<string> | undefined,
): Row {
  if (row.audience || row.membership || !viewer || row.authorId === viewer)
    return row;
  if (!row.agentEnvelope && !agents?.has(row.authorId)) return row;
  const to = row.mentions.filter((pubkey) => pubkey !== row.authorId);
  return to.length && !to.includes(viewer)
    ? { ...row, audience: "agents" }
    : row;
}

/** The rows as this viewer reads them; unchanged rows keep the list's identity. */
export function viewerAudienceRows<Row extends ChannelMessage>(
  rows: readonly Row[],
  viewer: string | undefined,
  agents: ReadonlySet<string> | undefined,
): readonly Row[] {
  const shown = rows.map((row) => viewerAudience(row, viewer, agents));
  return shown.every((row, index) => row === rows[index]) ? rows : shown;
}
