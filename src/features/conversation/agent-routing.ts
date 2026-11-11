import type { Context } from "@deepseek-ai/cordis";
import { createContributions } from "../../plugins/contributions";
import { withTimeout } from "../../plugins/timeout";

/** Public candidate evidence, not an agent's private configuration or authority. */
export type RoutingAgent = Readonly<{
  pubkey: string;
  name: string;
  description: string;
}>;
/** One captured user send. Routing is completed before signing or queueing. */
export type AgentRoutingRequest = Readonly<{
  text: string;
  community?: string | undefined;
  channelId: string;
  candidates: readonly RoutingAgent[];
  context: readonly Readonly<{ author: string; text: string }>[];
}>;
/** An optional plugin policy chooses a nonempty subset of the supplied candidates. */
export type AgentRouter = Readonly<{
  id: string;
  route(request: AgentRoutingRequest): Promise<readonly string[]>;
}>;

/** Plugin lifetime and result validation for the composer's pre-send gate. */
export function createAgentRouting(ctx: Context) {
  const entries = createContributions<AgentRouter>(ctx);
  return {
    register(router: AgentRouter, owner: Context) {
      if (
        !/^[a-z0-9][a-z0-9._-]*$/.test(router.id) ||
        typeof router.route !== "function"
      )
        throw new Error("An agent router needs an id and route function");
      entries.register(owner, router);
    },
    async route(request: AgentRoutingRequest, signal: AbortSignal) {
      signal.throwIfAborted();
      const routers = entries.snapshot();
      if (!routers.length || request.candidates.length < 2) return undefined;
      if (routers.length !== 1)
        throw new Error(
          "More than one agent router is enabled. Keep one enabled and retry.",
        );
      const router = routers[0];
      if (!router) return undefined;
      const snapshot = structuredClone(request);
      let abort = () => {};
      const aborted = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
      let assigned: readonly string[];
      try {
        assigned = await withTimeout(
          Promise.race([router.route(snapshot), aborted]),
          "Agent routing timed out. Your message has not been sent; retry.",
          15_000,
        );
      } finally {
        signal.removeEventListener("abort", abort);
      }
      signal.throwIfAborted();
      const current = entries.snapshot();
      if (current.length !== 1 || current[0] !== router)
        throw new Error(
          "The agent router changed while deciding. Retry your message.",
        );
      const eligible = new Set(request.candidates.map(({ pubkey }) => pubkey));
      if (
        !Array.isArray(assigned) ||
        !assigned.length ||
        new Set(assigned).size !== assigned.length ||
        assigned.some((key) => !eligible.has(key))
      )
        throw new Error(
          "Agent routing did not choose a valid set of selected agents. Your message has not been sent.",
        );
      return request.candidates
        .filter(({ pubkey }) => assigned.includes(pubkey))
        .map(({ pubkey }) => pubkey);
    },
  };
}
