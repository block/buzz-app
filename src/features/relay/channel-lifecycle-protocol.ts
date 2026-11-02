import type { EventTemplate } from "nostr-tools";
import { newer, type RelayEvent } from "./events.ts";

export type ChannelLifecycleAction =
  | "archive"
  | "unarchive"
  | "delete"
  | "leave"
  | "hide";
/** Join is not a confirmed member action: it starts from a nonmember preview. */
export type ChannelLifecycleCommand = ChannelLifecycleAction | "join";
export const CHANNEL_LIFECYCLE_KINDS = [9002, 9008, 9021, 9022, 41012] as const;
export const DM_VISIBILITY_KIND = 30622;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PUBKEY = /^[0-9a-f]{64}$/;
const DIGEST = PUBKEY;

export function lifecycleChannelId(value: string): string {
  if (typeof value !== "string" || !UUID.test(value))
    throw new Error("Invalid channel ID");
  return value;
}

export function lifecycleTemplate(
  action: ChannelLifecycleCommand,
  channelId: string,
): EventTemplate {
  const kind = {
    archive: 9002,
    unarchive: 9002,
    delete: 9008,
    join: 9021,
    leave: 9022,
    hide: 41012,
  }[action];
  const event = {
    kind,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags: [
      ["h", lifecycleChannelId(channelId)],
      ...(action === "archive" || action === "unarchive"
        ? [["archived", action === "archive" ? "true" : "false"]]
        : []),
    ],
  };
  validateLifecycleTemplate(event);
  return event;
}

/**
 * A guarded task lifecycle request (relay `lifecycle_guard` v1). The host
 * builds every tag, so callers cannot add metadata. `state` archives a subtree
 * (`archived: true`) or restores (`archived: false`) when `expect` still
 * matches the relay's digest. `fence` only replaces the target's token when it
 * is still `expectTarget` (null: never set).
 */
export type GuardedLifecycleRequest =
  | Readonly<{
      kind: "state";
      channelId: string;
      archived: boolean;
      scope: "target" | "subtree";
      expect: string;
    }>
  | Readonly<{ kind: "fence"; channelId: string; expectTarget: string | null }>;

export function guardedLifecycleTemplate(
  request: GuardedLifecycleRequest,
): EventTemplate {
  const id = lifecycleChannelId(request.channelId);
  const event = {
    kind: 9002,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags:
      request.kind === "state"
        ? [
            ["h", id],
            ["archived", String(request.archived)],
            ["scope", request.scope],
            ["expect", request.expect],
          ]
        : [
            ["h", id],
            ["lifecycle", "fence"],
            ["expect-target", request.expectTarget ?? "-"],
          ],
  };
  validateLifecycleTemplate(event);
  return event;
}

/** Whether a valid lifecycle template is a guarded request rather than a plain archive. */
export const guardedLifecycleEvent = (event: EventTemplate) =>
  event.kind === 9002 && event.tags.length > 2;

/** The host never accepts generic metadata edits or other-member removal. */
export function validateLifecycleTemplate(event: EventTemplate): void {
  if (
    !event ||
    !CHANNEL_LIFECYCLE_KINDS.some((kind) => kind === event.kind) ||
    event.content !== "" ||
    !Number.isSafeInteger(event.created_at) ||
    event.created_at < 0 ||
    !Array.isArray(event.tags) ||
    !(event.kind === 9002
      ? [2, 3, 4].includes(event.tags.length)
      : event.tags.length === 1) ||
    event.tags[0]?.length !== 2 ||
    event.tags[0]?.[0] !== "h"
  )
    throw new Error("Invalid channel lifecycle command");
  lifecycleChannelId(event.tags[0]?.[1] ?? "");
  if (event.kind !== 9002) return;
  const value = (index: number, name: string) => {
    const tag = event.tags[index];
    return tag?.length === 2 && tag[0] === name ? tag[1] : undefined;
  };
  const archived = value(1, "archived");
  const scope = value(2, "scope");
  const target = value(2, "expect-target");
  if (
    !(event.tags.length === 2
      ? archived === "true" || archived === "false"
      : event.tags.length === 4
        ? (archived === "true"
            ? scope === "subtree"
            : archived === "false" &&
              (scope === "target" || scope === "subtree")) &&
          DIGEST.test(value(3, "expect") ?? "")
        : value(1, "lifecycle") === "fence" &&
          (target === "-" || UUID.test(target ?? "")))
  )
    throw new Error("Only archive metadata may be changed here");
}

/** The relay's guarded lifecycle capability. */
export type LifecycleGuard = Readonly<{ maxSubtreeChannels: number }>;
export const LIFECYCLE_STATE_PATH = "/buzz/v1/lifecycle/state";
/** The state route's fixed batch limit; the route works without the capability. */
const MAX_STATE_CHANNELS = 1000;

/** NIP-11 `lifecycle_guard` v1; anything else means new guarded requests are unsupported. */
export function lifecycleGuard(info: unknown): LifecycleGuard | undefined {
  const guard = (info as { lifecycle_guard?: unknown } | null)
    ?.lifecycle_guard as Record<string, unknown> | null | undefined;
  const subtree = guard?.max_subtree_channels;
  return guard?.version === 1 &&
    guard.state_path === LIFECYCLE_STATE_PATH &&
    Number.isSafeInteger(subtree) &&
    (subtree as number) > 0
    ? Object.freeze({ maxSubtreeChannels: subtree as number })
    : undefined;
}

/** One channel's current lifecycle state from the relay's state route. */
export type ChannelLifecycleState = Readonly<{
  id: string;
  /** Unix seconds; null while active. */
  archivedAt: number | null;
  deleted: boolean;
  /** Null until the first guarded change. */
  token: string | null;
}>;

/** Request batches for the state route: unique canonical ids, at most 1000 each. */
export function lifecycleStateBatches(ids: readonly string[]) {
  const unique = [...new Set(ids.map(lifecycleChannelId))];
  if (!unique.length) throw new Error("Invalid channel ID");
  const batches: string[][] = [];
  for (let start = 0; start < unique.length; start += MAX_STATE_CHANNELS)
    batches.push(unique.slice(start, start + MAX_STATE_CHANNELS));
  return batches;
}

/** Validates one state response. An omitted id is unknown, never gone. */
export function lifecycleStates(
  body: unknown,
  requested: readonly string[],
): ChannelLifecycleState[] {
  const channels = (body as { channels?: unknown } | null)?.channels;
  if (!Array.isArray(channels))
    throw new Error("Invalid channel lifecycle state");
  const pending = new Set(requested);
  return channels.map((entry: unknown) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const { id, archived_at: archivedAt, deleted } = row;
    const token = row.lifecycle_token;
    if (
      typeof id !== "string" ||
      !pending.delete(id) ||
      !(
        archivedAt === null ||
        (Number.isSafeInteger(archivedAt) && (archivedAt as number) >= 0)
      ) ||
      typeof deleted !== "boolean" ||
      !(token === null || (typeof token === "string" && UUID.test(token)))
    )
      throw new Error("Invalid channel lifecycle state");
    return Object.freeze({
      id,
      archivedAt: archivedAt as number | null,
      deleted,
      token: token as string | null,
    });
  });
}

export function exactLifecycleTag(event: RelayEvent, name: string) {
  const matches = event.tags.filter(([key]) => key === name);
  if (matches.length > 1 || matches.some((entry) => entry.length !== 2))
    throw new Error(`Malformed channel ${name} state`);
  return matches[0]?.[1];
}

/**
 * The channel type of relay-signed channel state. NIP-CL puts the type in
 * the first `t` tag; later `t` tags are channel labels, not a second type.
 */
export function channelTypeTag(event: RelayEvent) {
  const first = event.tags.find(([key]) => key === "t");
  if (first && first.length !== 2) throw new Error("Malformed channel t state");
  return first?.[1];
}

export function lifecycleRecord(
  events: readonly RelayEvent[],
  kind: number,
  id: string,
  relayAuthor: string,
) {
  let selected: RelayEvent | undefined;
  for (const event of events) {
    if (event.kind !== kind) continue;
    if (event.pubkey !== relayAuthor || exactLifecycleTag(event, "d") !== id)
      throw new Error("Channel state did not match the requested authority");
    selected = newer(selected, event);
  }
  return selected;
}

export type ChannelLifecycleSettings = Readonly<{
  channelId: string;
  channelType: "stream" | "forum" | "dm" | "system";
  canArchive: boolean;
  canUnarchive: boolean;
  canDelete: boolean;
  deleteUnavailable?: boolean;
  canLeave: boolean;
  canHide: boolean;
  leaveReason?: string;
}>;

export function lifecycleSettings(
  events: readonly RelayEvent[],
  id: string,
  viewer: string,
  relayAuthor: string,
): ChannelLifecycleSettings {
  const metadata = lifecycleRecord(events, 39000, id, relayAuthor);
  const admins = lifecycleRecord(events, 39001, id, relayAuthor);
  const roster = lifecycleRecord(events, 39002, id, relayAuthor);
  if (!metadata || !admins || !roster)
    throw new Error("Current channel permissions could not be verified");
  const type = channelTypeTag(metadata);
  if (
    type !== "stream" &&
    type !== "forum" &&
    type !== "dm" &&
    type !== "system"
  )
    throw new Error("Current channel type could not be verified");
  const members = new Set<string>();
  for (const entry of roster.tags.filter(([key]) => key === "p")) {
    const member = entry[1];
    if (
      // NIP-29 membership permits ["p", key, relay_hint?, role?].
      // These hints do not grant authority; roles come from the 39001 record.
      entry.length < 2 ||
      entry.length > 4 ||
      !member ||
      !PUBKEY.test(member) ||
      members.has(member)
    )
      throw new Error("Malformed channel membership state");
    members.add(member);
  }
  const roles = new Map<string, string>();
  for (const entry of admins.tags.filter(([key]) => key === "p")) {
    const [, pubkey, role] = entry;
    if (
      entry.length !== 3 ||
      !pubkey ||
      !PUBKEY.test(pubkey) ||
      (role !== "owner" && role !== "admin") ||
      roles.has(pubkey) ||
      !members.has(pubkey)
    )
      throw new Error("Malformed channel administrator state");
    roles.set(pubkey, role);
  }
  if (!members.has(viewer))
    throw new Error("You are no longer a channel member");
  const role = roles.get(viewer);
  const lastOwner =
    role === "owner" &&
    [...roles.values()].filter((value) => value === "owner").length === 1;
  const archived = exactLifecycleTag(metadata, "archived");
  if (archived !== undefined && archived !== "true" && archived !== "false")
    throw new Error("Malformed channel archive state");
  return Object.freeze({
    channelId: id,
    channelType: type,
    canArchive:
      type !== "dm" &&
      archived !== "true" &&
      (role === "owner" || role === "admin"),
    canUnarchive:
      type !== "dm" &&
      archived === "true" &&
      (role === "owner" || role === "admin"),
    canDelete: type !== "dm" && archived !== "true" && role === "owner",
    canLeave: type !== "dm" && !lastOwner,
    canHide: type === "dm",
    ...(lastOwner && type !== "dm"
      ? { leaveReason: "Transfer ownership before leaving the channel." }
      : {}),
  });
}
