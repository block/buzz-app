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
/** One record's current revision, and its tags outside the envelope (client
 * tags and `root`), which an edit over it keeps (NIP-AR Client behavior). */
export type RelayHead = Readonly<{
  id: string;
  d: string;
  tags?: readonly (readonly string[])[];
}>;
/** Tags each revision sets itself: NIP-AR's envelope, and the signer's own
 * NIP-OA `auth` and `ms`, which the relay checks against that signer. */
const ENVELOPE = new Set([
  "ar",
  "d",
  "h",
  "type",
  "title",
  "op",
  "prev",
  "auth",
  "ms",
]);
const annotations = (event: Pick<RelayEvent, "tags">) =>
  event.tags.filter(([name]) => name === undefined || !ENVELOPE.has(name));
const headOf = (event: Pick<RelayEvent, "id" | "tags">, d: string) => {
  const tags = annotations(event);
  return tags.length ? { id: event.id, d, tags } : { id: event.id, d };
};
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
    const named = typeof fields?.slug === "string" ? fields.slug : undefined;
    // The slug is trusted only when `d` derives from it; a record that names
    // another slug is kept under its own `d`, so it can't hide that slug.
    const slug =
      named && (await attentionD(channel, named)) === d ? named : undefined;
    const problem =
      tag(event, "ar") !== "1"
        ? "Unsupported artifact envelope"
        : !fields
          ? "Record content is not a JSON object"
          : !slug
            ? "Record identity does not match its slug"
            : fields.schema !== ATTENTION_SCHEMA
              ? `Unknown schema ${String(fields.schema)}`
              : Object.keys(fields).sort().join() !== "schema,slug,value"
                ? "Record content has other fields than schema, slug and value"
                : encoder.encode(event.content).length > CONTENT_BYTES
                  ? "Record content is too large"
                  : validateObject(slug, fields.value);
    const key = slug ?? `invalid/${d}`;
    if (key in heads) continue;
    heads[key] = headOf(event, d);
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

export type AttentionEdit = Readonly<{
  slug: string;
  value: AttentionValue | null;
}>;

/** The objects an edit changes, from `before` to `after`, one revision each
 * (Writer step 3), in an order that never leaves a watch without its
 * Interest: removed watches, then Interests, then watches, then removed
 * Interests. A skipped record's removal counts. */
export function attentionChanges(
  before: AgentRecord,
  after: AgentRecord,
): readonly AttentionEdit[] {
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
  const rank = ({ slug, value }: AttentionEdit) => {
    const interest = slug.startsWith("interest/");
    if (value === null) return interest ? 3 : 0;
    return interest ? 1 : 2;
  };
  return [...changed]
    .sort()
    .map((slug) => ({ slug, value: after.attention[slug]?.value ?? null }))
    .sort((a, b) => rank(a) - rank(b));
}

/** What a write replaced, by slug: the head it revised, or undefined for a
 * create. */
export type Replaced = ReadonlyMap<string, string | undefined>;
/** What several writes replaced, by slug. */
export type Written = ReadonlyMap<string, readonly (string | undefined)[]>;

/** `written` with `replaced` added. */
export const addWritten = (
  written: Written | undefined,
  replaced: Replaced,
) => {
  const next = new Map(written);
  for (const [slug, head] of replaced)
    next.set(slug, [...(next.get(slug) ?? []), head]);
  return next;
};

/** Publishes `changes` over `set`, the writer's fresh read, one revision at a
 * time (Writer steps 4 to 6). Stops at the first that fails; those before it
 * stay published. Returns the heads each replaced. */
export async function publishChanges(
  io: Readonly<{ send: RevisionSender; read: SnapshotRead }>,
  set: AttentionSet,
  changes: readonly AttentionEdit[],
): Promise<Replaced> {
  const replaced = new Map<string, string | undefined>();
  let current = set;
  for (const change of changes) {
    const prior = current.heads[change.slug];
    const head = await publishChange(io, current, change);
    replaced.set(change.slug, prior?.id);
    const { [change.slug]: _, ...heads } = current.heads;
    current = {
      ...current,
      heads: head ? { ...heads, [change.slug]: head } : heads,
      count: current.count + (head && !prior ? 1 : 0),
    };
  }
  return replaced;
}

/** `set` with the objects of `record` this device wrote kept, while `set`
 * still holds a head those writes replaced: a set made before a write
 * landed must not undo it. Returns the slugs whose writes `set` shows. */
export function pendingSet(
  set: AttentionSet,
  record: AgentRecord,
  written: Written,
): Readonly<{ set: AttentionSet; settled: readonly string[] }> {
  const settled: string[] = [];
  let attention = set.attention;
  let skipped = set.skipped;
  for (const [slug, heads] of written) {
    if (!heads.includes(set.heads[slug]?.id)) {
      settled.push(slug);
      continue;
    }
    const { [slug]: _a, ...otherAttention } = attention;
    const { [slug]: _s, ...otherSkipped } = skipped;
    const object = record.attention[slug];
    const skip = record.skipped?.[slug];
    attention = object ? { ...otherAttention, [slug]: object } : otherAttention;
    skipped = skip ? { ...otherSkipped, [slug]: skip } : otherSkipped;
  }
  return { set: { ...set, attention, skipped }, settled };
}

/** The revision to sign: a complete snapshot, or a deletion. A snapshot
 * keeps `tags`, the annotations of the head it revises; a deletion keeps
 * only their `root` (NIP-AR Deletion). */
export function revision(input: {
  channel: string;
  d: string;
  slug: string;
  op: "create" | "update" | "restore" | "delete";
  prev?: string | undefined;
  value?: AttentionValue | undefined;
  tags?: readonly (readonly string[])[] | undefined;
}) {
  const { channel, d, slug, op, prev, value, tags = [] } = input;
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
      ...tags
        .filter(([name]) => op !== "delete" || name === "root")
        .map((tag) => [...tag]),
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
      const current = await readHead(io.read, set.channel, d).catch(() => null);
      // An unread head tells nothing: no conflict, and no second send.
      if (current === null) break;
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
      revision({
        channel: set.channel,
        d,
        slug,
        op: "delete",
        prev: head.id,
        tags: head.tags,
      }),
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
        tags: head.tags,
      }),
      head.id,
    );
    if (sent.status === "accepted") return { ...head, id: sent.id };
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
    const deleted = headOf(current, d);
    const restored = await send(
      revision({
        channel: set.channel,
        d,
        slug,
        op: "restore",
        prev: current.id,
        value,
        tags: deleted.tags,
      }),
      current.id,
    );
    if (restored.status === "accepted") return { ...deleted, id: restored.id };
    if (restored.refusal === "conflict") throw changed();
    throw new Error(`${slug} was not saved: ${restored.message}`);
  }
  const found = (await attentionSet(set.channel, [current])).attention[slug];
  if (found && sameValue(found.value, value)) return headOf(current, d);
  throw new AttentionError("conflict", `${slug} already exists; show it again`);
}

/** How a relay set differs from `attention`: objects missing or different
 * there, objects only there, and records it skipped. */
export function compared(
  attention: AgentRecord["attention"],
  set: AttentionSet,
): AttentionMigration {
  const sorted = (slugs: Iterable<string>) => [...slugs].sort();
  const different = sorted(
    Object.values(attention)
      .filter(
        ({ slug, value }) =>
          !set.attention[slug] || !sameValue(set.attention[slug].value, value),
      )
      .map(({ slug }) => slug),
  );
  const extra = sorted(
    Object.keys(set.attention).filter((slug) => !attention[slug]),
  );
  return {
    migrated: false,
    different,
    extra,
    skipped: sorted(Object.keys(set.skipped)),
    heads: Object.fromEntries(
      Object.keys(set.skipped)
        .concat(extra)
        .flatMap((slug) => {
          const id = set.heads[slug]?.id;
          return id ? [[slug, id]] : [];
        }),
    ),
    names: Object.fromEntries(
      [...different, ...extra].flatMap((slug) => {
        const object = attention[slug] ?? set.attention[slug];
        return object ? [[slug, nameOf(slug, object.value)]] : [];
      }),
    ),
  };
}

/** What the owner calls an object: an Interest's title or first heading, a
 * watch's name, else its id. */
function nameOf(slug: string, value: AttentionValue) {
  const id = slug.slice(slug.indexOf("/") + 1);
  if (value.type !== "interest") return ("name" in value && value.name) || id;
  const first = value.instructions.split("\n").find((line) => line.trim());
  const heading = first && /^#+\s+(.+)$/.exec(first.trim())?.[1]?.trim();
  return value.title || heading || id;
}

/** What moving an agent's attention to the relay found. It moved only when
 * the relay set came back the same as the record. */
export type AttentionMigration = Readonly<{
  migrated: boolean;
  /** Objects the relay is missing or holds another value of. */
  different: readonly string[];
  /** Objects only the relay holds. They stay, unless the move prunes them. */
  extra: readonly string[];
  /** Records skipped, here or on the relay; they are not moved. */
  skipped: readonly string[];
  /** The relay head of each object in `extra` and `skipped`, by slug: what
   * the owner confirms deleting when a move prunes. */
  heads: Readonly<Record<string, string>>;
  /** What the owner calls each object in `different` and `extra`, by slug:
   * its title or name, else its id. */
  names: Readonly<Record<string, string>>;
}>;

/** Publishes each object of `attention` the relay does not already hold
 * (Rollout 3), never over a record it skipped unless the owner confirmed
 * pruning that head, then reads the set back and compares it. It also deletes
 * each object in `prune` (slug to the head the owner saw) that the relay
 * still holds at that head, only there or skipped (Rollback: "deletes them
 * only when asked"). One added or changed since the owner saw it stays, and
 * the move is refused again. Removed watches go first, then Interests,
 * then watches, then removed Interests, so no watch is left without its
 * Interest. */
export async function publishAll(
  io: Readonly<{ send: RevisionSender; read: SnapshotRead }>,
  read: () => Promise<AttentionSet>,
  attention: AgentRecord["attention"],
  options: Readonly<{
    prune?: Readonly<Record<string, string>>;
    /** Publish only objects the relay does not hold, so the relay's own
     * versions stay. */
    missingOnly?: boolean;
  }> = {},
): Promise<Readonly<{ set: AttentionSet; found: AttentionMigration }>> {
  let before = await read();
  // A record it can't read under a slug this device holds, whose head the
  // owner confirmed pruning: delete that head first (a changed one is
  // refused), so the add below restores this device's value over it.
  // Between the two, a community watch that names a replaced Interest has
  // none; if the restore fails, until the move is retried. Runtimes using
  // this reader already treat that record as missing; a client that reads
  // its newer form does not.
  const replaced = Object.keys(attention)
    .filter((slug) => {
      const confirmed = options.prune?.[slug];
      return (
        !!before.skipped[slug] &&
        confirmed !== undefined &&
        before.heads[slug]?.id === confirmed
      );
    })
    // Removed watches go before removed Interests, as below.
    .sort((a, b) => {
      const ia = a.startsWith("interest/");
      return ia !== b.startsWith("interest/") ? (ia ? 1 : -1) : a < b ? -1 : 1;
    });
  if (replaced.length) {
    await publishChanges(
      io,
      before,
      replaced.map((slug) => ({ slug, value: null })),
    );
    before = await read();
  }
  const rank = ({ slug, value }: AttentionEdit) => {
    const interest = slug.startsWith("interest/");
    return value === null ? (interest ? 3 : 0) : interest ? 1 : 2;
  };
  const changes: AttentionEdit[] = [
    ...Object.values(attention)
      .filter(({ slug, value }) => {
        const there = before.attention[slug];
        // Never over a record it can't read: the move is refused with it
        // listed, and only a prune the owner confirms replaces it (above).
        if (before.skipped[slug]) return false;
        if (options.missingOnly) return !there;
        return !there || !sameValue(there.value, value);
      })
      .map(({ slug, value }) => ({ slug, value })),
    // A record the relay skipped can be pruned too, by its key there.
    ...Object.entries(options.prune ?? {})
      .filter(
        ([slug, head]) =>
          before.heads[slug]?.id === head &&
          (before.attention[slug] || before.skipped[slug]) &&
          !attention[slug],
      )
      .map(([slug]) => ({ slug, value: null })),
  ];
  changes.sort((a, b) =>
    rank(a) !== rank(b) ? rank(a) - rank(b) : a.slug < b.slug ? -1 : 1,
  );
  await publishChanges(io, before, changes);
  const set = await read();
  return { set, found: compared(attention, set) };
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
  /** The oldest channel found, after deleting the others. */
  const oldest = async () => {
    const [found, ...extra] = await findChannels(io);
    for (const id of extra)
      await io
        .publish({ kind: 9008, content: "", tags: [["h", id]] })
        .catch((error) =>
          console.warn("Extra attention channel was not deleted", error),
        );
    return found;
  };
  const found = await oldest();
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
    // Another process of the agent may have created one too: all use the
    // oldest, and this one deletes the newer.
    return (await oldest()) ?? channel;
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
  /** The relay advertises NIP-AR sync; without it no channel is created. */
  artifactSync: boolean;
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
  // Relay support: a channel is created only where its set can be read.
  const unsupported = input.artifactSync
    ? undefined
    : "This community can't store attention";
  let problem = unsupported;
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
    if (unsupported) return Promise.reject(new Error(unsupported));
    channel ??= ensureChannel(input.channel).catch((error) => {
      channel = undefined;
      throw error;
    });
    return channel;
  };
  let resyncs = 0;
  /** From Find again, after `delay`. */
  const later = (reason: string, refind: boolean, delay = retryMs) => {
    close();
    report(reason);
    if (refind) channel = undefined;
    clearTimeout(retry);
    // Equal jitter: never sooner than half the delay.
    if (!signal.aborted)
      retry = setTimeout(start, delay * (0.5 + Math.random() / 2));
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
          resyncs = 0;
          report(undefined);
          input.changed(next);
        });
      } else if (snapshot.error?.startsWith("resync:"))
        // A lost change: from Find again (Reader step 6), soon, backing off
        // when it repeats. The last good set stays meanwhile.
        later(
          "Attention may be out of date; reading it again",
          true,
          Math.min(retryMs, 1000 * 2 ** resyncs++),
        );
      else if (snapshot.status === "stale")
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
  if (!unsupported) void start();
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
