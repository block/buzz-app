import { Context } from "@deepseek-ai/cordis";
import { ShortcutsService } from "../../src/features/shortcuts/service";
import { createShortcutBindings } from "../../src/features/shortcuts/preferences";
import { ShortcutSettings } from "../../src/app/ShortcutSettings";
import type { PluginManager } from "../../src/plugins/manager";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "../../src/shared/styles/globals.css";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import { useChannelPanels } from "../../src/bundled/channels/useChannelPanels";
import { useConversationTabs } from "../../src/bundled/channels/useConversationTabs";
import { useChannelTabState } from "../../src/bundled/channels/useChannelTabState";
import { PanelWorkspace } from "../../src/features/panels/PanelWorkspace";
import { PanelDock } from "../../src/features/panels/PanelDock";
import { Dialog } from "../../src/shared/design-system/ui/Dialog";
import { PanelsService } from "../../src/features/panels/service";
import type { RelaySession } from "../../src/features/relay/session";
import type { RelayData } from "../../src/features/relay/service";
import type { ChannelSummary } from "../../src/features/relay/contracts";
import channelStyles from "../../src/bundled/channels/Channels.module.css";
import { apply } from "../../src/bundled/terminal";
import { nativeBridge } from "../../src/bundled/terminal/bridge";
import type { TerminalBridge } from "../../src/bundled/terminal/bridge";
import { SettingsCardsService } from "../../src/features/settings/service";
import type {
  Panels,
  RegisteredPanel,
  ChannelPanelContext,
} from "../../src/features/panels/service";

// Production plugin, controls and renderer; only the native shell is replaced.
const context: ChannelPanelContext = {
  scope: "fixture",
  viewer: "01".repeat(32),
  channelId: "terminal-fixture",
  channelName: "a-channel-with-a-long-name-for-terminal-layout",
  relayUrl: "wss://example.invalid",
  threadId: "ab".repeat(32),
};
let serial = 0;
let output = false;
let failClose = false;
let closing: Promise<void> | undefined;
let releaseClose: (() => void) | undefined;
let closePending = false;
let written = "";
let toggles = 0;
const bindings = createShortcutBindings(window);
const scope = new Context();
scope.provide("pluginStatus", {
  isActive: () => true,
  subscribe: () => () => {},
});
const shortcuts = new ShortcutsService(scope, window, bindings);
const settingsCards = new SettingsCardsService(scope);
Object.assign(window, {
  terminalPanel: {
    written: () => written,
    toggles: () => toggles,
    spawns: () => serial,
    dispose: () => scope.fiber.dispose(),
    holdClose() {
      closing = new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
    },
    closePending: () => closePending,
    releaseClose() {
      releaseClose?.();
      closing = undefined;
    },
  },
});
const bridge: TerminalBridge = {
  available: true,
  createOwner: async () => "fixture-owner",
  spawn: async () => {
    output = true;
    return String(++serial);
  },
  read: async () => {
    const data = new TextEncoder().encode(
      output ? "FIXTURE_SHELL_READY\r\n" : "",
    );
    output = false;
    return { data, exited: false };
  },
  write: async (_owner, _id, data) => {
    written += data;
  },
  resize: async () => {},
  close: async () => {
    closePending = true;
    try {
      await (closing ?? new Promise((resolve) => setTimeout(resolve, 250)));
      if (failClose)
        throw new Error("Fixture close failed. Try End session again.");
    } finally {
      closePending = false;
    }
  },
  closeOwner: async () => {},
};
Object.assign(nativeBridge, bridge);
const panels = new PanelsService(scope);
scope.provide("relay", {
  snapshot: () => ({
    scope: context.scope,
    viewer: context.viewer,
    status: "ready",
  }),
} as unknown as typeof scope.relay);
await scope
  .extend({ pluginOwner: { id: "buzz.terminal", revision: "fixture" } })
  .plugin((ctx) => apply(ctx))
  .await();
const pluginState = { configuration: { status: "loading" } };
const plugins = {
  subscribe: () => () => {},
  snapshot: () => pluginState,
} as unknown as Pick<PluginManager, "subscribe" | "snapshot">;
const contribution = panels.snapshot()[0];
if (!contribution?.channelLauncher)
  throw new Error("Missing terminal contribution");
const Launcher = contribution.channelLauncher;
const Content = contribution.component;
const FontSettings = settingsCards
  .snapshot()
  .find((card) => card.title === "Terminal")?.component;
if (!FontSettings) throw new Error("Missing terminal settings card");
function Fixture() {
  useKeyboardFocusVisibility();
  const [visible, show] = useState(false);
  const [settings, showSettings] = useState(false);
  const [fontSettings, showFontSettings] = useState(false);
  return (
    <>
      <button type="button" onClick={() => showFontSettings((value) => !value)}>
        Terminal font settings
      </button>
      {fontSettings && FontSettings && (
        <div style={{ maxWidth: "48rem", padding: "var(--space-4)" }}>
          <FontSettings active={() => true} />
        </div>
      )}
      <button type="button" onClick={() => showSettings((value) => !value)}>
        Shortcut settings
      </button>
      {settings && (
        // Bounded, so the read-only formatting group can't push the drawer
        // out of the viewport, where xterm has no rows to render.
        <div style={{ maxHeight: 200, overflow: "auto" }}>
          <ShortcutSettings
            shortcuts={shortcuts}
            bindings={bindings}
            plugins={plugins}
          />
        </div>
      )}
      <button
        type="button"
        onClick={() => {
          document.documentElement.dataset.colorMode =
            document.documentElement.dataset.colorMode === "dark"
              ? "light"
              : "dark";
        }}
      >
        Toggle theme
      </button>
      <button
        type="button"
        onClick={() =>
          document.documentElement.style.setProperty("--buzz-text-scale", "1.5")
        }
      >
        Enlarge text
      </button>
      <button
        type="button"
        onClick={() => {
          failClose = !failClose;
        }}
      >
        Toggle close failure
      </button>
      <div className={channelStyles.root}>
        <nav
          className={channelStyles.heading}
          aria-label="Legacy channel header"
        >
          <Launcher
            context={context}
            pressed={visible}
            available={() => true}
            toggle={() => {
              toggles++;
              show((value) => !value);
            }}
          />
        </nav>
        {visible && (
          <section
            aria-label="Terminal drawer"
            className={channelStyles.channelDrawer}
            style={{
              width: "100%",
              height: new URLSearchParams(location.search).has("short")
                ? 180
                : 360,
            }}
          >
            <Content
              target="fixture"
              channelContext={context}
              close={() => show(false)}
            />
          </section>
        )}
      </div>
    </>
  );
}
// Motion coverage exercises the production drawer owner as well as the plugin.
const registered: RegisteredPanel = {
  ...contribution,
  key: "buzz.terminal/terminal",
  pluginId: "buzz.terminal",
  revision: "fixture",
};
const entries = [registered];
const motionPanels: Panels = {
  snapshot: () => entries,
  subscribe: () => () => {},
  register: () => {},
  resolve: () => registered,
  requestOpen: () => false,
  handleOpenRequests: () => () => {},
};
function MotionFixture() {
  useKeyboardFocusVisibility();
  const drawer = useChannelPanels(motionPanels, context);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {drawer.launchers}
      <div style={{ flex: 1 }}>Conversation</div>
      {drawer.content}
    </div>
  );
}

// Real contribution disposal, channel openings and tab cleanup own movement.
const channel = {
  id: context.channelId,
  name: context.channelName,
} as ChannelSummary;
const otherChannel = { ...channel, id: "other-channel", name: "Other channel" };
const channels = [channel, otherChannel];
const session = {
  viewer: context.viewer,
  channels: {
    list: () => ({ channels }),
    window: () => ({ rows: [] }),
  },
} as unknown as RelaySession;
const relayState = { status: "ready", session };
const relay = { snapshot: () => relayState } as unknown as RelayData;
function PlacementFixture() {
  const [current, select] = useState(channel);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <button
        type="button"
        onClick={() => select(current === channel ? otherChannel : channel)}
      >
        Switch channel
      </button>
      <PlacementWorkspace key={current.id} current={current} />
    </div>
  );
}
function PlacementWorkspace({ current }: { current: ChannelSummary }) {
  useKeyboardFocusVisibility();
  const [settings, showSettings] = useState(false);
  const state = useChannelTabState(session, current.id);
  const workspace = useConversationTabs({
    state,
    relay,
    session,
    panels,
    current,
    channels,
    profiles: new Map(),
    scope: context.scope,
    conversationIcon: () => null,
    leadingIds: [],
    continuingVisit: true,
    mainPane: true,
    isLive: () => true,
    openLink: () => false,
  });
  const hasPanel = !!(workspace.drawer.side || workspace.items.length);
  return (
    <div
      className={channelStyles.root}
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
      }}
    >
      <button type="button" onClick={() => showSettings(true)}>
        Terminal settings
      </button>
      <button
        type="button"
        onClick={() => {
          document.documentElement.dataset.colorMode =
            document.documentElement.dataset.colorMode === "dark"
              ? "light"
              : "dark";
        }}
      >
        Toggle theme
      </button>
      {workspace.drawer.launchers}
      <div className={channelStyles.board} style={{ flex: 1, minHeight: 0 }}>
        <div className={channelStyles.conversation}>
          <div style={{ flex: 1 }}>Conversation</div>
          {workspace.drawer.content}
        </div>
        <PanelDock
          open={hasPanel && state.paneOpen}
          keepMounted={
            state.entries.length > 0 || (hasPanel && !state.paneOpen)
          }
          className={channelStyles.panelStack}
        >
          {hasPanel && (
            <>
              {workspace.items.length > 0 && (
                <div className={channelStyles.retainedPanel}>
                  <PanelWorkspace
                    value={workspace.selectedTab}
                    select={workspace.selectPanelTab}
                    items={workspace.items}
                  />
                </div>
              )}
              {workspace.drawer.side && (
                <div className={channelStyles.retainedPanel}>
                  {workspace.drawer.side}
                </div>
              )}
            </>
          )}
        </PanelDock>
      </div>
      <Dialog
        open={settings}
        onOpenChange={showSettings}
        title="Terminal settings"
      >
        {FontSettings && <FontSettings active={() => settings} />}
      </Dialog>
    </div>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(
  new URLSearchParams(location.search).has("placement") ? (
    <StrictMode>
      <PlacementFixture />
    </StrictMode>
  ) : new URLSearchParams(location.search).has("motion") ? (
    <MotionFixture />
  ) : (
    <Fixture />
  ),
);
