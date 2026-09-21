import { Context } from "@deepseek-ai/cordis";
import { StrictMode, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { PluginRuntime } from "../../src/plugins/runtime";
import { ConversationService } from "../../src/features/conversation/service";
import { PanelsService } from "../../src/features/panels/service";
import { ChannelsPage } from "../../src/bundled/channels/ChannelsPage";
import * as sessionsPlugin from "../../src/bundled/sessions/index";
import { PagesService } from "../../src/features/pages/service";
import { provideNavigation } from "../../src/features/navigation/service";
import { sessionsData } from "./channel-sessions-data";
import "../../src/shared/styles/globals.css";

const data = sessionsData({ rowCount: 18 });
const ctx = new Context();
const runtime = new PluginRuntime(ctx, async () => sessionsPlugin);
const pages = new PagesService(ctx);
provideNavigation(ctx, undefined);
ctx.provide("relay", data.relay);
const conversation = new ConversationService(ctx);
const panels = new PanelsService(ctx);
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
runtime.reconcile([plugin]);
Object.assign(window, {
  sessionsFixture: {
    report: data.report,
    rows: data.rows,
    threadSnapshot: data.threadSnapshot,
    refreshThread: data.refreshThread,
    failThread: data.failThread,
    disable: () => runtime.reconcile([]),
    enable: () => runtime.reconcile([plugin]),
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
  const [privatePage, setPrivatePage] = useState(false);
  const PrivatePage = registered[0]?.component;
  return (
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
        <button type="button" onClick={() => setPrivatePage(false)}>
          Messages fixture
        </button>
        <button type="button" onClick={() => setPrivatePage(true)}>
          Private Sessions fixture
        </button>
      </nav>
      <div style={{ flex: 1, minHeight: 0 }}>
        {privatePage ? (
          PrivatePage && <PrivatePage />
        ) : (
          <ChannelsPage
            extensions={conversation}
            relay={data.relay}
            panels={panels}
          />
        )}
      </div>
    </main>
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
});
