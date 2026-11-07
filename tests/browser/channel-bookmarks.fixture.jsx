import * as React from "react";
import { createRoot } from "react-dom/client";
import { apply } from "../../examples/plugins/channel-bookmarks/dist/plugin.js";
import { useChannelPanels } from "../../src/bundled/channels/useChannelPanels";
import styles from "../../src/bundled/channels/Channels.module.css";
import "../../src/shared/styles/globals.css";

// Real Channels launcher/side-panel host and built external plugin; isolated Canvas.
const channelContext = {
  scope: "fixture",
  viewer: "viewer",
  channelId: "alpha",
  channelName: "Alpha",
  relayUrl: "wss://example.test",
};
const channels = { channels: [{ id: "alpha", members: ["viewer"] }] };
let head = {
  id: "one",
  content: `## Channel bookmarks\n${Array.from({ length: 12 }, (_, i) => `- [Bookmark ${i + 1}](https://example.com/${i + 1})`).join("\n")}\n`,
};
const state = {
  status: "ready",
  scope: "fixture",
  generation: 1,
  session: {
    viewer: "viewer",
    channels: { list: () => channels, subscribeList: () => () => {} },
    canvas: {
      available: true,
      read: async () => head,
      save: async (_id, content) => (head = { id: `${head.id}-next`, content }),
    },
  },
};
let registration;
apply({
  react: React,
  effect: (fn) => fn(),
  relay: { snapshot: () => state, subscribe: () => () => {} },
  panels: {
    register: (panel) => {
      registration = {
        ...panel,
        key: "fixture.bookmarks",
        pluginId: "local.channel-bookmarks",
        revision: "fixture",
      };
    },
  },
});
const available = [registration];
const panels = {
  snapshot: () => available,
  subscribe: () => () => {},
  register: () => {},
  resolve: () => registration,
  requestOpen: () => false,
  handleOpenRequests: () => () => {},
};
function Fixture() {
  const drawer = useChannelPanels(panels, channelContext);
  return (
    <div className={styles.root} style={{ height: "100dvh" }}>
      <div className={styles.board}>
        <div className={styles.conversation}>
          <header className="panel-header">{drawer.launchers}</header>
          <p>Conversation</p>
        </div>
        {drawer.side && <div className={styles.panelStack}>{drawer.side}</div>}
        {drawer.content}
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<Fixture />);
