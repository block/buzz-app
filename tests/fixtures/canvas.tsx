// The production canvas panel, view types and agent tools, for two people in
// one channel. Only the relay is replaced, by one that keeps the scene in
// memory; the plugin's own wiring to a session is not exercised here.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { BuzzClient } from "../../src/buzz-mcp/client";
import { CanvasPanel } from "../../src/bundled/canvas/CanvasPanel";
import { createCanvasChannel } from "../../src/bundled/canvas/store";
import { memoryCanvasRelay } from "../../src/bundled/canvas/testing";
import { canvasTools } from "../../src/bundled/canvas/tools";
import { createCanvasViews } from "../../src/bundled/canvas/view";
import { mapView } from "../../src/bundled/canvas/views/map";
import { browserView, webView } from "../../src/bundled/canvas/views/page";
import { videoView } from "../../src/bundled/canvas/views/video";
import "../../src/shared/styles/globals.css";

const CHANNEL = "11111111-1111-4111-8111-111111111111";
const people = {
  ["a".repeat(64)]: "Ada",
  ["b".repeat(64)]: "Ben",
  ["c".repeat(64)]: "Scout",
};
const [ada, ben, agent] = Object.keys(people);

const views = createCanvasViews();
views.register(browserView());
views.register(webView);
views.register(mapView());
views.register(videoView);
const relay = memoryCanvasRelay();

const tools = canvasTools(views, () => true);
const client = {
  pubkey: agent,
  query: relay.read,
  publish: relay.publish,
} as unknown as BuzzClient;
declare global {
  interface Window {
    canvasFixture: {
      /** Calls one of the agent's canvas tools as the agent "Scout". */
      agent(name: string, args?: Record<string, unknown>): Promise<unknown>;
    };
  }
}
window.canvasFixture = {
  async agent(name, args = {}) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`No tool ${name}`);
    return JSON.parse(
      (await tool.call(client, { channel: CHANNEL } as never, args)) as string,
    );
  },
};

function Seat({ viewer }: { viewer: string }) {
  const channel = createCanvasChannel({ channelId: CHANNEL, views, ...relay });
  return (
    <section
      aria-label={`${people[viewer]}'s screen`}
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        border: "1px solid var(--border-standard)",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <h2
        style={{
          margin: 0,
          padding: "6px 12px",
          fontSize: 12,
          borderBottom: "1px solid var(--border-standard)",
        }}
      >
        {people[viewer]}'s screen
      </h2>
      <div style={{ flex: 1, minHeight: 0 }}>
        <CanvasPanel
          channel={channel}
          views={views}
          viewer={viewer}
          name={(pubkey) => people[pubkey] ?? "Someone"}
        />
      </div>
    </section>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(
  <StrictMode>
    <main style={{ display: "flex", gap: 12, height: "100vh", padding: 12 }}>
      <Seat viewer={ada} />
      <Seat viewer={ben} />
    </main>
  </StrictMode>,
);
