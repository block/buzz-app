// Device-local storage for Agents2 agents: each agent's attention objects in the
// `agent-attention/v1` shape, one JSON blob its plugin type owns, and its timers'
// run state. The key and owner attestation live in native custody, never here. A
// relay-backed store can replace this later without changing the record shape.
import {
  type AttentionObject,
  type AttentionValue,
  type TimerState,
  validateObject,
} from "./attention";

export type AgentRecord = Readonly<{
  pubkey: string;
  /** The registered agent type's key, `pluginId/typeId`. */
  type: string;
  name: string;
  /** Keyed by slug (`interest/<id>` or `watch/<id>`). */
  attention: Readonly<Record<string, AttentionObject>>;
  /** Plugin-owned config. The host never reads it. */
  config: unknown;
  /** Run state of its timers, by slug. Not config, so it never leaves the device;
   * kept here so removing a timer or the agent removes its state with it. */
  timers?: Readonly<Record<string, TimerState>>;
}>;
type Stored = { version: 1; agents: Record<string, AgentRecord> };

export const STORAGE_KEY = "buzz.agents2.v1";
const PUBKEY = /^[0-9a-f]{64}$/;

/** Reads every record, dropping any attention object a reader would ignore. */
export function readRecords(storage: Storage): Record<string, AgentRecord> {
  let stored: unknown;
  try {
    stored = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    return {};
  }
  if (
    !stored ||
    typeof stored !== "object" ||
    (stored as Stored).version !== 1 ||
    typeof (stored as Stored).agents !== "object"
  )
    return {};
  const records: Record<string, AgentRecord> = {};
  for (const [pubkey, record] of Object.entries((stored as Stored).agents)) {
    if (
      !PUBKEY.test(pubkey) ||
      record?.pubkey !== pubkey ||
      typeof record.type !== "string" ||
      typeof record.name !== "string"
    )
      continue;
    const attention: Record<string, AttentionObject> = {};
    for (const [slug, object] of Object.entries(record.attention ?? {}))
      if (
        object?.slug === slug &&
        Number.isSafeInteger(object.modifiedAt) &&
        !validateObject(slug, object.value)
      )
        attention[slug] = object;
    const timers: Record<string, TimerState> = {};
    for (const [slug, state] of Object.entries(record.timers ?? {}))
      if (
        attention[slug]?.value.type === "timer" &&
        [state?.armedAt, state?.nextDue, state?.used].every(
          Number.isSafeInteger,
        )
      )
        timers[slug] = state;
    records[pubkey] = { ...record, attention, timers };
  }
  return records;
}

export function writeRecords(
  storage: Storage,
  records: Readonly<Record<string, AgentRecord>>,
) {
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({ version: 1, agents: records } satisfies Stored),
  );
}

/** Replaces or deletes (`value: null`) one attention object, after validating it.
 * A slug that stops being a timer loses its timer state. */
export function setAttention(
  record: AgentRecord,
  slug: string,
  value: AttentionValue | null,
  now = Math.floor(Date.now() / 1000),
): AgentRecord {
  const { [slug]: _, ...rest } = record.attention;
  const { [slug]: __, ...timers } = record.timers ?? {};
  const kept = value?.type === "timer" ? (record.timers ?? {}) : timers;
  if (value === null) return { ...record, attention: rest, timers: kept };
  const problem = validateObject(slug, value);
  if (problem) throw new Error(problem);
  return {
    ...record,
    attention: { ...rest, [slug]: { slug, value, modifiedAt: now } },
    timers: kept,
  };
}
