import type { ActivityTurn } from "../../features/agents/activity";
import type { ActivityRecord } from "../../features/agents/activity-records";
import { activityTranscript } from "./transcript";

/** Old Buzz 4472da6: profileActivityFeedScope + profileActivityCarousel.
 * Same selection policy over this session's available evidence, not archive parity.
 * A missing selection falls back; live preference is lexical, not a new recency rule. */
export function profileActivityChannels(
  records: readonly Omit<ActivityRecord, "envelopeId">[],
  turns: readonly ActivityTurn[],
  agent: string,
) {
  const live = turns.filter(
    (turn) =>
      turn.agent === agent && turn.state === "working" && turn.channelId,
  );
  if (live.length) {
    const channels = [...new Set(live.map((turn) => turn.channelId as string))];
    return {
      channels,
      preferred: [...channels].sort((a, b) => a.localeCompare(b))[0] ?? "",
    };
  }
  const retained = records.filter((record) => record.agent === agent);
  const channels = new Set<string>();
  let latestEvent = "";
  const lifecycle = new Map<string, { id: string; channel: string }>();
  const kinds = new Map<string, string>();
  for (const record of retained) {
    try {
      const envelope = JSON.parse(record.plaintext);
      const items =
        envelope?.kind === "batch" ? envelope.payload?.events : [envelope];
      if (!Array.isArray(items)) continue;
      for (const [index, item] of items.entries()) {
        const id =
          envelope?.kind === "batch" ? `${record.id}:${index}` : record.id;
        kinds.set(id, item?.kind);
        const channel = item?.channelId;
        // Batch children never inherit their envelope's channel.
        if (typeof channel === "string" && channel && channel.length <= 256) {
          channels.add(channel);
          latestEvent = channel;
          // Old Buzz retains start/session-ready transcript items even though
          // our readable stream omits these repetitive rows. Upserts keep order.
          if (
            item.kind === "turn_started" ||
            item.kind === "session_resolved"
          ) {
            const key = JSON.stringify([
              channel,
              item.kind,
              item.turnId ?? item.seq,
            ]);
            if (!lifecycle.has(key)) lifecycle.set(key, { id, channel });
          }
        }
      }
    } catch {
      /* Unreadable evidence cannot invent a scope. */
    }
  }
  const transcript = activityTranscript(
    retained.map((record) => ({ ...record, envelopeId: record.id })),
  );
  let latestTranscript = "",
    last = -Infinity;
  for (const group of transcript.groups) {
    if (!group.channelId) continue;
    for (const entry of group.entries) {
      // Turn completion itself is not a transcript row in old Buzz.
      if (kinds.get(entry.id) === "turn_completed") continue;
      // Old transcript items retain their insertion order through tool updates.
      const order = transcript.sourceOrder.get(entry.id) ?? -Infinity;
      if (order > last) {
        last = order;
        latestTranscript = group.channelId;
      }
    }
  }
  for (const item of lifecycle.values()) {
    const order = transcript.sourceOrder.get(item.id) ?? -Infinity;
    if (order > last) {
      last = order;
      latestTranscript = item.channel;
    }
  }
  return {
    channels: [...channels].sort((a, b) => a.localeCompare(b)),
    preferred: latestTranscript || latestEvent,
  };
}

export function resolveProfileActivityChannel(
  channels: readonly string[],
  selected: string,
  preferred: string,
) {
  return channels.includes(selected)
    ? selected
    : channels.includes(preferred)
      ? preferred
      : (channels[0] ?? "");
}

/** With two slides old Buzz also advances when the selected dot is clicked. */
export function chooseProfileActivityChannel(
  channels: readonly string[],
  current: string,
  clicked: string,
) {
  return channels.length === 2 && current === clicked
    ? (channels.find((id) => id !== current) ?? clicked)
    : clicked;
}
