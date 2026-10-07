import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { BestieIcon } from "../../shared/design-system/icons";
import type { PluginModule } from "../../plugins/api";
import type { Navigation } from "../../features/navigation/controller";
import type { CommunityReader } from "../../features/communities/service";
import { communityDestination } from "../../features/communities/destination";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { Button } from "../../shared/design-system/ui/Button";
import { Login } from "../builderlab/login/Login";
import { createRemoteBestie } from "./setup";

export const inject = ["pages", "relay", "navigation", "communityReader"];
export const apply: PluginModule["apply"] = (ctx) => {
  let bestie: ReturnType<typeof createRemoteBestie> | undefined;
  const listeners = new Set<() => void>();
  const source = {
    snapshot: () => bestie,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  // Keep the page available when Builderlab is disabled. Cordis owns the
  // consumer's lifetime when its existing provider appears or disappears.
  ctx.inject(["builderlab"], (child) => {
    const current = createRemoteBestie(child.builderlab, ctx.relay);
    bestie = current;
    for (const listener of listeners) listener();
    child.effect(() => () => {
      current.dispose();
      bestie = undefined;
      for (const listener of listeners) listener();
    });
  });
  ctx.effect(() => () => listeners.clear());
  ctx.pages.register({
    id: "bestie",
    title: "Bestie",
    layout: "workspace",
    primary: true,
    component: () => {
      const current = useSyncExternalStore(
        source.subscribe,
        source.snapshot,
        source.snapshot,
      );
      return (
        <BestiePage
          bestie={current}
          navigation={ctx.navigation}
          communityReader={ctx.communityReader}
        />
      );
    },
  });
};

export function BestiePage({
  bestie,
  navigation,
  communityReader,
}: {
  bestie?: ReturnType<typeof createRemoteBestie> | undefined;
  navigation: Navigation;
  communityReader?: CommunityReader | undefined;
}) {
  return (
    <FullPageSurface aria-label="Bestie">
      <div className="flex h-full min-h-0 flex-col">
        <PanelHeader
          title={
            <PanelHeaderLabel
              title="Bestie"
              icon={<BestieIcon size="1rem" />}
            />
          }
        />
        <div className="min-h-0 flex-1 overflow-auto p-6">
          {bestie ? (
            <ConnectedBestie
              bestie={bestie}
              navigation={navigation}
              communityReader={communityReader}
            />
          ) : (
            <div className="flex flex-col items-center gap-4 text-center">
              <img
                src="/bestie.png"
                alt=""
                className="size-20 object-contain"
              />
              <h2 className="text-heading">Meet your Bestie</h2>
              <p className="text-body-sm text-muted" role="status">
                Enable Builderlab in Settings → Plugins, then sign in to set up
                your remote Bestie.
              </p>
              <Button
                variant="outline"
                onClick={() =>
                  void navigation.open({
                    version: 1,
                    kind: "settings",
                    section: "plugins",
                  })
                }
              >
                Plugin settings
              </Button>
            </div>
          )}
        </div>
      </div>
    </FullPageSurface>
  );
}

function ConnectedBestie({
  bestie,
  navigation,
  communityReader,
}: {
  bestie: ReturnType<typeof createRemoteBestie>;
  navigation: Navigation;
  communityReader?: CommunityReader | undefined;
}) {
  const state = useSyncExternalStore(
    bestie.subscribe,
    bestie.snapshot,
    bestie.snapshot,
  );
  const record = state.record;
  const [navigationError, setNavigationError] = useState("");
  const lifetime = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const connection = state.connection;
  const openChat = useCallback(async () => {
    const controller = lifetime.current;
    if (
      !record?.agent ||
      !state.community ||
      !connection ||
      !controller ||
      controller.signal.aborted
    )
      return;
    const active = () =>
      !controller.signal.aborted &&
      bestie.snapshot().connection === connection &&
      bestie.snapshot().record === record &&
      bestie.snapshot().status === "ready";
    try {
      const details = await connection.session.channelDetails.load(
        record.channelId,
        controller.signal,
      );
      if (!active()) return;
      const home = await connection.session.workSessions.refreshMembership(
        record.channelId,
      );
      if (!active()) return;
      if (
        details.visibility !== "private" ||
        home.channelType !== "stream" ||
        home.archived ||
        !home.members?.includes(record.owner) ||
        !home.members.includes(record.agent.pubkey) ||
        home.members.some(
          (member) =>
            member !== record.owner && member !== record.agent?.pubkey,
        )
      )
        throw new Error(
          "Bestie's channel must be private and contain only you and Bestie. Review its members before continuing.",
        );
      const result = await navigation.open(
        {
          version: 1,
          kind: "conversation",
          channelId: record.channelId,
          scope: { viewer: record.owner, communityOrigin: state.community },
        },
        { replace: true },
      );
      if (active())
        setNavigationError(
          result.status === "failed"
            ? "Could not open Bestie's channel. Try again."
            : "",
        );
    } catch (error) {
      if (active())
        setNavigationError(
          error instanceof Error
            ? error.message
            : "Could not open Bestie's channel. Try again.",
        );
    }
  }, [bestie, navigation, connection, record, state.community]);
  useEffect(() => {
    if (state.status !== "ready") return;
    void openChat();
  }, [openChat, state.status]);
  return (
    <div className="flex min-h-0 flex-col gap-4">
      <p
        className="text-body-sm text-muted"
        role={state.status === "error" ? "alert" : "status"}
      >
        {state.message}
      </p>
      {state.status === "ready" && record?.agent ? (
        <>
          {navigationError && <p role="alert">{navigationError}</p>}
          <Button variant="prominent" onClick={() => void openChat()}>
            Open Bestie conversation
          </Button>
        </>
      ) : state.prerequisite === "signin" ? (
        <Login
          session={bestie.login}
          available={bestie.loginAvailable}
          unavailableReason={bestie.loginUnavailableReason}
          active={() => true}
        />
      ) : state.prerequisite === "community" ? (
        communityReader && (
          <CommunityChoices reader={communityReader} navigation={navigation} />
        )
      ) : (
        <>
          <p className="text-body-sm text-muted">
            Setup creates or reuses the remote agent named Bestie, updates its
            instructions, creates a private channel, and invites it. If you
            already customized Bestie's instructions, preserve them before
            continuing.
          </p>
          <div className="flex flex-wrap gap-3">
            {state.status === "choose-agent"
              ? state.candidates?.map((agent) => (
                  <Button
                    key={agent.pubkey}
                    variant="outline"
                    onClick={() => void bestie.setup(agent.pubkey)}
                  >
                    Use {agent.name} · {agent.pubkey.slice(0, 12)}
                  </Button>
                ))
              : state.status !== "unavailable" && (
                  <Button
                    variant="prominent"
                    loading={state.status === "busy"}
                    onClick={() => void bestie.setup()}
                  >
                    {state.status === "error"
                      ? "Retry Bestie setup"
                      : "Set up Bestie"}
                  </Button>
                )}
          </div>
        </>
      )}
    </div>
  );
}

function CommunityChoices({
  reader,
  navigation,
}: {
  reader: CommunityReader;
  navigation: Navigation;
}) {
  const state = useSyncExternalStore(
    reader.subscribe,
    reader.snapshot,
    reader.snapshot,
  );
  const viewer = state.viewer;
  return (
    <div className="flex flex-wrap gap-3">
      {viewer &&
        state.memberships.map((community) => (
          <Button
            key={community.id}
            variant="outline"
            onClick={() =>
              void navigation.open(
                {
                  version: 1,
                  kind: "page",
                  pluginId: "buzz.bestie",
                  pageId: "bestie",
                  scope: {
                    viewer,
                    communityOrigin: communityDestination(community.id).url,
                  },
                },
                { replace: true },
              )
            }
          >
            Use {community.name}
          </Button>
        ))}
    </div>
  );
}
