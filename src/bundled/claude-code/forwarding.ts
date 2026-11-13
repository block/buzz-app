// Claude's side of gateway forwarding: the shared opener, for Claude, which
// first checks that Claude's managed settings don't send its requests around
// the gateway.
import type { ForwardOwner } from "../../features/host/forward";
import {
  type ForwardNative,
  type ForwardRetry,
  type ForwardRoutes,
  GatewayForwarding,
} from "../../features/agents/gateway/forwarding";
import { ENDPOINTS, PROVIDERS } from "./claude";

export {
  CHANGED,
  type ForwardNative,
  type ForwardRetry,
  type ForwardRoutes,
  type Generation,
  UNAVAILABLE,
} from "../../features/agents/gateway/forwarding";

/** The harness Claude declares to the gateway, its descriptor upstream key. */
export const HARNESS = "claude-code";

export const MANAGED_UNREADABLE =
  "Buzz couldn't read Claude's managed settings to check where they send this agent's requests, so the turn didn't run.";
export const managedRefusal = (name: string) =>
  `Claude's managed settings set ${name}, which would send this agent's requests around the agent gateway, so the turn didn't run.`;

/** The provider or endpoint `files`, managed settings in merge order, set in
 * their `env`, which outranks Buzz's flag settings; undefined when none. A
 * file that isn't a settings object is skipped, as Claude skips it. */
export function managedRouting(files: readonly string[]): string | undefined {
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
  return (
    PROVIDERS.find((name) =>
      ["1", "true", "yes", "on"].includes(text(name).toLowerCase()),
    ) ?? ENDPOINTS.find((name) => text(name) !== "")
  );
}

export const BYPASSED =
  "This turn's model requests didn't go through the agent gateway, so it failed. Claude's own settings may send them elsewhere.";

/** Opens Claude turns' generations, each with its spawn session. */
export class ClaudeForwarding extends GatewayForwarding {
  constructor(
    owner: ForwardOwner,
    /** The managed settings files Claude reads, in merge order: required,
     * so nothing opens without checking them. */
    managed: () => Promise<readonly string[]>,
    native?: ForwardNative,
    routes?: ForwardRoutes,
    retry?: ForwardRetry,
  ) {
    super(
      owner,
      { upstream: HARNESS, native: "claude" },
      native,
      routes,
      retry,
      async () => {
        let files: readonly string[];
        try {
          files = await managed();
        } catch (error) {
          console.warn("Claude's managed settings are unreadable", error);
          throw new Error(MANAGED_UNREADABLE);
        }
        const set = managedRouting(files);
        if (set) throw new Error(managedRefusal(set));
      },
    );
  }
}
