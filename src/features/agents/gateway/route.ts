import type { HostRequest, HostResponse } from "../../host/service";
import type { AgentKey } from "../membership";
import {
  discoveryBundle,
  type GatewayIdentity,
  type GatewayProfile,
  identityErrors,
} from "./contract";
import { gatewayDescriptor, type GatewayDescriptor } from "./descriptor";

// One owner decides, per local agent membership, whether its inference goes
// through the agent gateway. Only an origin the descriptor doesn't name
// is external. A named community stays blocked until its exact NIP-11 ID,
// the agent's identity and the access check are all confirmed, and goes back
// to pending on any change, so it never passes through external (direct
// providers) or a stale eligible route on the way.
//
// Every route carries the membership's eligibility revision. It rises
// synchronously whenever the route returns to pending (a membership change,
// removal, a 401/403, a retried failure), before any probe starts, and once
// more when a probe started at the current revision publishes its result. A
// probe that settles after the revision moved is discarded. So an answer is
// only ever valid at one revision, and native admission (which owns the
// handles and generations) can apply the highest revision it has seen and
// terminally revoke what opened under an older one. Nothing here re-probes
// on a schedule: a re-probe revokes the turns running under the old revision.

export type BlockedReason =
  | "readiness_pending"
  | "descriptor_invalid"
  | "community_id_missing"
  | "community_id_mismatch"
  | "identity_invalid"
  | "auth"
  | "network"
  | "gateway_error";
export type EligibleRoute = Readonly<{
  kind: "eligible";
  revision: number;
  gatewayOrigin: string;
  identity: GatewayIdentity;
  /** The build's context header profile, for the adapter's composer. */
  profile: GatewayProfile;
  /** The harnesses the gateway enables for this membership (its rollout
   * flag); a harness not listed keeps its existing behavior. */
  harnesses: readonly string[];
}>;
export type BlockedRoute = Readonly<{
  kind: "blocked";
  revision: number;
  gatewayOrigin: string;
  reason: BlockedReason;
  message: string;
}>;
export type GatewayRoute =
  | Readonly<{ kind: "external"; revision: number }>
  | EligibleRoute
  | BlockedRoute;

/** A local agent membership as Agents knows it. `community` is undefined
 * while the community has no live relay session, then what that session's
 * transport read from NIP-11 `read_state_snapshot.community_id` when it was
 * created (undefined id: none), with the session it came from. A socket
 * reconnect keeps the session, so it changes nothing; a replaced session is
 * new evidence and returns the route to pending, even with the same ID. An
 * older session's ID never stands in for a new one's. */
export type GatewayMembership = Readonly<{
  key: AgentKey;
  origin: string;
  owner: string;
  pubkey: string;
  community?: Readonly<{ id: string | undefined; session: object }> | undefined;
}>;
/** Sends one GET through a native grant for the gateway origin. */
export type GatewayRequest = (request: HostRequest) => Promise<HostResponse>;

const MESSAGES: Record<BlockedReason, string> = {
  readiness_pending: "Checking gateway access for this agent…",
  descriptor_invalid:
    "This build's agent gateway configuration is invalid, so its agents can't run.",
  community_id_missing:
    "This community didn't identify itself, so its agents can't use the agent gateway. Try again once it reconnects.",
  community_id_mismatch:
    "This community's ID doesn't match this build's agent gateway configuration, so its agents can't run.",
  identity_invalid:
    "This agent's owner or key isn't valid for gateway routing.",
  auth: "The agent gateway didn't accept your sign-in. Check that you're signed in, then try again.",
  network:
    "Buzz couldn't reach the agent gateway. Check your network connection, then try again.",
  gateway_error:
    "The agent gateway couldn't confirm model access. Try again shortly.",
};

/** Why a turn ran without the gateway, as its per-turn notice says. */
const FALLBACK: Record<BlockedReason, string> = {
  readiness_pending: "gateway access was still being checked",
  descriptor_invalid: "this build's agent gateway configuration is invalid",
  community_id_missing: "this community didn't identify itself",
  community_id_mismatch:
    "this community doesn't match this build's agent gateway configuration",
  identity_invalid: "this agent's owner or key isn't valid for the gateway",
  auth: "the gateway didn't accept your sign-in",
  network: "Buzz couldn't reach the gateway",
  gateway_error: "the gateway couldn't confirm model access",
};
/** The notice on a turn that a blocked route sent to the harness's own
 * configuration before dispatch, instead of failing it. */
export const fallbackNotice = (route: BlockedRoute) =>
  `Ran without the agent gateway: ${FALLBACK[route.reason]}.`;

type Readiness =
  | Readonly<{ status: "probing"; settled: Promise<void> }>
  | Readonly<{ status: "ready"; answer: AccessAnswer }>
  | Readonly<{ status: "failed"; reason: BlockedReason }>;
type AccessAnswer = Readonly<{ harnesses: readonly string[] }>;

export class GatewayRoutes {
  private readonly members = new Map<AgentKey, GatewayMembership>();
  /** By (AgentKey, gateway origin, community ID): the app doesn't know the
   * signed-in principal, so the agent binding is the cache boundary. */
  private readonly readiness = new Map<string, Readiness>();
  /** Kept after a membership is removed, so a membership that comes back
   * never reuses a revision. */
  private readonly revisions = new Map<AgentKey, number>();
  private readonly listeners = new Map<AgentKey, Set<() => void>>();
  private request: GatewayRequest | undefined;
  private readonly descriptor: GatewayDescriptor | null | "invalid";
  private readonly profile: GatewayProfile | undefined;

  constructor(descriptor: () => GatewayDescriptor | null) {
    let parsed: GatewayDescriptor | null | "invalid";
    try {
      parsed = descriptor();
    } catch {
      parsed = "invalid";
    }
    this.descriptor = parsed;
    if (parsed !== null && parsed !== "invalid")
      this.profile = Object.freeze({
        launcher_client: parsed.launcher_client,
        headers: parsed.headers,
        reserved_prefixes: parsed.reserved_prefixes,
      });
  }

  /** Whether any membership could route through the gateway in this build. */
  get configured() {
    return this.descriptor !== null;
  }

  /** The upstream base this build configures for `harness`, or undefined
   * when it has none: an unconfigured harness keeps the user's own
   * configuration, without a fallback notice. */
  upstream(harness: string): Readonly<{ base: string }> | undefined {
    const descriptor = this.descriptor;
    if (descriptor === null || descriptor === "invalid") return;
    return Object.hasOwn(descriptor.upstreams, harness)
      ? descriptor.upstreams[harness as keyof typeof descriptor.upstreams]
      : undefined;
  }

  /** Lets readiness probes go out through `request` until the returned
   * function is called. Pending memberships are probed at once. */
  bindRequest(request: GatewayRequest) {
    this.request = request;
    for (const key of this.members.keys()) this.probe(key);
    return () => {
      if (this.request === request) this.request = undefined;
    };
  }

  /** Records `member`'s current state. Any change to what decides its route
   * returns it to pending and probes it again. */
  setMembership(member: GatewayMembership) {
    const prior = this.members.get(member.key);
    if (
      prior &&
      prior.origin === member.origin &&
      prior.owner === member.owner &&
      prior.pubkey === member.pubkey &&
      prior.community?.session === member.community?.session &&
      prior.community?.id === member.community?.id
    )
      return;
    if (prior) this.forget(prior);
    this.members.set(member.key, member);
    this.bump(member.key);
    this.probe(member.key);
    this.notify(member.key);
  }

  removeMembership(key: AgentKey) {
    const prior = this.members.get(key);
    if (!prior) return;
    this.forget(prior);
    this.members.delete(key);
    this.bump(key);
    this.notify(key);
  }

  /** The membership's route now. An unknown membership is external only when
   * this build has no gateway configuration; otherwise it is pending. */
  routeFor(key: AgentKey): GatewayRoute {
    const decided = this.decide(key);
    if (decided.kind !== "pending") return decided.route;
    const state = this.readiness.get(decided.cache);
    return state?.status === "ready"
      ? Object.freeze({
          kind: "eligible",
          revision: this.revision(key),
          gatewayOrigin: decided.gateway,
          identity: decided.identity,
          profile: decided.profile,
          ...state.answer,
        })
      : blocked(
          decided.gateway,
          state?.status === "failed" ? state.reason : "readiness_pending",
          this.revision(key),
        );
  }

  /** The membership's route for a turn starting now, without waiting on
   * readiness: a turn never stalls on the gateway, and one that finds it
   * pending or failed falls back. A failed probe is retried in the
   * background, so a later turn can route after a network blip. */
  routeForTurn(key: AgentKey): GatewayRoute {
    const route = this.routeFor(key);
    const decided = this.decide(key);
    if (
      decided.kind === "pending" &&
      this.readiness.get(decided.cache)?.status === "failed"
    ) {
      // Nothing is admitted at a failed revision, so retrying revokes nothing.
      this.readiness.delete(decided.cache);
      this.bump(key);
      this.probe(key);
      this.notify(key);
    }
    return route;
  }

  /** The membership's route once readiness has settled, for an explicit
   * operation that may wait, such as a harness retrying model discovery;
   * turns use `routeForTurn` instead. A failed probe is tried once more
   * here. */
  async routeReady(key: AgentKey, signal: AbortSignal) {
    signal.throwIfAborted();
    const decided = this.decide(key);
    if (decided.kind !== "pending") return decided.route;
    if (this.readiness.get(decided.cache)?.status === "failed") {
      // Nothing is admitted at a failed revision, so retrying revokes nothing.
      this.readiness.delete(decided.cache);
      this.bump(key);
      this.notify(key);
    }
    // A probe discarded because the membership changed meanwhile leaves a
    // newer one in flight: wait for that too.
    for (let probing = this.probe(key); probing; probing = this.probe(key)) {
      const settled = probing;
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void settled.finally(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        });
      });
    }
    return this.routeFor(key);
  }

  subscribeRoute(key: AgentKey, listener: () => void) {
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener);
    this.listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(key);
    };
  }

  /** Drops what was learned about the membership's access, for a 401 or 403
   * from discovery or inference: it is pending until a new probe settles.
   * Given the revision the failing request ran under, a late failure from an
   * older revision doesn't discard a newer answer. */
  invalidate(key: AgentKey, revision?: number) {
    if (revision !== undefined && revision !== this.revision(key)) return;
    const decided = this.decide(key);
    if (decided.kind !== "pending") return;
    this.readiness.delete(decided.cache);
    this.bump(key);
    this.probe(key);
    this.notify(key);
  }

  private decide(key: AgentKey):
    | Readonly<{ kind: "decided"; route: GatewayRoute }>
    | Readonly<{
        kind: "pending";
        gateway: string;
        url: string;
        profile: GatewayProfile;
        identity: GatewayIdentity;
        cache: string;
      }> {
    const revision = this.revision(key);
    const decided = (route: GatewayRoute) =>
      ({ kind: "decided", route }) as const;
    const external = decided(Object.freeze({ kind: "external", revision }));
    const descriptor = this.descriptor;
    if (descriptor === null) return external;
    const profile = this.profile;
    if (descriptor === "invalid" || !profile)
      return decided(blocked("", "descriptor_invalid", revision));
    const member = this.members.get(key);
    const community =
      member &&
      descriptor.communities.find(({ origin }) => origin === member.origin);
    // Unknown here means not fed yet or removed: never external while a
    // descriptor is configured, so a stale key can't reach direct providers.
    if (!member) return decided(blocked("", "readiness_pending", revision));
    if (!community) return external;
    const gateway = descriptor.gateway;
    if (!member.community)
      return decided(blocked(gateway, "readiness_pending", revision));
    if (member.community.id === undefined)
      return decided(blocked(gateway, "community_id_missing", revision));
    if (member.community.id !== community.id)
      return decided(blocked(gateway, "community_id_mismatch", revision));
    const identity = Object.freeze({
      community_id: community.id,
      human_pubkey: member.owner,
      agent_pubkey: member.pubkey,
    });
    if (identityErrors(identity))
      return decided(blocked(gateway, "identity_invalid", revision));
    return {
      kind: "pending",
      gateway,
      url: `${gateway}${descriptor.access_path}`,
      profile,
      identity,
      cache: JSON.stringify([key, gateway, community.id]),
    };
  }

  /** Starts an access check for the membership when it needs one and a
   * request path is bound; returns the probe in flight, if any. */
  private probe(key: AgentKey): Promise<void> | undefined {
    const decided = this.decide(key);
    if (decided.kind !== "pending") return;
    const state = this.readiness.get(decided.cache);
    if (state?.status === "probing") return state.settled;
    if (state) return;
    const request = this.request;
    if (!request) return;
    const headers = discoveryBundle(decided.profile, {
      identity: decided.identity,
    });
    if (!headers.ok) return;
    const started = this.revision(key);
    const settled = probeAccess(request, decided.url, headers.value).then(
      (result) => {
        if (this.readiness.get(decided.cache) !== probing) return;
        if (this.revision(key) !== started) {
          this.readiness.delete(decided.cache);
          return;
        }
        this.bump(key);
        this.readiness.set(
          decided.cache,
          Object.freeze(
            "reason" in result
              ? { status: "failed", reason: result.reason }
              : { status: "ready", answer: result },
          ),
        );
        this.notify(key);
      },
    );
    const probing: Readiness = Object.freeze({ status: "probing", settled });
    this.readiness.set(decided.cache, probing);
    return settled;
  }

  private forget(member: GatewayMembership) {
    const decided = this.decide(member.key);
    if (decided.kind === "pending") this.readiness.delete(decided.cache);
  }

  private revision(key: AgentKey) {
    return this.revisions.get(key) ?? 0;
  }

  private bump(key: AgentKey) {
    this.revisions.set(key, this.revision(key) + 1);
  }

  private notify(key: AgentKey) {
    for (const listener of [...(this.listeners.get(key) ?? [])]) listener();
  }
}

/** The gateway's access answer for this caller, or why it failed. An
 * absent `harnesses` enables none, so a gateway without the rollout flag
 * leaves every harness on its existing behavior. */
export async function probeAccess(
  request: GatewayRequest,
  url: string,
  headers: Readonly<Record<string, string>>,
): Promise<AccessAnswer | Readonly<{ reason: BlockedReason }>> {
  let response: HostResponse;
  try {
    response = await request({
      url,
      method: "GET",
      headers: { accept: "application/json", ...headers },
      timeoutMs: 15_000,
    });
  } catch {
    return { reason: "network" };
  }
  if (response.status === 401 || response.status === 403)
    return { reason: "auth" };
  if (response.status !== 200) return { reason: "gateway_error" };
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    return { reason: "gateway_error" };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return { reason: "gateway_error" };
  // Any model policy in the answer is the gateway's to enforce, and
  // gateway-filtered discovery lists what the membership may use, so only
  // the harness list is read here.
  const { harnesses = [] } = body as { harnesses?: unknown };
  if (
    !Array.isArray(harnesses) ||
    harnesses.length > 32 ||
    !harnesses.every((name) => typeof name === "string" && HARNESS.test(name))
  )
    return { reason: "gateway_error" };
  return Object.freeze({
    harnesses: Object.freeze([...new Set<string>(harnesses)]),
  });
}
/** A harness name a type declares and the gateway's flag lists. */
export const HARNESS = /^[a-z0-9][a-z0-9-]{0,31}$/;

const blocked = (
  gatewayOrigin: string,
  reason: BlockedReason,
  revision: number,
): BlockedRoute =>
  Object.freeze({
    kind: "blocked",
    revision,
    gatewayOrigin,
    reason,
    message: MESSAGES[reason],
  });

/** This app's routes, from this build's descriptor. */
export const gatewayRoutes = new GatewayRoutes(gatewayDescriptor);
export const routeFor = (key: AgentKey) => gatewayRoutes.routeFor(key);
export const routeReady = (key: AgentKey, signal: AbortSignal) =>
  gatewayRoutes.routeReady(key, signal);
export const subscribeRoute = (key: AgentKey, listener: () => void) =>
  gatewayRoutes.subscribeRoute(key, listener);
export const invalidateRoute = (key: AgentKey, revision?: number) =>
  gatewayRoutes.invalidate(key, revision);
/** This build's upstream base for `harness`, for work outside a delivery
 * such as model discovery; a delivery carries its own as
 * `gateway.upstream`. */
export const upstreamFor = (harness: string) => gatewayRoutes.upstream(harness);
