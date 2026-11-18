import type { EventTemplate } from "nostr-tools";

/** SET_ARTIFACT_TYPE_POLICY: an owner or admin sets who may write one type. */
export const ARTIFACT_TYPE_POLICY_KIND = 9034;
export type ArtifactTypePolicyValue = "everyone" | "admins";
/** `revision` is the id of the type's current 9034 command, or null when the
 * type was never set. */
export type ArtifactTypePolicyState = Readonly<{
  policy: ArtifactTypePolicyValue;
  revision: string | null;
}>;
/** What the host offers a plugin for a community's per-type write policy. */
export type ArtifactTypePolicyAccess = Readonly<{
  read(type: string, signal: AbortSignal): Promise<ArtifactTypePolicyState>;
  /** Signs (filling community and created_at) and publishes once. Resolves
   * with the command id and the relay's answer; a transport failure resolves
   * ok:false with an empty message. Rejects only on a malformed change, a
   * signing failure or an aborted signal. */
  set(
    change: Readonly<{
      type: string;
      policy: ArtifactTypePolicyValue;
      prev: string;
    }>,
    signal: AbortSignal,
  ): Promise<Readonly<{ id: string; ok: boolean; message: string }>>;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVENT_ID = /^[0-9a-f]{64}$/;

export const artifactCommunityId = (value: unknown): value is string =>
  typeof value === "string" &&
  UUID.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000";

/** The relay's type grammar (buzz-core artifact.rs): at most 128 bytes, two or
 * more dot-separated segments of `[a-z][a-z0-9_-]*`. */
export const artifactTypeName = (type: string): boolean =>
  type.length <= 128 && /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/.test(type);

/** The community from NIP-11 `artifacts.community_scope` version 1, only when
 * `supported_extensions` lists `nip-ar`. */
export function communityScope(
  artifacts: unknown,
  nipAr: boolean,
): string | undefined {
  const scope = (
    artifacts as {
      community_scope?: { version?: unknown; community_id?: unknown };
    } | null
  )?.community_scope;
  return nipAr &&
    scope?.version === 1 &&
    artifactCommunityId(scope.community_id)
    ? scope.community_id
    : undefined;
}

/** The 9034 command the host signs. `now` is Unix seconds. Throws on a
 * malformed community, type, policy or `prev` before anything is signed. */
export function typePolicyTemplate(
  community: string,
  type: string,
  policy: ArtifactTypePolicyValue,
  prev: string,
  now: number,
): EventTemplate {
  const event = {
    kind: ARTIFACT_TYPE_POLICY_KIND,
    created_at: now,
    content: "",
    tags: [
      ["community", community],
      ["type", type],
      ["policy", policy],
      ["prev", prev],
    ],
  };
  validTypePolicy(event, community);
  return event;
}

const tagValue = (tag: unknown, name: string): string | undefined =>
  Array.isArray(tag) &&
  tag.length === 2 &&
  tag[0] === name &&
  typeof tag[1] === "string"
    ? tag[1]
    : undefined;

/** Hosts sign only this exact shape: empty content and the four two-element
 * tags in order, for `community`. `prev` is "0" or a lowercase event id. */
export function validTypePolicy(event: EventTemplate, community: string): void {
  const [scope, type, policy, prev, ...extra] = Array.isArray(event?.tags)
    ? event.tags
    : [];
  const name = tagValue(type, "type");
  const expected = tagValue(prev, "prev");
  if (
    !event ||
    event.kind !== ARTIFACT_TYPE_POLICY_KIND ||
    event.content !== "" ||
    !Number.isSafeInteger(event.created_at) ||
    event.created_at < 0 ||
    extra.length ||
    !artifactCommunityId(community) ||
    tagValue(scope, "community") !== community ||
    name === undefined ||
    !artifactTypeName(name) ||
    !["everyone", "admins"].includes(tagValue(policy, "policy") ?? "") ||
    expected === undefined ||
    (expected !== "0" && !EVENT_ID.test(expected))
  )
    throw new Error("Invalid artifact type policy command");
}

/** The policy read, sent as `[filter]` to `/query`. Throws on a malformed type. */
export function typePolicyFilter(type: string) {
  if (!artifactTypeName(type)) throw new Error("Invalid artifact type");
  return { artifact: "policy", scope: "community", "#type": [type] };
}

/** The relay's `{policy, revision}` answer to `typePolicyFilter`. Throws on
 * anything else. */
export function parseTypePolicy(body: unknown): ArtifactTypePolicyState {
  const { policy, revision } = (
    body && typeof body === "object" && !Array.isArray(body) ? body : {}
  ) as { policy?: unknown; revision?: unknown };
  if (
    (policy !== "everyone" && policy !== "admins") ||
    (revision !== null &&
      (typeof revision !== "string" || !EVENT_ID.test(revision)))
  )
    throw new Error("Invalid artifact type policy");
  return Object.freeze({ policy, revision });
}
