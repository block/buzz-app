import { communityDestination } from "../../features/communities/destination";
import type { PluginModule } from "../../plugins/api";
import { Login } from "./login/Login";
import {
  browserCredential,
  browserLoginAvailable,
  oauthTarget,
} from "./oauth/browser";
import { createOAuthSession } from "./oauth/session";
import { createAgentClient } from "./agents/client";
import { RemoteAgents } from "./agents/RemoteAgents";
import { createEnrollment } from "./agents/enrollment";
import type {} from "./service";

export const inject = ["host", "settingsCards", "relay", "communityReader"];
export const apply: PluginModule["apply"] = (ctx) => {
  let unavailable = "";
  try {
    oauthTarget();
  } catch (error) {
    unavailable =
      error instanceof Error
        ? error.message
        : "Builderlab sign-in is unavailable.";
  }
  const session = createOAuthSession((signal) =>
    browserCredential(ctx.host, signal),
  );
  ctx.effect(() => () => session.dispose());
  const agents = createAgentClient(ctx.host, session, () => {
    const selected = ctx.communityReader.snapshot().selected;
    return selected
      ? communityDestination(selected).url.replace(/^https:/, "wss:")
      : undefined;
  });
  const enrollment = createEnrollment(ctx.relay, ctx.communityReader, session);
  const loginAvailable = browserLoginAvailable() && !unavailable;
  const loginUnavailableReason = browserLoginAvailable()
    ? unavailable
    : "Open the Buzz desktop app to sign in with Builderlab.";
  ctx.provide("builderlab", {
    login: session,
    loginAvailable,
    loginUnavailableReason,
    agents,
    enrollment,
  });
  ctx.settingsCards.register({
    id: "login",
    title: "Builderlab",
    group: "Integrations",
    component: ({ active }) => (
      <>
        <Login
          session={session}
          available={loginAvailable}
          unavailableReason={loginUnavailableReason}
          active={active}
        />
        <RemoteAgents
          client={agents}
          session={session}
          enrollment={enrollment}
          active={active}
        />
      </>
    ),
  });
};
