import type { OAuthSession } from "./oauth/session";
import type { AgentClient } from "./agents/client";
import type { AgentEnrollment } from "./agents/enrollment";

/** Bundled consumers share the existing login and agent enrollment owner. */
export type Builderlab = Readonly<{
  login: OAuthSession;
  loginAvailable: boolean;
  loginUnavailableReason: string;
  agents: AgentClient;
  enrollment: AgentEnrollment;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    builderlab: Builderlab;
  }
}
