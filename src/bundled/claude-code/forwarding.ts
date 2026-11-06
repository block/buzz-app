// Claude's side of gateway forwarding: the shared opener, for Claude.
import type { ForwardOwner } from "../../features/host/forward";
import {
  type ForwardNative,
  type ForwardRoutes,
  GatewayForwarding,
} from "../../features/agents/gateway/forwarding";

export {
  CHANGED,
  type ForwardNative,
  type ForwardRoutes,
  type Generation,
  UNAVAILABLE,
} from "../../features/agents/gateway/forwarding";

/** The harness Claude declares to the gateway, its descriptor upstream key. */
export const HARNESS = "claude-code";

/** Opens Claude turns' generations, each with its spawn session. */
export class ClaudeForwarding extends GatewayForwarding {
  constructor(
    owner: ForwardOwner,
    native?: ForwardNative,
    routes?: ForwardRoutes,
  ) {
    super(owner, { upstream: HARNESS, native: "claude" }, native, routes);
  }
}
