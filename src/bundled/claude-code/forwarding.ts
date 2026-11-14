// Claude's side of gateway forwarding: the shared opener, for Claude, which
// first checks that Claude's managed settings don't send its requests around
// the gateway.
import type { ForwardOwner } from "../../features/host/forward";
import {
  type ForwardNative,
  type ForwardRetry,
  type ForwardRoutes,
  GatewayForwarding,
  type Inherited,
} from "../../features/agents/gateway/forwarding";
import { ENDPOINTS, PROVIDERS } from "./claude";

export {
  CHANGED,
  type ForwardNative,
  type ForwardRetry,
  type ForwardRoutes,
  type Generation,
  type Inherited,
  NO_PROXY_UNREADABLE,
  noProxy,
  UNAVAILABLE,
  UNREACHED,
} from "../../features/agents/gateway/forwarding";

/** The harness Claude declares to the gateway, its descriptor upstream key. */
export const HARNESS = "claude-code";

export const MANAGED_UNREADABLE =
  "Buzz couldn't read Claude's managed settings to check where they send this agent's requests, so the turn didn't run.";
export const managedRefusal = (name: string) =>
  `Claude's managed settings set ${name}, which would send this agent's requests around the agent gateway, so the turn didn't run.`;

const NO_PROXY = ["NO_PROXY", "no_proxy"] as const;
const PROXIES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
/** What a no-proxy list names that reaches every generation; anything else,
 * a port or another range included, may not. */
const BYPASSES = new Set(["*", "127.0.0.1", "127.0.0.1/32", "127.0.0.0/8"]);
const hosts = (list: string) => list.split(/[\s,]+/).filter(Boolean);

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

export const BYPASSED =
  "This turn's model requests didn't go through the agent gateway, so it failed. Claude's own settings may send them elsewhere.";

/** Opens Claude turns' generations, each with its spawn session. */
export class ClaudeForwarding extends GatewayForwarding {
  constructor(
    owner: ForwardOwner,
    /** The managed settings files Claude reads, in merge order: required,
     * so nothing opens without checking them. */
    managed: () => Promise<readonly string[]>,
    /** NO_PROXY and no_proxy as Claude's processes inherit them, and whether
     * a proxy does. */
    inherited: () => Promise<Inherited>,
    native?: ForwardNative,
    routes?: ForwardRoutes,
    retry?: ForwardRetry,
  ) {
    super(
      owner,
      { upstream: HARNESS, native: "claude" },
      inherited,
      native,
      routes,
      retry,
      async ({ proxied }) => {
        let files: readonly string[];
        try {
          files = await managed();
        } catch (error) {
          console.warn("Claude's managed settings are unreadable", error);
          throw new Error(MANAGED_UNREADABLE);
        }
        const set = managedRouting(files, proxied);
        if (set) throw new Error(managedRefusal(set));
      },
    );
  }
}
