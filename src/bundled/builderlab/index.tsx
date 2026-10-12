import { communityDestination } from "../../features/communities/destination";
import type { PluginModule } from "../../plugins/api";
import { Login } from "../../features/federated-identity/Login";
import { createFederatedSession } from "../../features/federated-identity/session";
import { createAgentClient } from "./agents/client";
import { RemoteAgents } from "./agents/RemoteAgents";
import { createEnrollment } from "./agents/enrollment";

export const inject = [
  "host",
  "federatedIdentity",
  "settingsCards",
  "relay",
  "communityReader",
  "agents2",
];
export const apply: PluginModule["apply"] = (ctx) => {
  const session = createFederatedSession(ctx.federatedIdentity);
  let registered = false;
  const registerType = () => {
    if (registered || !session.available()) return;
    registered = true;
    ctx.agents2.register({
      id: "builderlab",
      title: "Builderlab",
      description: "Builderlab remote agents",
      defaults: () => ({ config: {} }),
    });
  };
  registerType();
  ctx.effect(() => session.subscribe(registerType));
  const agents = createAgentClient(ctx.host, session, () => {
    const selected = ctx.communityReader.snapshot().selected;
    return selected
      ? communityDestination(selected).url.replace(/^https:/, "wss:")
      : undefined;
  });
  const enrollment = createEnrollment(ctx.relay, ctx.communityReader, session);
  ctx.settingsCards.register({
    id: "login",
    title: "Builderlab",
    group: "Integrations",
    component: ({ active }) => (
      <>
        <Login
          session={session}
          available={true}
          unavailableReason="Federated sign-in is not configured for this Buzz build."
          active={active}
        />
        {ctx.federatedIdentity.apiAvailable ? (
          <RemoteAgents
            client={agents}
            session={session}
            enrollment={enrollment}
            active={active}
          />
        ) : (
          <p role="status" className="text-body-sm text-secondary">
            Remote agent management is unavailable until the identity API
            contract is enabled.
          </p>
        )}
      </>
    ),
  });
};
