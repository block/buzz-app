// One Claude turn's gateway generation: a native forwarding handle opened at
// the route revision the turn was dispatched with, with the turn's frozen
// headers, given to exactly one Claude process, and never rebound. Native
// owns admission (`host_forward.rs`); this owns the caller's side of it:
// pushing the revision, opening only while it is still the route's, and
// sealing and closing. A route change pushes the new revision, which revokes
// the generation natively, and ends its process. Nothing here waits on
// readiness or re-reads a route to retry: a turn that can't open fails.
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
}>;

/** A generation's caller side. `seal` ends admission for good, at the
 * qualifying idle; `close` forgets it once its process has exited, and
 * resolves on native `closed`, after which nothing of it follows. Both are
 * idempotent. */
export type Generation = Readonly<{
  url: string;
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
const ROUTES: ForwardRoutes = { routeFor, subscribeRoute };
export const CHANGED =
  "This agent's gateway access changed as the turn started, so it didn't run. Try again.";
export const UNAVAILABLE =
  "Buzz couldn't start forwarding to the agent gateway on this device, so the turn didn't run.";

export class ClaudeForwarding {
  /** Native route keys must be short and opaque; agent keys need not be. */
  private readonly keys = new Map<AgentKey, string>();

  constructor(
    private readonly owner: ForwardOwner,
    private readonly native: ForwardNative = NATIVE,
    private readonly routes: ForwardRoutes = ROUTES,
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
   * the revision it was dispatched with. A route that moved on, a refusal or
   * a native side that can't be reached throws, before anything is spawned;
   * it is never retried. A generation opened after `signal` aborted is
   * closed. */
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
    let opened: ForwardOpened | undefined;
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
          onEvent: (event: ForwardEvent) => {
            if (event.type === "closed") closed();
          },
        });
    } catch (error) {
      unsubscribe();
      if (signal.aborted) throw signal.reason;
      if (error instanceof Error && error.message === CHANGED) throw error;
      console.warn("Gateway forwarding is unavailable", error);
      throw new Error(UNAVAILABLE);
    }
    if (opened?.type !== "opened") {
      unsubscribe();
      throw new Error(CHANGED);
    }
    const generation = this.generation(opened, ended, unsubscribe, {
      revocation,
      isRevoked: () => revoked,
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
      revocation,
      isRevoked,
    }: Readonly<{ revocation: Promise<void>; isRevoked: () => boolean }>,
  ): Generation {
    let sealed = false;
    let closing: Promise<void> | undefined;
    return Object.freeze({
      url,
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
    let key = this.keys.get(agent);
    if (!key) {
      key = `route-${this.keys.size + 1}`;
      this.keys.set(agent, key);
    }
    return key;
  }
}
