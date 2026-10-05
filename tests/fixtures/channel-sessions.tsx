import { AppShell } from "../../src/app/shell/AppShell";
import { createCommunities } from "../../src/features/communities/service";
import { AccountActionsService } from "../../src/features/account-actions/service";
import { writeView } from "../../src/shared/view-state";
import type { Key } from "../../src/features/relay/testing";
import { getPublicKey } from "nostr-tools";
import { readChannelSessionDraft } from "../../src/bundled/sessions/channel-session-draft";
import { Context } from "@deepseek-ai/cordis";
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import { PluginRuntime } from "../../src/plugins/runtime";
import { ConversationService } from "../../src/features/conversation/service";
import { PanelsService } from "../../src/features/panels/service";
import { ChannelSidebar } from "../../src/features/channel-navigation/ChannelSidebar";
import { ChannelNavigationProvider } from "../../src/features/channel-navigation/ChannelNavigationState";
import { ChannelsPage } from "../../src/bundled/channels/ChannelsPage";
import * as linksPlugin from "../../src/bundled/links/index";
import * as mentionsPlugin from "../../src/bundled/mentions/index";
import * as activityPlugin from "../../src/bundled/agent-activity/index";
import * as sessionsPlugin from "../../src/bundled/sessions/index";
import { PagesService } from "../../src/features/pages/service";
import { provideNavigation } from "../../src/features/navigation/service";
import { sessionsData } from "./channel-sessions-data";
import "../../src/shared/styles/globals.css";

const { fixtureSeeds: seeds, fixtureRowCount } = window as unknown as {
  fixtureSeeds?: number[][];
  fixtureRowCount?: number;
};
const identities = seeds?.map((seed) => {
  const secret = Uint8Array.from(seed);
  return { secret, pubkey: getPublicKey(secret) };
}) as [Key, Key, Key, Key] | undefined;
const data = sessionsData({
  agentActivity: true,
  firstTitle: new URL(location.href).searchParams.has("long-title")
    ? "Review the release checklist ".repeat(12)
    : undefined,
  firstThreadReplies: new URL(location.href).searchParams.has("inline")
    ? 28
    : 1,
  rowCount:
    new URL(location.href).searchParams.has("share") ||
    new URL(location.href).searchParams.has("inline")
      ? 2
      : seeds
        ? (fixtureRowCount ?? 0)
        : 18,
  canonicalScope: true,
  ...(identities ? { identities } : {}),
});
writeView(data.scope, "selected-channel", "general");
const ctx = new Context();
const runtime = new PluginRuntime(ctx, async (plugin) =>
  plugin.manifest.id === "buzz.links"
    ? linksPlugin
    : plugin.manifest.id === "buzz.mentions"
      ? mentionsPlugin
      : plugin.manifest.id === "buzz.agent-activity"
        ? activityPlugin
        : sessionsPlugin,
);
// Opt in only for actual shell visibility/focus regression coverage.
const shellContext = new URL(location.href).searchParams.has("shell")
  ? new Context()
  : undefined;
const shellServices = shellContext && {
  communities: createCommunities(shellContext, false),
  accountActions: new AccountActionsService(ctx),
};
const pages = new PagesService(ctx);
const navigationHost = provideNavigation(ctx, undefined);
ctx.provide("relay", data.relay);
const conversation = new ConversationService(ctx);
const panels = new PanelsService(ctx);
const emptyProviders = [] as const;
const providers = {
  snapshot: () => emptyProviders,
  subscribe: () => () => {},
  register: () => {},
};
const plugin = {
  manifest: {
    id: "buzz.sessions",
    name: "Sessions",
    apiVersion: 1 as const,
  },
  enabled: true,
  source: "bundled" as const,
  revision: "one",
  previous: null,
  error: null,
};
const mentions = {
  ...plugin,
  manifest: { ...plugin.manifest, id: "buzz.mentions", name: "Mentions" },
};
const links = {
  ...plugin,
  manifest: { ...plugin.manifest, id: "buzz.links", name: "Links" },
};
const activity = {
  ...plugin,
  manifest: {
    ...plugin.manifest,
    id: "buzz.agent-activity",
    name: "Agent Activity",
  },
};
runtime.reconcile([plugin, mentions, links]);
Object.assign(window, {
  sessionsFixture: {
    report: data.report,
    telemetry: data.telemetry,
    activityState: data.session.agentActivity.snapshot,
    enableActivity: () =>
      runtime.reconcile([plugin, mentions, links, activity]),
    disableActivity: () => runtime.reconcile([plugin, mentions, links]),
    scope: data.scope,
    viewer: data.viewer,
    holdPublication: data.holdPublication,
    ingest: data.ingest,
    replyTo: data.replyTo,
    saved: () => readChannelSessionDraft(data.scope, "general"),
    member: data.member,
    rows: data.rows,
    threadSnapshot: data.threadSnapshot,
    refreshThread: data.refreshThread,
    failThread: data.failThread,
    disable: () => runtime.reconcile([mentions, links]),
    enable: () => runtime.reconcile([plugin, mentions, links]),
    replace: data.replace,
    revoke: data.revoke,
    renameChannel: data.renameChannel,
  },
});
// Match the host's modality and appearance attributes, without importing startup.
document.addEventListener("keydown", (event) => {
  if (event.key === "Tab" || event.key.startsWith("Arrow"))
    document.documentElement.setAttribute("data-keyboard-navigation", "");
});
document.addEventListener("pointerdown", () =>
  document.documentElement.removeAttribute("data-keyboard-navigation"),
);
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
function FixtureApp() {
  const registered = useSyncExternalStore(
    pages.subscribe,
    pages.snapshot,
    pages.snapshot,
  );
  const navigationState = useSyncExternalStore(
    navigationHost.navigation.subscribe,
    navigationHost.navigation.snapshot,
  );
  const [presentation, setPresentation] = useState<{
    attempt: typeof navigationState.attempt;
    request: ReturnType<typeof navigationHost.request>["request"];
  }>();
  useLayoutEffect(() => {
    const { request, dispose } = navigationHost.request(
      navigationState.attempt,
      {
        valid: () => true,
        subscribe: () => () => {},
      },
    );
    setPresentation({ attempt: navigationState.attempt, request });
    return dispose;
  }, [navigationState.attempt]);
  const navigation =
    presentation?.attempt === navigationState.attempt
      ? presentation.request
      : undefined;
  const [privatePage, setPrivatePage] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: match the host drawer closing on each navigation attempt.
  useEffect(() => setNavigationOpen(false), [navigationState.attempt]);
  const PrivatePage = registered[0]?.component;
  if (shellServices)
    return (
      <ChannelNavigationProvider relay={data.relay}>
        <AppShell
          {...shellServices}
          pages={registered}
          selected="buzz.channels/channels"
          navigationAttempt={navigationState.attempt.id}
          onSelect={() => {}}
          tone="fixture"
          workspace
          sidebar={() => (
            <ChannelSidebar
              relay={data.relay}
              navigator={navigationHost.navigation}
              providers={providers}
              target={navigationState.entry.target}
              channelDirectories={conversation.channelDirectories}
              sessionsEnabled={registered.some(
                (page) => page.pluginId === "buzz.sessions",
              )}
              agentsEnabled={false}
            />
          )}
        >
          <ChannelsPage
            providers={providers}
            navigator={navigationHost.navigation}
            navigation={navigation}
            extensions={conversation}
            relay={data.relay}
            panels={panels}
            pages={pages}
          />
        </AppShell>
      </ChannelNavigationProvider>
    );
  return (
    <ChannelNavigationProvider relay={data.relay}>
      <main
        style={{
          height: "100dvh",
          padding: "var(--space-2)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <nav
          aria-label="Fixture destinations"
          style={{ display: "flex", flex: "none" }}
        >
          <button
            type="button"
            onClick={() => setNavigationOpen((open) => !open)}
            aria-expanded={navigationOpen}
          >
            Toggle fixture navigation
          </button>
          <button type="button" onClick={() => setPrivatePage(false)}>
            Messages fixture
          </button>
          <button type="button" onClick={() => setPrivatePage(true)}>
            Private Sessions fixture
          </button>
        </nav>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            position: "relative",
          }}
        >
          <div className="shell-navigation" data-expanded={navigationOpen}>
            <ChannelSidebar
              relay={data.relay}
              navigator={navigationHost.navigation}
              providers={providers}
              target={navigationState.entry.target}
              channelDirectories={conversation.channelDirectories}
              sessionsEnabled={registered.some(
                (page) => page.pluginId === "buzz.sessions",
              )}
              agentsEnabled={false}
            />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {privatePage ? (
              PrivatePage && <PrivatePage />
            ) : (
              <ChannelsPage
                providers={providers}
                navigator={navigationHost.navigation}
                navigation={navigation}
                extensions={conversation}
                relay={data.relay}
                panels={panels}
                pages={pages}
              />
            )}
          </div>
        </div>
      </main>
    </ChannelNavigationProvider>
  );
}
createRoot(root).render(
  <StrictMode>
    <FixtureApp />
  </StrictMode>,
);
window.addEventListener("pagehide", () => {
  data.dispose();
  void runtime.dispose();
  void ctx.fiber.dispose();
  void shellContext?.fiber.dispose();
});
