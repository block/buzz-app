import type { ChannelMessage } from "../relay/contracts";

/** Display hints only, never identity or authority verification. Keep the
 * content preview whenever the original routing cannot justify a quieter label. */
export function hasCoordinationPreview(
  row: ChannelMessage,
  agents: ReadonlySet<string> | undefined,
): boolean {
  return (
    row.audience === "agents" &&
    !!agents?.has(row.authorId) &&
    row.mentions.length > 0 &&
    row.mentions.every((id) => agents.has(id)) &&
    !row.edited &&
    !row.attachments.length &&
    !row.notice &&
    !row.diff &&
    !row.forward &&
    !row.relayedFrom &&
    !row.pluginRequest &&
    !row.membership &&
    !row.huddle &&
    !row.workflowOwnerId &&
    (!row.delivery || row.delivery === "accepted" || row.delivery === "seen")
  );
}

export function coordinationLabel(count: number): string {
  return `Agent coordination · ${count} ${count === 1 ? "message" : "messages"}`;
}
