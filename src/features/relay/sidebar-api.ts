import { ReadError } from "./errors.ts";

export type ReadCount =
  | { readonly status: "exact" | "at_least"; readonly value: number }
  | { readonly status: "unknown" };
export type ReadTarget = { channel_id: string; root_id?: string };
export type ReadIntent =
  | { type: "mark_through"; target: ReadTarget; message_id: string }
  | { type: "mark_channel_read"; channel_id: string; message_id: string };
export type ContextQuery = { target: ReadTarget; message_ids: string[] };
export type ReadAccount = {
  retention_seconds: number;
  cutoff_ms: number;
};
export type ThreadReadSummary = {
  root_id: string;
  unread: ReadCount;
  latest_reply_id: string;
  latest_reply_at: number;
};
export type ChannelReadSummary = {
  channel_id: string;
  name: string;
  channel_type: string;
  archived: boolean;
  hidden: boolean;
  unread: ReadCount;
  attention: ReadCount;
  latest_message_id: string | null;
  latest_message_at: number | null;
  latest_message_complete: boolean;
  threads: { items: ThreadReadSummary[]; complete: boolean };
};
export type SidebarPage = {
  account: ReadAccount;
  channels: ChannelReadSummary[];
  next_cursor: string | null;
};
const unreadReasons = [
  "direct",
  "mention",
  "conversation",
  "broadcast",
] as const;
export type UnreadReason = (typeof unreadReasons)[number];
export type MessageReadState = { message_id: string } & (
  | { status: "read" | "not_counted" | "unknown" | "unavailable" }
  | { status: "unread"; reason: UnreadReason | null }
);
export type ContextState =
  | { status: "unknown" | "unavailable" }
  | {
      status: "available";
      messages: MessageReadState[];
    };
export type IntentOutcome =
  | { status: "applied" | "blocked" | "invalid" }
  | { status: "unknown"; retryable: true };
export type SidebarRequest = { cursor?: string } | { channel_ids: string[] };
export type SidebarOperation =
  | { type: "sidebar"; query: SidebarRequest }
  | { type: "contexts"; targets: ContextQuery[] }
  | { type: "write"; intents: ReadIntent[] };
export type SidebarApi = {
  readonly eligibleKinds?: readonly number[];
  sidebar(query: SidebarRequest, signal: AbortSignal): Promise<SidebarPage>;
  contexts(
    targets: ContextQuery[],
    signal: AbortSignal,
  ): Promise<{ account: ReadAccount; contexts: ContextState[] }>;
  write(intents: ReadIntent[], signal: AbortSignal): Promise<IntentOutcome[]>;
};

const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const nullable = (v: unknown, test: (v: unknown) => boolean) =>
  v === null || test(v);
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((k) => allowed.includes(k));
const array = (
  v: unknown,
  max: number,
  test: (v: unknown) => boolean,
): v is unknown[] => Array.isArray(v) && v.length <= max && v.every(test);
const unique = (values: unknown[]) => new Set(values).size === values.length;
const target = (v: unknown) =>
  record(v) &&
  keys(v, ["channel_id", "root_id"]) &&
  uuid(v.channel_id) &&
  (v.root_id === undefined || id(v.root_id));
const count = (v: unknown) =>
  record(v) &&
  (v.status === "unknown"
    ? !("value" in v)
    : (v.status === "exact" || v.status === "at_least") &&
      integer(v.value) &&
      (v.status === "exact" || v.value > 0));
const account = (v: unknown) =>
  record(v) &&
  integer(v.retention_seconds) &&
  typeof v.cutoff_ms === "number" &&
  Number.isSafeInteger(v.cutoff_ms);
const message = (v: unknown) =>
  record(v) &&
  id(v.message_id) &&
  (["read", "not_counted", "unknown", "unavailable"].includes(
    String(v.status),
  ) ||
    (v.status === "unread" &&
      nullable(v.reason, (v) => unreadReasons.some((reason) => reason === v))));
const thread = (v: unknown) =>
  record(v) &&
  id(v.root_id) &&
  count(v.unread) &&
  id(v.latest_reply_id) &&
  integer(v.latest_reply_at);
const channel = (v: unknown) =>
  record(v) &&
  uuid(v.channel_id) &&
  typeof v.name === "string" &&
  typeof v.channel_type === "string" &&
  typeof v.archived === "boolean" &&
  typeof v.hidden === "boolean" &&
  count(v.unread) &&
  count(v.attention) &&
  nullable(v.latest_message_id, id) &&
  nullable(v.latest_message_at, integer) &&
  (v.latest_message_id === null) === (v.latest_message_at === null) &&
  typeof v.latest_message_complete === "boolean" &&
  record(v.threads) &&
  typeof v.threads.complete === "boolean" &&
  array(v.threads.items, 5, thread) &&
  unique(v.threads.items.map((t) => (t as ThreadReadSummary).root_id));
function invalid(): never {
  throw new ReadError("invalid-response", "Invalid sidebar API response");
}

/** One strict purpose-bound operation shared with the broker; no caller-supplied URL. */
export function sidebarOperation(value: unknown): {
  path: string;
  method: "GET" | "POST";
  body?: string;
} {
  if (!record(value)) throw new Error("Invalid sidebar operation");
  if (
    value.type === "sidebar" &&
    keys(value, ["type", "query"]) &&
    record(value.query)
  ) {
    const q = value.query;
    if (
      keys(q, ["channel_ids"]) &&
      array(q.channel_ids, 20, uuid) &&
      q.channel_ids.length &&
      unique(q.channel_ids)
    )
      return {
        path: `/buzz/v1/me/sidebar?${new URLSearchParams({ channel_ids: q.channel_ids.join(",") })}`,
        method: "GET",
      };
    if (keys(q, ["cursor"]) && (q.cursor === undefined || uuid(q.cursor)))
      return {
        path: `/buzz/v1/me/sidebar?${new URLSearchParams({ limit: "20", ...(q.cursor ? { cursor: q.cursor } : {}) })}`,
        method: "GET",
      };
  }
  if (
    value.type === "contexts" &&
    keys(value, ["type", "targets"]) &&
    array(
      value.targets,
      20,
      (v) =>
        record(v) &&
        keys(v, ["target", "message_ids"]) &&
        target(v.target) &&
        array(v.message_ids, 100, id),
    ) &&
    value.targets.length
  ) {
    const targets = value.targets as ContextQuery[];
    const path = `/buzz/v1/me/read-state?${new URLSearchParams({ targets: JSON.stringify(targets) })}`;
    if (
      targets.reduce((n, t) => n + t.message_ids.length, 0) <= 100 &&
      new TextEncoder().encode(path).length <= 16000
    )
      return { path, method: "GET" };
  }
  if (
    value.type === "write" &&
    keys(value, ["type", "intents"]) &&
    array(
      value.intents,
      100,
      (v) =>
        record(v) &&
        id(v.message_id) &&
        (v.type === "mark_through"
          ? keys(v, ["type", "target", "message_id"]) && target(v.target)
          : v.type === "mark_channel_read" &&
            keys(v, ["type", "channel_id", "message_id"]) &&
            uuid(v.channel_id)),
    ) &&
    value.intents.length
  ) {
    const body = JSON.stringify({ intents: value.intents });
    if (new TextEncoder().encode(body).length <= 64 * 1024)
      return { path: "/buzz/v1/me/read-state", method: "POST", body };
  }
  throw new Error("Invalid sidebar operation");
}

/** The in-place v1 contract is required as a whole, never inferred from an HTTP success. */
export function supportsSidebarApi(v: unknown): boolean {
  return (
    record(v) &&
    v.version === 1 &&
    v.base_path === "/buzz/v1" &&
    v.max_channels === 20 &&
    v.max_intents === 100 &&
    v.max_contexts === 20 &&
    v.max_context_messages === 100 &&
    v.max_thread_summaries === 5
  );
}

/** Eligibility for immediate presentation comes from this relay, not a client copy. */
export function sidebarEligibleKinds(value: unknown): readonly number[] {
  if (
    !record(value) ||
    !array(value.eligible_kinds, 100, integer) ||
    !unique(value.eligible_kinds)
  )
    return [];
  return Object.freeze([...(value.eligible_kinds as number[])]);
}

/** Bound encoded bytes before parsing; unknown response fields remain extensible. */
export async function sidebarResponse(response: Response): Promise<unknown> {
  if (!response.body) return invalid();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return JSON.parse(text + decoder.decode());
      bytes += part.value.byteLength;
      if (bytes > 1024 * 1024) return invalid();
      text += decoder.decode(part.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Validate correlation as well as shape before session-owned state may consume it. */
export function createSidebarApi(
  request: (
    operation: SidebarOperation,
    signal: AbortSignal,
  ) => Promise<unknown>,
  eligibleKinds: readonly number[] = [],
): SidebarApi {
  return {
    eligibleKinds,
    async sidebar(query, signal) {
      const op = { type: "sidebar", query } as const;
      sidebarOperation(op);
      const value = await request(op, signal);
      signal.throwIfAborted();
      if (
        !record(value) ||
        !account(value.account) ||
        !array(value.channels, 20, channel) ||
        !nullable(value.next_cursor, uuid)
      )
        return invalid();
      const page = value as SidebarPage;
      const ids = page.channels.map((c) => c.channel_id);
      if (!unique(ids) || ids.some((v, i) => i > 0 && v <= (ids[i - 1] ?? "")))
        return invalid();
      if ("channel_ids" in query) {
        if (
          page.next_cursor !== null ||
          ids.some((v) => !query.channel_ids.includes(v))
        )
          return invalid();
      } else if (
        ids.some((v) => query.cursor !== undefined && v <= query.cursor) ||
        (page.next_cursor !== null && page.next_cursor !== ids.at(-1))
      )
        return invalid();
      return page;
    },
    async contexts(targets, signal) {
      const op = { type: "contexts", targets } as const;
      sidebarOperation(op);
      const value = await request(op, signal);
      signal.throwIfAborted();
      if (
        !record(value) ||
        !account(value.account) ||
        !Array.isArray(value.contexts) ||
        value.contexts.length !== targets.length
      )
        return invalid();
      value.contexts.forEach((c: unknown, i: number) => {
        if (!record(c)) invalid();
        if (c.status === "unknown" || c.status === "unavailable") return;
        if (
          c.status !== "available" ||
          !array(c.messages, 100, message) ||
          c.messages.length !== targets[i]?.message_ids.length ||
          c.messages.some(
            (m, j) =>
              (m as MessageReadState).message_id !== targets[i]?.message_ids[j],
          )
        )
          invalid();
      });
      return value as { account: ReadAccount; contexts: ContextState[] };
    },
    async write(intents, signal) {
      const op = { type: "write", intents } as const;
      sidebarOperation(op);
      const value = await request(op, signal);
      signal.throwIfAborted();
      if (
        !record(value) ||
        value.projection_status !== "not_requested" ||
        !array(
          value.outcomes,
          intents.length,
          (v) =>
            record(v) &&
            (["applied", "blocked", "invalid"].includes(String(v.status)) ||
              (v.status === "unknown" && v.retryable === true)),
        ) ||
        value.outcomes.length !== intents.length
      )
        return invalid();
      return value.outcomes as IntentOutcome[];
    },
  };
}
