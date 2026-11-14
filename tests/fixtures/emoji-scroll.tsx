import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
// Actual timeline, emoji plugin and folded events; no live relay.
import { Context } from "@deepseek-ai/cordis";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as emojiPlugin from "../../src/bundled/emoji";
import emojiManifest from "../../src/bundled/emoji/manifest.json";
import { ConversationService } from "../../src/features/conversation/service";
import { ChannelTimeline } from "../../src/features/messages/ChannelTimeline";
import { createRelaySession } from "../../src/features/relay/session";
import { foldMessages } from "../../src/features/relay/fold";
import { keypair, message } from "../../src/features/relay/testing";
import { createPluginManager } from "../../src/plugins/manager";
import "../../src/shared/styles/globals.css";
const ctx = new Context();
const manager = createPluginManager(ctx, {
  bundled: [
    { manifest: { ...emojiManifest, apiVersion: 1 }, module: emojiPlugin },
  ],
});
const extensions = new ConversationService(ctx);
window.addEventListener("pagehide", () => {
  void manager.dispose();
  void ctx.fiber.dispose();
});
const viewer = keypair(),
  relay = keypair();
// Each custom emoji appears once, so no earlier element has loaded its source.
const events = Array.from({ length: 60 }, (_, i) =>
  message(
    viewer,
    "emoji",
    `Message ${i}. :e${i}: ${"Reading continues between emoji. ".repeat(6)}`,
    1700000000 + i,
    [["emoji", `e${i}`, `https://emoji.test/${i}.gif`]],
  ),
);
const rows = foldMessages("emoji", relay.pubkey, events);
const owner = createRelaySession({
  viewer: viewer.pubkey,
  relayAuthor: relay.pubkey,
  media: (url) => url,
  query: async () => [],
  subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <div
        style={{
          height: 700,
          maxWidth: 1100,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <ChannelTimeline
          scope="emoji-scroll"
          channelId="emoji"
          queries={owner.session}
          extensions={extensions}
          window={{
            channelId: "emoji",
            rows,
            status: "ready",
            hasMore: false,
            loadingOlder: false,
            error: undefined,
            freshness: "fresh",
          }}
          onOpenLink={() => false}
        />
      </div>
    </ToastProvider>
  </StrictMode>,
);
