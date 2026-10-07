import { useSyncExternalStore } from "react";
import { BestieIcon } from "../../shared/design-system/icons";
import type { PluginModule } from "../../plugins/api";
import type { Conversation } from "../../features/conversation/service";
import type { Navigation } from "../../features/navigation/controller";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { Button } from "../../shared/design-system/ui/Button";
import { BestieChat } from "./BestieChat";
import { createLocalBestie } from "./setup";

export const inject = [
  "pages",
  "relay",
  "agentControl",
  "conversation",
  "navigation",
];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const control = ctx.agentControl;
  const conversation = ctx.conversation;
  const navigation = ctx.navigation;
  const bestie = createLocalBestie(relay, control);
  ctx.effect(() => () => bestie.dispose());
  ctx.pages.register({
    id: "bestie",
    title: "Bestie",
    layout: "workspace",
    primary: true,
    component: () => (
      <BestiePage
        bestie={bestie}
        conversation={conversation}
        navigation={navigation}
      />
    ),
  });
};

function BestiePage({
  bestie,
  conversation,
  navigation,
}: {
  bestie: ReturnType<typeof createLocalBestie>;
  conversation: Conversation;
  navigation: Navigation;
}) {
  const state = useSyncExternalStore(
    bestie.subscribe,
    bestie.snapshot,
    bestie.snapshot,
  );
  const record = state.record;
  const agent = record?.agent;
  const connection = state.connection;
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
        {state.status === "ready" && record?.agent && connection ? (
          <>
            <p className="px-6 py-3 text-body-sm text-muted" role="status">
              {state.message}
            </p>
            <BestieChat
              session={connection.session}
              scope={connection.scope ?? ""}
              owner={record.owner}
              channelId={record.home.id}
              agentPubkey={record.agent.pubkey}
              conversation={conversation}
            />
          </>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-auto p-6 text-center">
            <img src="/bestie.png" alt="" className="size-20 object-contain" />
            <h2 className="text-heading">Meet your Bestie</h2>
            <p
              className="max-w-sm text-body-sm text-muted"
              role={state.status === "error" ? "alert" : "status"}
            >
              {state.message}
            </p>
            {state.status === "error" && (
              <Button onClick={bestie.retry}>Retry setup</Button>
            )}
            {state.status === "error" && record && agent && (
              <Button
                variant="outline"
                onClick={() => {
                  void navigation.open({
                    version: 1,
                    kind: "page",
                    pluginId: "buzz.agents",
                    pageId: "agents",
                    scope: {
                      viewer: record.owner,
                      communityOrigin: record.origin,
                    },
                    route: {
                      version: 1,
                      params: { pubkey: agent.pubkey },
                    },
                  });
                }}
              >
                Edit Local Bestie
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => {
                void navigation.open({
                  version: 1,
                  kind: "settings",
                  section: "agents",
                });
              }}
            >
              Agent settings
            </Button>
          </div>
        )}
      </div>
    </FullPageSurface>
  );
}
