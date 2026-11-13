// One Claude turn's gateway generation: a native forwarding handle opened at
// the route revision the turn was dispatched with, with the turn's frozen
// headers, given to exactly one Claude process, and never rebound. Native
// owns admission (`host_forward.rs`); this owns the caller's side of it:
// pushing the revision, opening only while it is still the route's, and
// sealing and closing. A route change pushes the new revision, which revokes
// the generation natively, and ends its process. Nothing here waits on
// readiness or re-reads a route to retry; only a native side that can't be
// reached is tried again, briefly, at the same revision.
import {
  closeForward,
  openForward,
  pushForwardAdmission,
  sealForward,
  type ForwardEvent,
  type ForwardOpened,
  type ForwardOwner,
} from "../../features/host/forward";
import type { AgentKey } from "../../features/agents/membership";
import { ENDPOINTS, PROVIDERS } from "./claude";
import {
  bindingAdmits,
  discoveryBundle,
  inferenceBundle,
  type GatewayBinding,
  type TurnContext,
} from "../../features/agents/gateway/contract";
import {
  type EligibleRoute,
  type GatewayRoute,
  invalidateRoute,
  routeFor,
  subscribeRoute,
} from "../../features/agents/gateway/route";

/** The harness Claude declares to the gateway, its descriptor upstream key. */
export const HARNESS = "claude-code";

export type ForwardNative = Readonly<{
  push: typeof pushForwardAdmission;
  open: typeof openForward;
  seal: typeof sealForward;
  close: typeof closeForward;
}>;
export type ForwardRoutes = Readonly<{
  routeFor(key: AgentKey): GatewayRoute;
  subscribeRoute(key: AgentKey, listener: () => void): () => void;
  /** Drops `revision`'s access, as a gateway 401 or 403 says it ended. */
  invalidateRoute(key: AgentKey, revision?: number): void;
}>;
/** The waits before each further try at an open that couldn't reach native
 * or its local proxy: bounded, so a turn still fails visibly soon. */
export type ForwardRetry = Readonly<{ delays: readonly number[] }>;

/** A generation's caller side. `seal` ends admission for good, at the
 * qualifying idle; `close` forgets it once its process has exited, and
 * resolves on native `closed`, after which nothing of it follows. Both are
 * idempotent. */
export type Generation = Readonly<{
  url: string;
  /** The route revision it was opened at, which a steer must share. */
  revision: number;
  /** Sealed: it admits no further model request, so nothing joins it. */
  isSealed(): boolean;
  /** Whether native admitted any request on it: one that never did, once
   * a turn has run, means Claude's requests went somewhere else. */
  admitted(): boolean;
  /** Its process's NO_PROXY and no_proxy: the inherited ones with the
   * generation's loopback address added, so a proxy never gets its
   * requests. */
  noProxy: string;
  seal(): void;
  close(): Promise<void>;
  /** Settles once the route moves on, which revokes the generation
   * natively: its process must end. Recorded from before the open, so an
   * owner attaching late still sees it. */
  revoked: Promise<void>;
  isRevoked(): boolean;
}>;

const NATIVE: ForwardNative = {
  push: pushForwardAdmission,
  open: openForward,
  seal: sealForward,
  close: closeForward,
};
const ROUTES: ForwardRoutes = { routeFor, subscribeRoute, invalidateRoute };
const RETRY: ForwardRetry = { delays: [250, 1_000, 2_500] };
/** Native route keys, short and opaque, for the page's life: a key is never
 * given to another agent, even by a later instance after a re-enable. */
const KEYS = new Map<AgentKey, string>();
export const CHANGED =
  "This agent's gateway access changed as the turn started, so it didn't run. Try again.";
export const UNAVAILABLE =
  "Buzz couldn't start forwarding to the agent gateway on this device, so the turn didn't run.";

/** Native's answer when its local proxy can't listen: the only open or push
 * failure (`host_forward.rs`) worth trying again. Every other is decided
 * before native makes a generation, and fails the same way each time. */
const UNREACHABLE = "Could not start forwarding";
export const MANAGED_UNREADABLE =
  "Buzz couldn't read Claude's managed settings to check where they send this agent's requests, so the turn didn't run.";
export const NO_PROXY_UNREADABLE =
  "Buzz couldn't read this device's proxy exceptions to keep this agent's requests off a proxy, so the turn didn't run.";
export const managedRefusal = (name: string) =>
  `Claude's managed settings set ${name}, which would send this agent's requests around the agent gateway, so the turn didn't run.`;

/** Where every generation is, which a proxy must never be sent. */
const LOOPBACK = ["127.0.0.1", "localhost"];
const NO_PROXY = ["NO_PROXY", "no_proxy"] as const;
const PROXIES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
/** What a no-proxy list names that reaches every generation; anything else,
 * a port or another range included, may not. */
const BYPASSES = new Set(["*", "127.0.0.1", "127.0.0.1/32", "127.0.0.0/8"]);
const hosts = (list: string) => list.split(/[\s,]+/).filter(Boolean);
/** `lists`' hosts once each, with loopback added: what a forwarded process
 * reaches without a proxy, set as both of its names. */
export const noProxy = (lists: readonly string[]) =>
  [...new Set([...lists.flatMap(hosts), ...LOOPBACK])].join(",");

/** The provider or endpoint `files`, managed settings in merge order, set in
 * their `env`, which outranks Buzz's flag settings and process env; or,
 * where a proxy applies (`proxied`, the app's environment has one, or they
 * set one), a no-proxy list they set that may not reach the generation.
 * Undefined when none. A file that isn't a settings object is skipped, as
 * Claude skips it. */
export function managedRouting(
  files: readonly string[],
  proxied: boolean,
): string | undefined {
  const env: Record<string, unknown> = {};
  for (const file of files) {
    let settings: unknown;
    try {
      settings = JSON.parse(file);
    } catch {
      continue;
    }
    const own = (settings as { env?: unknown } | null)?.env;
    if (own && typeof own === "object") Object.assign(env, own);
  }
  const text = (name: string) => String(env[name] ?? "").trim();
  const routed =
    PROVIDERS.find((name) =>
      ["1", "true", "yes", "on"].includes(text(name).toLowerCase()),
    ) ?? ENDPOINTS.find((name) => text(name) !== "");
  if (routed || !(proxied || PROXIES.some((name) => text(name) !== "")))
    return routed;
  return NO_PROXY.find(
    (name) =>
      name in env && !hosts(text(name)).some((host) => BYPASSES.has(host)),
  );
}

/** NO_PROXY and no_proxy as Claude's processes inherit them, and whether
 * they inherit a proxy, whose value (it may hold a password) is never read. */
export type Inherited = Readonly<{
  lists: readonly string[];
  proxied: boolean;
}>;

export const BYPASSED =
  "This turn's model requests didn't go through the agent gateway, so it failed. Claude's own settings may send them elsewhere.";
/** Before Claude's own error, for a forwarded turn that failed with no model
 * request admitted: not necessarily a routing failure. */
export const UNREACHED = "No model request reached the agent gateway.";

export class ClaudeForwarding {
  constructor(
    private readonly owner: ForwardOwner,
    /** The managed settings files Claude reads, in merge order: required,
     * so nothing opens without checking them. */
    private readonly managed: () => Promise<readonly string[]>,
    /** NO_PROXY and no_proxy as Claude's processes inherit them, and
     * whether a proxy does: required, so no forwarded process drops the
     * person's own. */
    private readonly inherited: () => Promise<Inherited>,
    private readonly native: ForwardNative = NATIVE,
    private readonly routes: ForwardRoutes = ROUTES,
    private readonly retry: ForwardRetry = RETRY,
  ) {}

  /** The route a session control with no turn of its own (compaction) goes
   * by, read now without waiting: undefined where the runner wouldn't send
   * the agent's turns to the gateway, so it runs on Claude's own
   * configuration; else the eligible route that enables Claude, or the
   * blocked one its turns would fall back from. */
  control(
    agent: AgentKey,
  ): EligibleRoute | Extract<GatewayRoute, { kind: "blocked" }> | undefined {
    const route = this.routes.routeFor(agent);
    if (route.kind === "blocked") return route;
    return route.kind === "eligible" && route.harnesses.includes(HARNESS)
      ? route
      : undefined;
  }

  /** Opens the turn's generation for harness session `session` at `route`,
   * the revision it was dispatched with. Managed settings that would send
   * Claude's requests elsewhere, a route that moved on, a refusal or a
   * native error throw at once, before anything is spawned; only a local
   * proxy that can't listen is tried again after each of the retry's delays
   * while the route and `signal` hold. A generation opened after `signal`
   * aborted is closed. */
  async open(
    agent: AgentKey,
    route: EligibleRoute,
    turn: Readonly<{
      binding: GatewayBinding;
      context: TurnContext;
      session: string;
    }>,
    signal: AbortSignal,
  ): Promise<Generation> {
    const inference = inferenceBundle(
      route.profile,
      turn.binding,
      turn.context,
    );
    if (!inference.ok) throw new Error(inference.message);
    if (!bindingAdmits(route, turn.binding).ok) throw new Error(CHANGED);
    const discovery = discoveryBundle(route.profile, route, turn.binding);
    if (!discovery.ok) throw new Error(discovery.message);
    let files: readonly string[];
    try {
      files = await this.managed();
    } catch (error) {
      console.warn("Claude's managed settings are unreadable", error);
      throw new Error(MANAGED_UNREADABLE);
    }
    let inherited: Inherited;
    try {
      inherited = await this.inherited();
    } catch (error) {
      console.warn("The proxy exceptions are unreadable", error);
      throw new Error(NO_PROXY_UNREADABLE);
    }
    const set = managedRouting(files, inherited.proxied);
    if (set) throw new Error(managedRefusal(set));
    signal.throwIfAborted();
    // Watched from before the push: a change during it, the open or the
    // process's startup is pushed (native revokes on it) and recorded.
    let revoked = false;
    let revoke!: () => void;
    const revocation = new Promise<void>((resolve) => {
      revoke = resolve;
    });
    const moved = () =>
      revoked || this.routes.routeFor(agent).revision !== route.revision;
    const unsubscribe = this.routes.subscribeRoute(agent, () => {
      const now = this.routes.routeFor(agent);
      if (revoked || now.revision === route.revision) return;
      revoked = true;
      void this.push(agent, now).catch(() => undefined);
      revoke();
    });
    let closed!: () => void;
    const ended = new Promise<void>((resolve) => {
      closed = resolve;
    });
    let admitted = false;
    const onEvent = (event: ForwardEvent) => {
      if (event.type === "closed") closed();
      // Model requests: discovery alone isn't Claude's turn reaching it.
      if (event.type === "admitted" && event.class === "inference")
        admitted = true;
      // The gateway ended this revision's access: the next turn reads the
      // route again. The turn fails as its process ends on the revocation.
      if (
        event.type === "finished" &&
        (event.status === 401 || event.status === 403)
      )
        this.routes.invalidateRoute(agent, route.revision);
    };
    let opened: ForwardOpened | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        if (moved()) throw new Error(CHANGED);
        await this.push(agent, route);
        signal.throwIfAborted();
        // Open only at the acknowledged revision.
        if (!moved())
          opened = await this.native.open(this.owner, {
            route: this.key(agent),
            routeRevision: route.revision,
            harness: "claude",
            session: turn.session,
            inference: inference.value,
            discovery: discovery.value,
            onEvent,
          });
        break;
      } catch (error) {
        const changed = error instanceof Error && error.message === CHANGED;
        const unreachable =
          (error instanceof Error ? error.message : String(error)) ===
          UNREACHABLE;
        const delay = this.retry.delays[attempt];
        if (!signal.aborted && unreachable && delay !== undefined) {
          console.warn("Gateway forwarding is unavailable; retrying", error);
          if (await wait(delay, signal)) continue;
        }
        unsubscribe();
        if (signal.aborted) throw signal.reason;
        if (changed) throw error;
        console.warn("Gateway forwarding is unavailable", error);
        throw new Error(UNAVAILABLE);
      }
    }
    if (opened?.type !== "opened") {
      unsubscribe();
      throw new Error(CHANGED);
    }
    const generation = this.generation(opened, ended, unsubscribe, {
      revision: route.revision,
      revocation,
      isRevoked: () => revoked,
      admitted: () => admitted,
      noProxy: noProxy(inherited.lists),
    });
    if (signal.aborted || revoked) {
      await generation.close();
      signal.throwIfAborted();
      throw new Error(CHANGED);
    }
    return generation;
  }

  private generation(
    { id, url }: Readonly<{ id: number; url: string }>,
    ended: Promise<void>,
    unsubscribe: () => void,
    {
      revision,
      revocation,
      isRevoked,
      admitted,
      noProxy,
    }: Readonly<{
      revision: number;
      revocation: Promise<void>;
      isRevoked: () => boolean;
      admitted: () => boolean;
      noProxy: string;
    }>,
  ): Generation {
    let sealed = false;
    let closing: Promise<void> | undefined;
    return Object.freeze({
      url,
      revision,
      isSealed: () => sealed || closing !== undefined,
      admitted,
      noProxy,
      revoked: revocation,
      isRevoked,
      seal: () => {
        if (sealed || closing) return;
        sealed = true;
        void this.native.seal(this.owner, id).catch(() => undefined);
      },
      close: () => {
        if (closing) return closing;
        unsubscribe();
        // A generation native already dropped (a page reload) sent `closed`.
        closing = this.native.close(this.owner, id).then(
          () => ended,
          () => undefined,
        );
        return closing;
      },
    });
  }

  private push(agent: AgentKey, route: GatewayRoute) {
    return this.native.push(
      this.owner,
      this.key(agent),
      route.revision,
      route.kind === "eligible",
    );
  }

  private key(agent: AgentKey) {
    let key = KEYS.get(agent);
    if (!key) {
      key = `route-${KEYS.size + 1}`;
      KEYS.set(agent, key);
    }
    return key;
  }
}

/** Waits `ms`, resolving false at once if `signal` aborts first. */
function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
