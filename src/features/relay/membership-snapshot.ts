import { readApiFailure, type createApiAdmission } from "./http-admission.ts";
import { eventDto, type RelayEvent } from "./events.ts";
import { ReadError } from "./errors.ts";
import { record } from "./read-state-model.ts";

export const MEMBERSHIP_TYPES = [
  "dm",
  "forum",
  "stream",
  "system",
  "workflow",
] as const;
export const MEMBERSHIP_CHANNELS = 4096;
export const MEMBERSHIP_BYTES = 2 * 1024 * 1024;
const key = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const roles = ["owner", "admin", "member", "guest", "bot"] as const;

export type ViewerMembership = Readonly<{
  id: string;
  role: (typeof roles)[number];
  channel_type: (typeof MEMBERSHIP_TYPES)[number];
  visibility: "open" | "private";
  archived: boolean;
}>;
export type MembershipCapability = Readonly<{
  version: 1;
  community_id: string;
  pubkey: string;
  kind: 39008;
  max_channels: number;
  max_response_bytes: number;
}>;
export type MembershipSnapshot = Readonly<{
  event: RelayEvent;
  channels: readonly ViewerMembership[];
  types: readonly string[];
  snapshotId: string;
}>;

/** Explicit lack of support starts another authority generation, never an empty list. */
export class MembershipUnsupported extends Error {
  constructor() {
    super("Compact membership unsupported for this generation");
  }
}
const invalid = () =>
  new ReadError("invalid-response", "Untrusted compact membership snapshot");
const exact = (value: Record<string, unknown>, names: readonly string[]) =>
  Object.keys(value).sort().join(",") === [...names].sort().join(",");

/** Only an absent or explicitly newer descriptor is unsupported. Malformed v1 is an error. */
export function membershipCapability(
  raw: unknown,
  relay: string,
): MembershipCapability | undefined {
  if (raw === undefined) return;
  if (
    record(raw) &&
    Number.isSafeInteger(raw.version) &&
    Number(raw.version) > 1
  )
    return;
  if (
    !record(raw) ||
    raw.version !== 1 ||
    raw.kind !== 39008 ||
    typeof raw.community_id !== "string" ||
    !uuid.test(raw.community_id) ||
    raw.pubkey !== relay ||
    !key.test(relay) ||
    !Number.isSafeInteger(raw.max_channels) ||
    Number(raw.max_channels) < 1 ||
    Number(raw.max_channels) > MEMBERSHIP_CHANNELS ||
    !Number.isSafeInteger(raw.max_response_bytes) ||
    Number(raw.max_response_bytes) < 1 ||
    Number(raw.max_response_bytes) > MEMBERSHIP_BYTES
  )
    throw invalid();
  return Object.freeze({
    version: 1,
    community_id: raw.community_id,
    pubkey: relay,
    kind: 39008,
    max_channels: Number(raw.max_channels),
    max_response_bytes: Number(raw.max_response_bytes),
  });
}

export const membershipFilter = (
  viewer: string,
  types: readonly string[] = MEMBERSHIP_TYPES,
) => [
  { kinds: [39008], "#p": [viewer], "#t": [...types], membership_snapshot: 1 },
];

/** Exact disabled response only. Authentication, other 404s and outages never select legacy. */
export function membershipDisabled(status: number, raw: unknown): boolean {
  return (
    status === 404 &&
    record(raw) &&
    exact(raw, ["error"]) &&
    raw.error === "membership_snapshot unsupported"
  );
}

export async function membershipIdentity(
  community: string,
  viewer: string,
  types: readonly string[],
  channels: readonly ViewerMembership[],
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      "nip-cl-membership-state-v1",
      community,
      viewer,
      types,
      channels,
    ]),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The caller supplies one outstanding host attempt; cached signatures alone are never fresh. */
export async function parseMembershipSnapshot(
  raw: unknown,
  binding: {
    origin: string;
    viewer: string;
    requestId: string;
    capability: MembershipCapability;
    types?: readonly string[];
  },
  signal?: AbortSignal,
): Promise<MembershipSnapshot> {
  signal?.throwIfAborted();
  if (Array.isArray(raw)) throw new MembershipUnsupported();
  const { origin, viewer, requestId, capability } = binding;
  const types = binding.types ?? MEMBERSHIP_TYPES;
  const url = new URL(origin);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol) ||
    !key.test(viewer) ||
    !key.test(requestId) ||
    !types.length ||
    types.some(
      (type, i) =>
        !MEMBERSHIP_TYPES.includes(type as (typeof MEMBERSHIP_TYPES)[number]) ||
        (i > 0 && type <= (types[i - 1] ?? "")),
    ) ||
    !record(raw) ||
    !exact(raw, ["membership_snapshot", "event"]) ||
    raw.membership_snapshot !== 1 ||
    new TextEncoder().encode(JSON.stringify(raw)).byteLength >
      capability.max_response_bytes
  )
    throw invalid();
  const event = eventDto(raw.event);
  if (
    event.kind !== 39008 ||
    event.pubkey !== capability.pubkey ||
    event.tags.length !== 2 ||
    !event.tags.some(
      (tag) => tag.length === 2 && tag[0] === "d" && tag[1] === requestId,
    ) ||
    !event.tags.some(
      (tag) => tag.length === 2 && tag[0] === "p" && tag[1] === viewer,
    )
  )
    throw invalid();
  let content: unknown;
  try {
    content = JSON.parse(event.content);
  } catch {
    throw invalid();
  }
  if (
    !record(content) ||
    !exact(content, [
      "version",
      "community_id",
      "host",
      "viewer",
      "request_id",
      "types",
      "complete",
      "snapshot_id",
      "channels",
    ]) ||
    content.version !== 1 ||
    content.community_id !== capability.community_id ||
    content.host !== url.host ||
    content.viewer !== viewer ||
    content.request_id !== requestId ||
    content.complete !== true ||
    JSON.stringify(content.types) !== JSON.stringify(types) ||
    typeof content.snapshot_id !== "string" ||
    !key.test(content.snapshot_id) ||
    !Array.isArray(content.channels) ||
    content.channels.length > capability.max_channels
  )
    throw invalid();
  const channels: ViewerMembership[] = [];
  for (const item of content.channels) {
    if (
      !record(item) ||
      !exact(item, ["id", "role", "channel_type", "visibility", "archived"]) ||
      typeof item.id !== "string" ||
      !uuid.test(item.id) ||
      item.id <= (channels.at(-1)?.id ?? "") ||
      !roles.includes(item.role as (typeof roles)[number]) ||
      !types.includes(item.channel_type as string) ||
      !["open", "private"].includes(item.visibility as string) ||
      typeof item.archived !== "boolean"
    )
      throw invalid();
    // Declaration order matches the relay's content-identity encoding, independent of JSON key order.
    channels.push(
      Object.freeze({
        id: item.id,
        role: item.role as ViewerMembership["role"],
        channel_type: item.channel_type as ViewerMembership["channel_type"],
        visibility: item.visibility as ViewerMembership["visibility"],
        archived: item.archived,
      }),
    );
  }
  if (
    (await membershipIdentity(
      capability.community_id,
      viewer,
      types,
      channels,
    )) !== content.snapshot_id
  )
    throw invalid();
  signal?.throwIfAborted();
  return Object.freeze({
    event,
    channels: Object.freeze(channels),
    types: Object.freeze([...types]),
    snapshotId: content.snapshot_id,
  });
}

/** Bound the whole UTF-8 envelope before parsing it, including at the host boundary. */
export async function membershipText(
  response: Response,
  maxBytes = MEMBERSHIP_BYTES,
): Promise<string> {
  if (!response.body) throw invalid();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxBytes) throw invalid();
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** The host returns binding and body as one attempt-local result. */
export type MembershipHostResult = Readonly<{
  request_id: string;
  signer_pubkey: string;
  origin: string;
  status: number;
  body: string;
}>;

/** Each call starts a generation with fresh same-origin discovery. */
export async function readMembershipSnapshot(
  host: {
    origin: string;
    viewer: string;
    relay: string;
    info(signal: AbortSignal): Promise<unknown>;
    request(
      types: readonly string[],
      signal: AbortSignal,
    ): Promise<MembershipHostResult>;
  },
  types: readonly string[],
  signal: AbortSignal,
): Promise<MembershipSnapshot> {
  if (
    !types.length ||
    types.length > MEMBERSHIP_TYPES.length ||
    types.some(
      (type, index) =>
        !(MEMBERSHIP_TYPES as readonly string[]).includes(type) ||
        (index > 0 && (types[index - 1] ?? "") >= type),
    )
  )
    throw invalid();
  const discover = async () => {
    const info = await host.info(signal);
    signal.throwIfAborted();
    if (!record(info) || info.self !== host.relay) throw invalid();
    return membershipCapability(info.membership_snapshot, host.relay);
  };
  const capability = await discover();
  if (!capability) throw new MembershipUnsupported();
  const result = await host.request(types, signal);
  signal.throwIfAborted();
  if (result.status === 499)
    throw new DOMException("Relay read cancelled", "AbortError");
  if (
    result.origin !== new URL(host.origin).origin ||
    result.signer_pubkey !== host.viewer ||
    !key.test(result.request_id) ||
    typeof result.body !== "string" ||
    new TextEncoder().encode(result.body).byteLength >
      capability.max_response_bytes
  )
    throw invalid();
  let raw: unknown;
  try {
    raw = JSON.parse(result.body);
  } catch {
    throw invalid();
  }
  if (result.status === 404 || Array.isArray(raw)) {
    await discover();
    if (
      membershipDisabled(result.status, raw) ||
      (result.status === 200 && Array.isArray(raw))
    )
      throw new MembershipUnsupported();
  }
  if (result.status !== 200)
    throw new ReadError(
      "unavailable",
      `Membership request failed (${result.status})`,
      result.status,
    );
  return parseMembershipSnapshot(
    raw,
    {
      origin: host.origin,
      viewer: host.viewer,
      requestId: result.request_id,
      capability,
      types,
    },
    signal,
  );
}

/** Preserve only the protocol's exact disabled response through host admission. */
export async function admitMembershipSnapshot(
  lane: ReturnType<typeof createApiAdmission>,
  request: () => Promise<{
    response: Response;
    binding: Omit<MembershipHostResult, "status" | "body">;
  }>,
  signal: AbortSignal,
  priority: "foreground" | "background",
): Promise<MembershipHostResult> {
  return lane.run(
    async () => {
      const { response, binding } = await request();
      signal.throwIfAborted();
      if (response.ok)
        return {
          ...binding,
          status: response.status,
          body: await membershipText(response, MEMBERSHIP_BYTES),
        };
      const failure = await readApiFailure(response, (raw, status) =>
        membershipDisabled(status, raw)
          ? "membership_snapshot unsupported"
          : undefined,
      );
      if (failure.quota === "api" && failure.retryAfterMs !== undefined)
        lane.pause(failure.retryAfterMs);
      const status =
        (response.status === 401 || response.status === 403) && !failure.denied
          ? 502
          : response.status;
      // Keep exactly the disabled body; normalized failures cannot select fallback.
      return {
        ...binding,
        status,
        body: JSON.stringify({ error: failure.error }),
      };
    },
    signal,
    priority,
  );
}
