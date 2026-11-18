// Builderlab as a decision provider: the Builderlab sign-in of each request's
// community, which native code sends with the call. The NIP-FI session is
// named by its revision; its token never leaves native. It is offered while
// the user is signed in, and ready in a community only while that community's
// Builderlab account may use decisions; see `offerBuilderlabDecisions`.
// Settings > Decisions API shows the same sign-in control as this plugin's
// card.
import { useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  DecisionProvider,
  DecisionProviderStatus,
  DecisionReply,
} from "../../features/decisions/service";
import { Login } from "./login/Login";
import type {
  BuilderlabSession,
  CommunitySessions,
  Credential,
} from "./session";
import type { FederatedIdentity } from "../../features/federated-identity/service";
import { coversCommunity } from "../../features/federated-identity/community-hosts";
import type { KnownCommunities } from "../../features/communities/service";
import { communityDestination } from "../../features/communities/destination";

/** Native `decide` on Builderlab, as the sign-in `credential`. */
export type BuilderlabDecide = (
  request: unknown,
  credential: Credential,
) => Promise<unknown>;
export const nativeBuilderlabDecide = (): BuilderlabDecide | undefined =>
  isTauri()
    ? (request, credential) =>
        invoke("decide", {
          backend: "builderlab",
          request,
          federated: credential.revision,
        })
    : undefined;

/** The Builderlab sign-ins that answer each community's decisions. */
export type CommunityDecisionSessions = Readonly<{
  /** The joined communities, as relay URLs. */
  communities(): readonly string[];
  /** The session of the community's sign-in server, or undefined where no
   * Builderlab serves that community. */
  forCommunity(relay: string): BuilderlabSession | undefined;
  /** The sign-in server that serves the community, or undefined where none
   * does. Communities with the same server share one account. */
  account(relay: string): string | undefined;
  /** Any community's session, or the list, changed. */
  subscribe(listener: () => void): () => void;
}>;

/** Each joined community's decisions sign-in: its sign-in server's session
 * from `sessions`, where that server covers the community's host. */
export function communityDecisionSessions(
  sessions: CommunitySessions,
  identity: Pick<FederatedIdentity, "snapshot" | "subscribe">,
  known: Pick<KnownCommunities, "snapshot" | "subscribe">,
): CommunityDecisionSessions {
  const communities = () =>
    known.snapshot().memberships.flatMap(({ id }) => {
      try {
        return [communityDestination(id).url];
      } catch {
        return [];
      }
    });
  /** The authority of the server that covers `relay`, if one does. */
  const covering = (relay: string) => {
    // Without a server per community, the build's answers every one.
    const authority = (sessions.server(relay) ?? identity).snapshot().authority;
    return authority && coversCommunity(authority.communityHosts, relay)
      ? authority
      : undefined;
  };
  return {
    communities,
    forCommunity: (relay) =>
      covering(relay) ? sessions.forCommunity(relay) : undefined,
    account: (relay) => covering(relay)?.id,
    subscribe(listener) {
      // Each community's server and session; either can change which
      // session answers it, so a change watches them again.
      let watched: readonly { subscribe(listener: () => void): () => void }[] =
        [];
      let stops: (() => void)[] = [];
      const watch = () => {
        const next = communities().flatMap((relay) => {
          const server = sessions.server(relay);
          const session = sessions.forCommunity(relay);
          return server ? [server, session] : [session];
        });
        if (
          next.length === watched.length &&
          next.every((each, index) => each === watched[index])
        )
          return;
        for (const stop of stops) stop();
        watched = next;
        stops = next.map((each) => each.subscribe(changed));
      };
      const changed = () => {
        watch();
        listener();
      };
      const stopIdentity = identity.subscribe(changed);
      const stopKnown = known.subscribe(changed);
      watch();
      return () => {
        stopIdentity();
        stopKnown();
        for (const stop of stops) stop();
        stops = [];
      };
    },
  };
}

/** Registers Builderlab in Settings > Decisions API while the user is signed
 * in, or a joined community's sign-in server serves it, so its sign-in can
 * start there; and removes it otherwise. It is ready in a community while that
 * community's Builderlab reports that the account may use decisions; reading
 * its status keeps that fresh. Where it is ready it is a default provider,
 * so it answers unless the user chose another. Builds without native calls
 * never offer it. `session` signs in from Settings; `communities`, when
 * given, answers each community with its own sign-in server's session.
 * `openIdentity` opens where an FI build's shared sign-in ends. */
export function offerBuilderlabDecisions(
  ctx: Context,
  session: BuilderlabSession,
  loginAvailable: boolean,
  native: BuilderlabDecide | undefined = nativeBuilderlabDecide(),
  openIdentity?: () => void,
  communities?: CommunityDecisionSessions,
) {
  if (!native) return;
  const provider = builderlabProvider(
    session,
    loginAvailable,
    native,
    openIdentity,
    communities,
  );
  const signedIn = (each: BuilderlabSession | undefined) =>
    each?.snapshot().status === "signed-in";
  let withdraw: (() => void) | undefined;
  const update = () => {
    const allowed =
      signedIn(session) ||
      !!communities
        ?.communities()
        .some((relay) => communities.forCommunity(relay) !== undefined);
    if (allowed && !withdraw)
      withdraw = ctx.decisions.registerProvider(provider);
    else if (!allowed && withdraw) {
      withdraw();
      withdraw = undefined;
    }
  };
  ctx.effect(() => {
    const stop = session.subscribe(update);
    const stopCommunities = communities?.subscribe(update);
    update();
    return () => {
      stop();
      stopCommunities?.();
    };
  });
}

export function builderlabProvider(
  session: BuilderlabSession,
  loginAvailable: boolean,
  native: BuilderlabDecide | undefined = nativeBuilderlabDecide(),
  openIdentity?: () => void,
  communities?: CommunityDecisionSessions,
): DecisionProvider {
  /** The session that answers `community`: its sign-in server's, or with no
   * community list, `session` everywhere. */
  const sessionIn = (community: string | undefined) =>
    communities && community !== undefined
      ? communities.forCommunity(community)
      : session;
  const signedIn = (each: BuilderlabSession | undefined) =>
    each?.snapshot().status === "signed-in" ? each.credential() : undefined;
  // Builderlab reports whether this account may use decisions.
  // Only an explicit yes enables them; otherwise no call goes to Builderlab.
  const permitted = (credential: Credential) =>
    credential.account.canUseBuilderlabDecisions;
  // A sign-in in progress cannot answer yet. Permissions being re-read
  // are waited for only when the cached ones refuse: a grant may be new.
  const statusIn = (
    each: BuilderlabSession | undefined,
  ): DecisionProviderStatus => {
    const credential = signedIn(each);
    if (!native || !each || !credential) return "needs-setup";
    if (permitted(credential)) return "ready";
    return each.snapshot().checkingPermissions ? "checking" : "needs-setup";
  };
  return {
    id: "builderlab",
    label: "Builderlab",
    description: "Use your Builderlab account.",
    // Builderlab bills a community, so it cannot answer without one.
    status: (community?: string): DecisionProviderStatus =>
      communities && community === undefined
        ? "needs-setup"
        : statusIn(sessionIn(community)),
    subscribe: (listener) => {
      const stop = session.subscribe(listener);
      const stopCommunities = communities?.subscribe(listener);
      return () => {
        stop();
        stopCommunities?.();
      };
    },
    decide: async (request, { signal }) => {
      if (!native) return { outcome: "failed", reason: "unavailable" };
      const answering = sessionIn(request.community);
      if (!answering || !signedIn(answering))
        return { outcome: "failed", reason: "missing_credentials" };
      let credential: Credential;
      try {
        credential = await answering.freshCredential(signal);
      } catch {
        return { outcome: "failed", reason: "missing_credentials" };
      }
      if (!permitted(credential))
        return { outcome: "failed", reason: "unauthorized" };
      let reply: unknown;
      try {
        reply = await native(request, credential);
      } catch (error) {
        // Tauri rejects arguments that do not deserialize before any call:
        // a malformed request. Any other rejection is the IPC itself failing.
        return {
          outcome: "failed",
          reason: (error instanceof Error
            ? error.message
            : String(error)
          ).startsWith("invalid args")
            ? "invalid_request"
            : "service_error",
        };
      }
      if (!reply || typeof reply !== "object")
        return { outcome: "failed", reason: "invalid_response" };
      const { outcome, reason, model, answers } = reply as Record<
        string,
        unknown
      >;
      // A Builderlab 401 refuses this call only, never the sign-in that
      // other Builderlab features share: native asks the adapter whether a
      // NIP-FI session ended, and the broker owns its own.
      if (reason === "session_expired")
        return { outcome: "failed", reason: "unauthorized" };
      // The host checks the reply's shape and answers.
      return (
        outcome === "answered"
          ? { outcome, model, answers }
          : { outcome, reason }
      ) as DecisionReply;
    },
    // Only a community its sign-in server serves can use it.
    offered: (community) =>
      !communities || communities.forCommunity(community) !== undefined,
    // Communities on one sign-in server share its account.
    setupScope: (community) => communities?.account(community),
    Settings: ({ active, community }) => (
      <BuilderlabDecisionsLogin
        session={sessionIn(community) ?? session}
        available={loginAvailable}
        active={active}
        openIdentity={openIdentity}
        native={!!native}
      />
    ),
  };
}

/** The sign-in for one community's sign-in server, and whether its account
 * may use decisions. */
function BuilderlabDecisionsLogin({
  session,
  available,
  active,
  openIdentity,
  native,
}: {
  session: BuilderlabSession;
  available: boolean;
  active(): boolean;
  openIdentity: (() => void) | undefined;
  native: boolean;
}) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  return (
    <>
      <Login
        session={session}
        available={available}
        active={active}
        showHeading={false}
        openIdentity={openIdentity}
      />
      {native &&
        state.status === "signed-in" &&
        !state.checkingPermissions &&
        state.account?.canUseBuilderlabDecisions !== true && (
          <p role="status" className="m-0 text-body-sm text-secondary">
            This Builderlab account can’t use decisions. For access, contact
            your account administrator.
          </p>
        )}
    </>
  );
}
