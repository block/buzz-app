// Agent attention on the relay ("Agent Attention configuration on the relay"):
// each Interest, watch or timer is one NIP-AR artifact of type
// `buzz.agent-attention` in the agent's attention channel, a private system
// channel the agent creates and shares with its owner. This module holds the
// record codec and checks, the channel's find and create steps, one writer
// revision, and the kept-current set. The agents service decides which agents
// use it and keeps the device record as their mirror.
import {
  OBJECT_LIMIT,
  validateObject,
  type AttentionObject,
  type AttentionValue,
} from "./attention";
import {
  ARTIFACT_KIND,
  deliver,
  readHead,
  type Refusal,
  refusal,
  type SnapshotRead,
} from "./agent-config-artifacts";
import { unconfirmedAgentEvent } from "./native";
import { AttentionError, canonical } from "./attention-objects";
import { setAttention, type AgentRecord, type SkippedObject } from "./store";
import { memberAuthority } from "../channel-members/administration-protocol";
import {
  channelIdentity,
  channelLabelTags,
  compareChannelAge,
} from "../relay/channel-labels";
import type { RelayEvent } from "../relay/events";
import type { RelayWriter } from "../relay/transport";
import type {
  ArtifactSyncSnapshot,
  ArtifactSyncView,
} from "../relay/artifact-sync";

export const ATTENTION_TYPE = "buzz.agent-attention";
export const ATTENTION_LABEL = "agent-attention";
export const ATTENTION_SCHEMA = "agent-attention/v1";
/** The largest record content (`validateObject`'s storage bound). */
const CONTENT_BYTES = 65_535;
/** Heads of the type a writer lets the channel hold, valid or not: the
 * relay's sync limit counts every one. */
export const HEAD_LIMIT = 2 * OBJECT_LIMIT;

const encoder = new TextEncoder();
const tag = (event: Pick<RelayEvent, "tags">, name: string) => {
  const found = event.tags.filter((t) => t[0] === name);
  const [only] = found;
  return found.length === 1 && only?.length === 2 ? only[1] : undefined;
};

/** NIP-AR's standard `d`: UUIDv8 of the first 16 bytes of
 * SHA-256("nip-ar-artifact\0" + h + "\0" + type + "\0" + key). */
export async function attentionD(channel: string, slug: string) {
  const input = encoder.encode(
    `nip-ar-artifact\0${channel}\0${ATTENTION_TYPE}\0${slug}`,
  );
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x80;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...hash.slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** One record's current revision. */
export type RelayHead = Readonly<{ id: string; d: string }>;
/** One complete set of the channel's records, checked. */
export type AttentionSet = Readonly<{
  channel: string;
  attention: Readonly<Record<string, AttentionObject>>;
  skipped: Readonly<Record<string, SkippedObject>>;
  /** Each record's head, by its key in `attention` or `skipped`. */
  heads: Readonly<Record<string, RelayHead>>;
  /** Heads of the type, valid or not. */
  count: number;
}>;

export const emptySet = (channel: string): AttentionSet => ({
  channel,
  attention: {},
  skipped: {},
  heads: {},
  count: 0,
});

const group = (value: AttentionValue) =>
  value.type === "interest" ? "Interests" : "watches";

/** The set that `events`, the channel's current heads, describe (Reader step
 * 3): a record that fails its checks is skipped and reported, the others
 * apply. Over a count limit, each group applies its first records by slug. */
export async function attentionSet(
  channel: string,
  events: readonly RelayEvent[],
): Promise<AttentionSet> {
  const skipped: Record<string, SkippedObject> = {};
  const heads: Record<string, RelayHead> = {};
  const valid: AttentionObject[] = [];
  let count = 0;
  for (const event of events) {
    if (
      event.kind !== ARTIFACT_KIND ||
      tag(event, "type") !== ATTENTION_TYPE ||
      tag(event, "h") !== channel
    )
      continue;
    count++;
    const d = tag(event, "d");
    if (!d) continue;
    const modifiedAt = event.created_at;
    let body: unknown;
    try {
      body = JSON.parse(event.content);
    } catch {
      body = undefined;
    }
    const fields =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : undefined;
    const slug = typeof fields?.slug === "string" ? fields.slug : undefined;
    const problem =
      tag(event, "ar") !== "1"
        ? "Unsupported artifact envelope"
        : !fields
          ? "Record content is not a JSON object"
          : fields.schema !== ATTENTION_SCHEMA
            ? `Unknown schema ${String(fields.schema)}`
            : Object.keys(fields).sort().join() !== "schema,slug,value"
              ? "Record content has other fields than schema, slug and value"
              : !slug || (await attentionD(channel, slug)) !== d
                ? "Record identity does not match its slug"
                : encoder.encode(event.content).length > CONTENT_BYTES
                  ? "Record content is too large"
                  : validateObject(slug, fields.value);
    // A record whose slug can't be trusted is kept under its own `d`.
    const key =
      problem === undefined ||
      (slug && problem !== "Record identity does not match its slug")
        ? (slug as string)
        : `invalid/${d}`;
    if (key in heads) continue;
    heads[key] = { id: event.id, d };
    if (problem !== undefined)
      skipped[key] = {
        slug: key,
        value: fields?.value ?? event.content,
        modifiedAt,
        problem,
      };
    else
      valid.push({
        slug: key,
        value: fields?.value as AttentionValue,
        modifiedAt,
      });
  }
  const attention: Record<string, AttentionObject> = {};
  const counts = { Interests: 0, watches: 0 };
  for (const object of valid.sort((a, b) => (a.slug < b.slug ? -1 : 1))) {
    const kind = group(object.value);
    if (++counts[kind] > OBJECT_LIMIT)
      skipped[object.slug] = {
        ...object,
        problem: `Over the limit of ${OBJECT_LIMIT} ${kind}`,
      };
    else attention[object.slug] = object;
  }
  return { channel, attention, skipped, heads, count };
}

const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** `record` showing `set` (Reader step 7). Each changed object goes through
 * `setAttention`, so the runtime state rules are a local edit's; an object
 * whose value is unchanged stays the same object, so work in flight for it
 * goes on. The objects' times are their revisions'. */
export function mirrored(
  record: AgentRecord,
  set: AttentionSet,
  now = Math.floor(Date.now() / 1000),
): AgentRecord {
  let next = record;
  for (const slug of Object.keys(record.attention))
    if (!set.attention[slug]) next = setAttention(next, slug, null, now);
  for (const [slug, object] of Object.entries(set.attention)) {
    const current = next.attention[slug];
    if (current && sameValue(current.value, object.value)) continue;
    next = setAttention(next, slug, object.value, now);
    next = {
      ...next,
      attention: { ...next.attention, [slug]: object },
    };
  }
  const skipped = record.skipped ?? {};
  const same =
    Object.keys(skipped).length === Object.keys(set.skipped).length &&
    Object.entries(set.skipped).every(([slug, object]) =>
      sameValue(skipped[slug], object),
    );
  return same ? next : { ...next, skipped: set.skipped };
}

/** The single object an edit changes, from `before` to `after` (Writer step
 * 3), or undefined when it changes none. A skipped record's removal counts.
 * Throws when it changes more than one. */
export function attentionChange(
  before: AgentRecord,
  after: AgentRecord,
): Readonly<{ slug: string; value: AttentionValue | null }> | undefined {
  const changed = new Set<string>();
  for (const slug of new Set([
    ...Object.keys(before.attention),
    ...Object.keys(after.attention),
  ])) {
    const was = before.attention[slug];
    const now = after.attention[slug];
    if (!!was !== !!now || (was && now && !sameValue(was.value, now.value)))
      changed.add(slug);
  }
  for (const slug of Object.keys(before.skipped ?? {}))
    if (!after.skipped?.[slug] && !after.attention[slug]) changed.add(slug);
  if (changed.size > 1)
    throw new Error("Change one Interest or watch at a time");
  const [slug] = changed;
  return slug === undefined
    ? undefined
    : { slug, value: after.attention[slug]?.value ?? null };
}

/** The revision to sign: a complete snapshot, or a deletion. */
export function revision(input: {
  channel: string;
  d: string;
  slug: string;
  op: "create" | "update" | "restore" | "delete";
  prev?: string | undefined;
  value?: AttentionValue | undefined;
}) {
  const { channel, d, slug, op, prev, value } = input;
  if ((op === "create") !== (prev === undefined))
    throw new Error("Only a create has no previous revision");
  const content =
    op === "delete"
      ? ""
      : JSON.stringify({ schema: ATTENTION_SCHEMA, slug, value });
  if (encoder.encode(content).length > CONTENT_BYTES)
    throw new AttentionError("invalid", `${slug} is too large to store`);
  return {
    kind: ARTIFACT_KIND,
    content,
    tags: [
      ["ar", "1"],
      ["d", d],
      ["h", channel],
      ["type", ATTENTION_TYPE],
      ...(op === "delete" ? [] : [["title", slug]]),
      ["op", op],
      ...(prev ? [["prev", prev]] : []),
    ],
  };
}
export type Revision = ReturnType<typeof revision>;

/** One send's answer: a send whose answer was lost is `uncertain`, with the
 * id of what was signed when it is known. */
export type Sent =
  | Readonly<{ status: "accepted"; id: string }>
  | Readonly<{ status: "refused"; refusal: Refusal; message: string }>
  | Readonly<{ status: "uncertain"; id?: string; message: string }>;
/** Signs and sends one revision as the agent or its owner. Sending the same
 * `event` again may sign it again. */
export type RevisionSender = (event: Revision) => Promise<Sent>;

/** An owner's send through its session's artifact writer: a resend sends the
 * same signed event (Writer step 5). */
export function ownerSender(
  writer: RelayWriter,
  signal: AbortSignal,
): RevisionSender {
  const signed = new WeakMap<Revision, RelayEvent>();
  return async (event) => {
    let sent = signed.get(event);
    if (!sent) {
      sent = await writer.sign(
        { ...event, created_at: Math.floor(Date.now() / 1000) },
        signal,
      );
      signed.set(event, sent);
    }
    const delivery = await deliver(writer, sent, signal);
    return delivery.status === "accepted"
      ? { status: "accepted", id: delivery.event.id }
      : delivery.status === "uncertain"
        ? {
            status: "uncertain",
            id: delivery.event.id,
            message: delivery.message,
          }
        : delivery;
  };
}

/** The agent's send through its custody, which signs each send anew. */
export function agentSender(
  publish: (event: Revision) => Promise<Pick<RelayEvent, "id">>,
): RevisionSender {
  return async (event) => {
    try {
      return { status: "accepted", id: (await publish(event)).id };
    } catch (error) {
      return agentDelivery(error, unconfirmedAgentEvent(error));
    }
  };
}

/** A relay answer the agent's signed post refused, as a typed refusal. */
export function agentDelivery(error: unknown, unconfirmed?: string): Sent {
  const message = error instanceof Error ? error.message : String(error);
  if (unconfirmed) return { status: "uncertain", id: unconfirmed, message };
  const reason = message.replace(
    /^The community refused the agent event: /,
    "",
  );
  const kind = refusal(reason);
  return kind === "unknown"
    ? { status: "uncertain", message }
    : { status: "refused", refusal: kind, message: reason };
}

/** Publishes the one change of an edit (Writer steps 4 to 6) over `set`, the
 * writer's fresh read. Settles with the record's new head, or null once it
 * is deleted; throws a conflict when another writer changed it first. */
export async function publishChange(
  io: Readonly<{ send: RevisionSender; read: SnapshotRead }>,
  set: AttentionSet,
  change: Readonly<{ slug: string; value: AttentionValue | null }>,
): Promise<RelayHead | null> {
  const { slug, value } = change;
  const head = set.heads[slug];
  const d = head?.d ?? (await attentionD(set.channel, slug));
  const changed = () =>
    new AttentionError(
      "conflict",
      `${slug} changed since it was read; show it again`,
    );
  /** Sends once more when the first answer was lost, as long as the head
   * is still the one it revises; the head then tells what happened. */
  const send = async (event: Revision, prev: string | undefined) => {
    let sent = await io.send(event);
    for (
      let attempt = 0;
      sent.status === "uncertain" && attempt < 2;
      attempt++
    ) {
      const current = await readHead(io.read, set.channel, d).catch(
        () => undefined,
      );
      if (sent.id && current?.id === sent.id)
        return { status: "accepted" as const, id: sent.id };
      if (current?.id !== prev && !(prev === undefined && !current))
        throw changed();
      sent = await io.send(event);
    }
    if (sent.status === "accepted") return sent;
    if (sent.status === "uncertain")
      throw new Error(
        `${slug} may not have been saved; show it again. ${sent.message}`,
      );
    return sent;
  };
  if (value === null) {
    if (!head) return null;
    const sent = await send(
      revision({ channel: set.channel, d, slug, op: "delete", prev: head.id }),
      head.id,
    );
    if (sent.status === "accepted") return null;
    if (sent.refusal === "conflict") throw changed();
    throw new Error(`${slug} was not removed: ${sent.message}`);
  }
  if (head) {
    const sent = await send(
      revision({
        channel: set.channel,
        d,
        slug,
        op: "update",
        prev: head.id,
        value,
      }),
      head.id,
    );
    if (sent.status === "accepted") return { id: sent.id, d };
    if (sent.refusal === "conflict") throw changed();
    throw new Error(`${slug} was not saved: ${sent.message}`);
  }
  // An added object: the ensure flow.
  if (set.count >= HEAD_LIMIT)
    throw new AttentionError(
      "invalid",
      `The attention channel already holds ${HEAD_LIMIT} records; remove some first`,
    );
  const created = await send(
    revision({ channel: set.channel, d, slug, op: "create", value }),
    undefined,
  );
  if (created.status === "accepted") return { id: created.id, d };
  if (created.refusal !== "conflict" && created.refusal !== "duplicate")
    throw new Error(`${slug} was not saved: ${created.message}`);
  const current = await readHead(io.read, set.channel, d);
  if (!current)
    throw new AttentionError(
      "invalid-operation",
      `${slug} was retired on the relay; choose another ID`,
    );
  if (tag(current, "op") === "delete") {
    const restored = await send(
      revision({
        channel: set.channel,
        d,
        slug,
        op: "restore",
        prev: current.id,
        value,
      }),
      current.id,
    );
    if (restored.status === "accepted") return { id: restored.id, d };
    if (restored.refusal === "conflict") throw changed();
    throw new Error(`${slug} was not saved: ${restored.message}`);
  }
  const found = (await attentionSet(set.channel, [current])).attention[slug];
  if (found && sameValue(found.value, value)) return { id: current.id, d };
  throw new AttentionError("conflict", `${slug} already exists; show it again`);
}

/** The agent's reads and writes as itself, which its attention channel's
 * find and create steps use. */
export type AgentChannelIO = Readonly<{
  agent: string;
  /** The agent's owner, who joins the channel it creates; absent for none. */
  owner?: string | undefined;
  relayAuthor: string;
  query(filters: readonly object[]): Promise<readonly RelayEvent[]>;
  publish(
    event: Readonly<{ kind: number; content: string; tags: string[][] }>,
  ): Promise<unknown>;
}>;

/** The agent's attention channels, oldest first (Find): system channels it
 * created with the label, as the relay describes them. */
export async function findChannels(io: AgentChannelIO) {
  const events = await io.query([
    { kinds: [39000], "#P": [io.agent], "#t": [ATTENTION_LABEL] },
  ]);
  const found = new Map<
    string,
    { id: string; createdAt?: number | undefined }
  >();
  for (const event of events) {
    const id = tag(event, "d");
    const identity = channelIdentity(event);
    if (
      event.kind === 39000 &&
      event.pubkey === io.relayAuthor &&
      id &&
      identity.type === "system" &&
      identity.creator === io.agent &&
      identity.labels.includes(ATTENTION_LABEL) &&
      !found.has(id)
    )
      found.set(id, { id, createdAt: identity.createdAt });
  }
  return [...found.values()].sort(compareChannelAge).map(({ id }) => id);
}

/** The agent's attention channel, created when there is none (Create): the
 * agent creates it and adds its owner with the `owner` role. A channel with
 * only the agent in it is one whose create did not finish, so its owner is
 * added then too; otherwise the roster is the channel owners' to change.
 * Newer duplicates from a race are deleted. */
export async function ensureChannel(io: AgentChannelIO): Promise<string> {
  const owner = io.owner && io.owner !== io.agent ? io.owner : undefined;
  const addOwner = (channel: string) =>
    owner &&
    io.publish({
      kind: 9000,
      content: "",
      tags: [
        ["h", channel],
        ["p", owner],
        ["role", "owner"],
      ],
    });
  const [found, ...extra] = await findChannels(io);
  for (const id of extra)
    await io
      .publish({ kind: 9008, content: "", tags: [["h", id]] })
      .catch((error) =>
        console.warn("Extra attention channel was not deleted", error),
      );
  if (!found) {
    const channel = crypto.randomUUID();
    await io.publish({
      kind: 9007,
      content: "",
      tags: [
        ["h", channel],
        ["name", "Attention"],
        ["visibility", "private"],
        ["channel_type", "system"],
        ...channelLabelTags([ATTENTION_LABEL]),
      ],
    });
    await addOwner(channel);
    return channel;
  }
  if (owner) {
    const events = await io.query([
      { kinds: [39000, 39001, 39002], "#d": [found] },
    ]);
    const { roles } = memberAuthority(events, found, io.agent, io.relayAuthor);
    if (!(owner in roles) && Object.keys(roles).join() === io.agent)
      await addOwner(found);
  }
  return found;
}

/** The sync filter for one attention channel (Reader step 2). */
export const syncFilter = (channel: string) => ({
  artifact: "current" as const,
  kinds: [ARTIFACT_KIND] as const,
  "#h": [channel],
  "#type": [ATTENTION_TYPE],
});

/** One complete set from a new sync, then closed (Writer step 1). Anything
 * but EOSE fails the read. */
export function readOnce(
  sync: (filter: unknown) => ArtifactSyncView,
  channel: string,
  timeoutMs = 15_000,
): Promise<AttentionSet> {
  return new Promise((resolve, reject) => {
    const view = sync(syncFilter(channel));
    let done = false;
    const finish = (result?: readonly RelayEvent[], error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stop();
      view.dispose();
      if (result) void attentionSet(channel, result).then(resolve, reject);
      else reject(new Error(`Attention could not be read: ${error}`));
    };
    const check = (snapshot: ArtifactSyncSnapshot) => {
      if (snapshot.status === "live") finish(snapshot.events);
      else if (snapshot.status !== "loading")
        finish(undefined, snapshot.error ?? snapshot.status);
    };
    const timer = setTimeout(() => finish(undefined, "timed out"), timeoutMs);
    let stop = () => {};
    stop = view.subscribe(() => check(view.snapshot()));
    check(view.snapshot());
  });
}

/** One agent's attention on the relay while its community is live: its
 * channel, ensured as the agent, and the set its owner's session keeps
 * current (Reader steps 1, 2, 5 and 6). */
export type RelayAttention = Readonly<{
  /** The last complete set; undefined before the first. */
  current(): AttentionSet | undefined;
  /** Why there is no set, or why the last one may be old. */
  problem(): string | undefined;
  /** A fresh complete set, for a writer. */
  read(): Promise<AttentionSet>;
  dispose(): void;
}>;

export function relayAttention(input: {
  channel: AgentChannelIO;
  /** NIP-AR sync on the owner's session. */
  sync(filter: unknown): ArtifactSyncView;
  /** Each new complete set, and each set a live change makes. */
  changed(set: AttentionSet): void;
  /** Reports a problem, or that it cleared. */
  reported(): void;
  signal: AbortSignal;
  retryMs?: number;
}): RelayAttention {
  const { signal, retryMs = 30_000 } = input;
  let channel: Promise<string> | undefined;
  let set: AttentionSet | undefined;
  let problem: string | undefined;
  let view: ArtifactSyncView | undefined;
  let stopView = () => {};
  let retry: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  const report = (next: string | undefined) => {
    if (next === problem) return;
    problem = next;
    input.reported();
  };
  const close = () => {
    stopView();
    stopView = () => {};
    view?.dispose();
    view = undefined;
  };
  const ensured = () => {
    channel ??= ensureChannel(input.channel).catch((error) => {
      channel = undefined;
      throw error;
    });
    return channel;
  };
  /** From Find again, after `retryMs`. */
  const later = (reason: string, refind: boolean) => {
    close();
    report(reason);
    if (refind) channel = undefined;
    clearTimeout(retry);
    if (!signal.aborted) retry = setTimeout(start, retryMs);
  };
  async function start() {
    const run = ++generation;
    let id: string;
    try {
      id = await ensured();
    } catch (error) {
      if (run === generation)
        later(
          `Attention channel unavailable: ${String(error instanceof Error ? error.message : error)}`,
          true,
        );
      return;
    }
    if (run !== generation || signal.aborted) return;
    close();
    let opened: ArtifactSyncView;
    try {
      opened = input.sync(syncFilter(id));
    } catch (error) {
      later(
        `Attention can't sync: ${String(error instanceof Error ? error.message : error)}`,
        false,
      );
      return;
    }
    view = opened;
    let applied = Promise.resolve();
    const seen = () => {
      const snapshot = opened.snapshot();
      if (snapshot.status === "live") {
        const events = snapshot.events;
        applied = applied.then(async () => {
          const next = await attentionSet(id, events);
          if (run !== generation || view !== opened) return;
          set = next;
          report(undefined);
          input.changed(next);
        });
      } else if (snapshot.status === "stale")
        report("Attention may be out of date; reconnecting");
      else if (snapshot.status === "restricted")
        later("The attention channel can't be read; finding it again", true);
      else if (snapshot.status === "unsupported" || snapshot.status === "error")
        later(
          `Attention can't sync: ${snapshot.error ?? snapshot.status}`,
          false,
        );
    };
    stopView = opened.subscribe(seen);
    seen();
  }
  signal.addEventListener(
    "abort",
    () => {
      generation++;
      clearTimeout(retry);
      close();
    },
    { once: true },
  );
  void start();
  return {
    current: () => set,
    problem: () => problem,
    read: async () => readOnce(input.sync, await ensured()),
    dispose() {
      generation++;
      clearTimeout(retry);
      close();
    },
  };
}
