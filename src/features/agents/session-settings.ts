import type { ObserverFrame } from "./observer";

export type ReportedSessionSettings = {
  sessionId: string;
  timestamp: number;
  model: string | null;
  effort: string | null;
  requestedModel: string | null;
  modelFailure: "failure" | "unsupported_model" | null;
  requestedEffort: string | null;
  effortRejected: boolean;
};
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const text = (value: unknown): string | null =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  [...value].every(
    (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
  )
    ? value
    : null;
type Item = {
  seq: number;
  timestamp: number;
  kind: string;
  payload: Record<string, unknown>;
  sessionId: string | null;
};

/** Project bounded, already owner/channel-verified activity into historical
 * session facts. These events do not identify the current native launch. */
export function reportedSessionSettings(
  records: readonly ObserverFrame[],
  agent: string,
  relay: string,
): ReportedSessionSettings[] {
  const turns = new Map<string, Item[]>();
  for (const record of records) {
    if (record.agent !== agent) continue;
    let envelope: Record<string, unknown> | undefined;
    try {
      envelope = object(JSON.parse(record.plaintext));
    } catch {
      continue;
    }
    const children =
      envelope?.kind === "batch"
        ? object(envelope.payload)?.events
        : [envelope];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      const item = object(child);
      const payload = object(item?.payload);
      const turn = text(item?.turnId);
      const kind = text(item?.kind);
      const seq = item?.seq;
      const index = item?.agentIndex;
      const timestamp =
        typeof item?.timestamp === "string" ? Date.parse(item.timestamp) : NaN;
      if (
        !payload ||
        !turn ||
        !kind ||
        !Number.isSafeInteger(seq) ||
        (seq as number) < 0 ||
        !Number.isSafeInteger(index) ||
        (index as number) < 0 ||
        !(item?.channelId === null || text(item?.channelId)) ||
        !Number.isFinite(timestamp) ||
        timestamp > Date.now() + 5000
      )
        continue;
      if (
        ![
          "session_config_captured",
          "session_resolved",
          "control_result",
          "acp_write",
          "acp_read",
        ].includes(kind)
      )
        continue;
      const key = JSON.stringify([turn, index, item?.channelId]);
      const list = turns.get(key) ?? [];
      list.push({
        seq: seq as number,
        timestamp,
        kind,
        payload,
        sessionId: text(item?.sessionId),
      });
      turns.set(key, list);
    }
  }
  const sessions = new Map<string, ReportedSessionSettings>();
  for (const items of turns.values()) {
    items.sort((a, b) => a.seq - b.seq);
    const capture = items
      .slice()
      .reverse()
      .find(
        (item) =>
          item.kind === "session_config_captured" &&
          item.payload.relayUrl === relay,
      );
    if (!capture) continue;
    // Startup capture precedes session_resolved and has a null session ID.
    // Join by exact turn/worker/channel, never by arrival order or agent alone.
    const resolved = items.find(
      (item) =>
        item.kind === "session_resolved" &&
        item.payload.isNewSession === true &&
        item.seq > capture.seq &&
        item.timestamp >= capture.timestamp &&
        text(item.payload.sessionId) === item.sessionId &&
        !!item.sessionId,
    );
    if (
      !resolved?.sessionId ||
      (capture.sessionId && capture.sessionId !== resolved.sessionId)
    )
      continue;
    const options = Array.isArray(capture.payload.configOptions)
      ? capture.payload.configOptions.map(object)
      : [];
    const modelOption = options.find((option) => option?.category === "model");
    const effortOption = options.find(
      (option) => option?.category === "thought_level",
    );
    const before = items.filter((item) => item.seq < capture.seq);
    const failure = before
      .slice()
      .reverse()
      .find(
        (item) =>
          item.kind === "control_result" &&
          item.payload.type === "switch_model" &&
          ["failure", "unsupported_model"].includes(
            String(item.payload.status),
          ) &&
          text(item.payload.modelId),
      );
    const effortId = text(effortOption?.configId) ?? text(effortOption?.id);
    const request = effortId
      ? before
          .slice()
          .reverse()
          .find((item) => {
            const params = object(item.payload.params);
            return (
              item.kind === "acp_write" &&
              item.payload.method === "session/set_config_option" &&
              params?.sessionId === resolved.sessionId &&
              params?.configId === effortId &&
              text(params?.value)
            );
          })
      : undefined;
    const rejected =
      request &&
      before.some(
        (item) =>
          item.kind === "acp_read" &&
          item.seq > request.seq &&
          item.payload.id === request.payload.id &&
          request.payload.id !== undefined &&
          !("method" in item.payload) &&
          !!object(item.payload.error),
      );
    const report: ReportedSessionSettings = {
      sessionId: resolved.sessionId,
      timestamp: capture.timestamp,
      model:
        text(modelOption?.currentValue) ??
        text(object(capture.payload.models)?.currentModelId),
      effort: text(effortOption?.currentValue),
      requestedModel: text(failure?.payload.modelId),
      modelFailure: failure
        ? (failure.payload.status as "failure" | "unsupported_model")
        : null,
      requestedEffort: text(object(request?.payload.params)?.value),
      effortRejected: !!rejected,
    };
    const previous = sessions.get(report.sessionId);
    if (!previous || previous.timestamp < report.timestamp)
      sessions.set(report.sessionId, report);
  }
  return [...sessions.values()]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 5);
}
