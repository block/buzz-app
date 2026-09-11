import { useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "../../src/shared/styles/globals.css";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import channelStyles from "../../src/bundled/channels/Channels.module.css";
import { apply } from "../../src/bundled/terminal";
import { nativeBridge } from "../../src/bundled/terminal/bridge";
import type { TerminalBridge } from "../../src/bundled/terminal/bridge";
import type {
  Panel,
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
const bridge: TerminalBridge = {
  available: true,
  createOwner: async () => "fixture-owner",
  spawn: async () => {
    output = true;
    return String(++serial);
  },
  read: async () => {
    const data = output
      ? [...new TextEncoder().encode("FIXTURE_SHELL_READY\r\n")]
      : [];
    output = false;
    return { data, exited: false };
  },
  write: async () => {},
  resize: async () => {},
  close: async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (failClose)
      throw new Error("Fixture close failed. Try End session again.");
  },
  closeOwner: async () => {},
};
Object.assign(nativeBridge, bridge);
let contribution: Panel | undefined;
apply({
  panels: {
    register: (panel: Panel) => {
      contribution = panel;
    },
  },
  shortcuts: { register: () => {} },
  effect: () => {},
  relay: {
    snapshot: () => ({
      scope: context.scope,
      viewer: context.viewer,
      status: "ready",
    }),
  },
} as unknown as Parameters<typeof apply>[0]);
if (!contribution?.channelLauncher)
  throw new Error("Missing terminal contribution");
const Launcher = contribution.channelLauncher;
const Content = contribution.component;
function Fixture() {
  useKeyboardFocusVisibility();
  const [visible, show] = useState(false);
  return (
    <>
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
            toggle={() => show((value) => !value)}
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
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<Fixture />);
