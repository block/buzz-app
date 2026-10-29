import { useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";
import { handoffBackupSession } from "../../features/identity/backup";
import { nativeIdentityEnabled } from "../../features/identity/service";
import { Login } from "./login/Login";
import {
  browserCredential,
  browserLoginAvailable,
  oauthTarget,
} from "./oauth/browser";
import { createOAuthSession } from "./oauth/session";
import { createAgentClient } from "./agents/client";
import { RemoteAgents } from "./agents/RemoteAgents";
import { builderlabType } from "./adapter-type";
import { createKnownCommunitiesClient } from "./known-communities/client";
import { startKnownCommunitiesSync } from "./known-communities/sync";
import type { AgentProviderSnapshot } from "../../features/agents/service";
import { Header, InlineHeader } from "../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { BlockLogoIcon } from "../../shared/design-system/icons";
import { HostedCommunities } from "./communities/HostedCommunities";
import { brokerApi, createApi } from "./communities/api";
import { createNativeBackend } from "./communities/native";
import { hostedAgentSettings } from "./service";
import { applyApps } from "./apps";

export const inject = [
  "host",
  "settingsCards",
  "agents",
  "relay",
  "panels",
  "browser",
  "knownCommunities",
];
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
  const session = createOAuthSession(
    (signal) => {
      if (!browserLoginAvailable())
        throw new Error(
          "Open the Buzz desktop app to sign in with Builderlab.",
        );
      return browserCredential(ctx.host, signal);
    },
    (credential) => {
      // Local guest teardown is immediate; the parent logout also revokes every server-side viewer child.
      void ctx.host
        .request({
          url: `${oauthTarget()}/v1/auth/logout`,
          method: "POST",
          headers: { "X-BB-Session-Credential": credential.value },
        })
        .catch(() => {});
    },
  );
  ctx.effect(() => () => session.dispose());
  const loginAvailable = browserLoginAvailable() && !unavailable;
  applyApps(ctx, session, loginAvailable);
  const backupSession = () => {
    if (!nativeIdentityEnabled()) return;
    handoffBackupSession(
      "builderlab",
      session.snapshot().status === "signed-in"
        ? session.credential().value
        : null,
    );
  };
  ctx.effect(() => {
    const stop = session.subscribe(backupSession);
    return () => {
      stop();
      if (nativeIdentityEnabled()) handoffBackupSession("builderlab", null);
    };
  });
  // The account's community list follows this sign-in; see docs/communities.md.
  // Where no sign-in is possible, no owner runs, so the rail has no sync to
  // report on.
  if (browserLoginAvailable() && !unavailable)
    ctx.effect(() =>
      startKnownCommunitiesSync({
        client: createKnownCommunitiesClient(ctx.host, session),
        session,
        knownCommunities: ctx.knownCommunities,
      }),
    );
  const agents = createAgentClient(ctx.host, session);
  if (!unavailable) {
    let providerState: AgentProviderSnapshot = {
      readiness: "attention",
      attentionLabel: "Log in to Builderlab",
    };
    const providerListeners = new Set<() => void>();
    const updateProvider = () => {
      const state = session.snapshot();
      providerState = Object.freeze(
        state.status === "signed-in"
          ? state.account?.canUseRemoteAgents
            ? { readiness: "ready" }
            : { readiness: "attention", attentionLabel: "Coming soon" }
          : state.status === "pending"
            ? { readiness: "attention", attentionLabel: "Finish sign-in" }
            : {
                readiness: "attention",
                attentionLabel: "Log in to Builderlab",
              },
      );
      for (const listener of providerListeners) listener();
    };
    const stopProvider = session.subscribe(updateProvider);
    const ProviderDialogBody = () => {
      const state = useSyncExternalStore(session.subscribe, session.snapshot);
      return (
        <div className="grid gap-3">
          <InlineHeader level={3} title="Connection" />
          <Login
            session={session}
            available={loginAvailable}
            active={() => true}
            showHeading={false}
          />
          {state.status === "signed-in" &&
            !state.account?.canUseRemoteAgents && (
              <p role="status" className="text-body-sm text-secondary">
                Builderlab remote agents are coming soon for your account.
              </p>
            )}
        </div>
      );
    };
    ctx.agents.register({
      ...builderlabType(agents, session, ctx.relay),
      provider: {
        snapshot: () => providerState,
        subscribe: (listener) => {
          providerListeners.add(listener);
          return () => providerListeners.delete(listener);
        },
        check: updateProvider,
        DialogBody: ProviderDialogBody,
      },
    });
    ctx.effect(() => () => stopProvider());
    ctx.provide("builderlab", hostedAgentSettings(session, agents));
  }
  // Link the Buzz key at sign-in. Best effort: activation links again and
  // reports why when it cannot.
  let linked: unknown;
  let linking = Promise.resolve();
  ctx.effect(() =>
    session.subscribe(() => {
      if (session.snapshot().status !== "signed-in") return;
      const credential = session.credential();
      if (linked === credential) return;
      linked = credential;
      linking = agents.link(new AbortController().signal).catch(() => {});
    }),
  );
  // Desktop communities use this sign-in. Live development with a pinned
  // viewer keeps the broker, which signs in and signs bindings on its own.
  const communities = !nativeIdentityEnabled()
    ? brokerApi
    : loginAvailable
      ? createApi(createNativeBackend(ctx.host, session, () => linking))
      : null;
  const Communities = ({ active }: { active(): boolean }) => {
    const state = useSyncExternalStore(session.subscribe, session.snapshot);
    if (!communities) return null;
    if (communities === brokerApi)
      return <HostedCommunities api={communities} active={active} />;
    return state.status === "signed-in" ? (
      <HostedCommunities
        key={state.account?.subject}
        api={communities}
        active={active}
        sharedSignIn
      />
    ) : null;
  };
  ctx.settingsCards.register({
    id: "login",
    title: "Builderlab",
    icon: BlockLogoIcon,
    group: "Plugins",
    component: ({ active }) => (
      <section aria-labelledby="builderlab-title">
        <Header
          id="builderlab-title"
          title="Builderlab"
          subtitle="One Builderlab account for hosted communities, remote agents and apps."
        />
        <InlineHeader title="Account" />
        <SettingsGroup layout="form">
          <Login
            showHeading={false}
            session={session}
            available={loginAvailable}
            unavailableReason={
              browserLoginAvailable()
                ? unavailable
                : "Open the Buzz desktop app to sign in with Builderlab."
            }
            active={active}
          />
        </SettingsGroup>
        <Communities active={active} />
        <RemoteAgents client={agents} session={session} active={active} />
      </section>
    ),
  });
};
