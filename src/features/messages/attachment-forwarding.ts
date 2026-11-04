import type { Attachment, ChannelMessage } from "../relay/contracts";

export const ATTACHMENT_FORWARD_MIME = "application/x-buzz-attachment-forward";

type Payload = Readonly<{
  type: "buzz-attachment-forward";
  version: 1;
  sourceMessageId: string;
  sourceChannelId: string;
  attachmentUrls: readonly string[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function attachmentForwardPayload(
  source: Pick<ChannelMessage, "id" | "channelId">,
  attachments: readonly Pick<Attachment, "url">[],
): string {
  return JSON.stringify({
    type: "buzz-attachment-forward",
    version: 1,
    sourceMessageId: source.id,
    sourceChannelId: source.channelId,
    attachmentUrls: [
      ...new Set(attachments.map((attachment) => attachment.url)),
    ],
  } satisfies Payload);
}

export function parseAttachmentForwardPayload(
  raw: string,
): Payload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (
    parsed.type !== "buzz-attachment-forward" ||
    parsed.version !== 1 ||
    typeof parsed.sourceMessageId !== "string" ||
    !parsed.sourceMessageId ||
    typeof parsed.sourceChannelId !== "string" ||
    !parsed.sourceChannelId ||
    !Array.isArray(parsed.attachmentUrls)
  )
    return undefined;
  const attachmentUrls = parsed.attachmentUrls.filter(
    (url): url is string => typeof url === "string" && !!url,
  );
  return attachmentUrls.length
    ? {
        type: "buzz-attachment-forward",
        version: 1,
        sourceMessageId: parsed.sourceMessageId,
        sourceChannelId: parsed.sourceChannelId,
        attachmentUrls: [...new Set(attachmentUrls)],
      }
    : undefined;
}

export function attachmentsFromForwardPayload(
  payload: ReturnType<typeof parseAttachmentForwardPayload>,
  rows: readonly ChannelMessage[],
): { source: ChannelMessage; attachments: readonly Attachment[] } | undefined {
  if (!payload) return undefined;
  const source = rows.find(
    (row) =>
      row.id === payload.sourceMessageId &&
      row.channelId === payload.sourceChannelId,
  );
  if (!source) return undefined;
  const urls = new Set(payload.attachmentUrls);
  const attachments = source.attachments.filter((attachment) =>
    urls.has(attachment.url),
  );
  return attachments.length === urls.size ? { source, attachments } : undefined;
}
