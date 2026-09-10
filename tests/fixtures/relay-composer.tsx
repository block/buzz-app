// Local-only browser fixture. Every event is signed with ephemeral test keys; no network relay.
import { createRoot } from "react-dom/client";
import { Context } from "@deepseek-ai/cordis";
import { ChannelsPage } from "../../src/bundled/channels/ChannelsPage";
import { PanelsService } from "../../src/features/panels/service";
import { createRelaySession } from "../../src/features/relay/session";
import {
  keypair,
  signed,
  bounds,
  metadata,
  roster,
  profile,
} from "../../src/features/relay/testing";
import type { RelayEvent } from "../../src/features/relay/events";
import type { OutgoingEvent } from "../../src/features/relay/outbox";
import {
  browserOutboxStorage,
  PublishRejected,
} from "../../src/features/relay/outbox";
import "../../src/shared/styles/globals.css";
const viewer = keypair(),
  relay = keypair();
const confirmed: RelayEvent[] = [];
const rejected = new Set<string>();
let saved: readonly OutgoingEvent[] = [];
const root = new Context();
root.provide("pluginStatus", {
  isActive: () => true,
  subscribe: () => () => {},
});
const owner = createRelaySession(
  {
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    async query(filters) {
      const filter = filters[0];
      if (!filter) throw new Error("Missing fixture query filter");
      if (filter.kinds?.includes(39002) || filter.kinds?.includes(39000))
        return [
          roster(relay, "general", [viewer.pubkey]),
          metadata(relay, "general", "General"),
        ];
      if (filter.kinds?.includes(0)) return [profile(viewer, { name: "You" })];
      if (filter.ids)
        return confirmed.filter((event) => filter.ids?.includes(event.id));
      return [
        ...confirmed,
        bounds(relay, "general", "head", {
          has_more: false,
          next_cursor: null,
        }),
      ];
    },
    writer: {
      kinds: [9],
      async sign(event) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return signed(viewer, event);
      },
      async publish(event) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        if (event.content.includes("reject") && !rejected.has(event.id)) {
          rejected.add(event.id);
          throw new PublishRejected("Fixture relay rejected this message once");
        }
        if (!confirmed.some((old) => old.id === event.id))
          confirmed.push(event);
      },
    },
  },
  {
    outboxStorage: new URLSearchParams(location.search).has("durable")
      ? browserOutboxStorage(`fixture:${crypto.randomUUID()}`)
      : {
          load: () => saved,
          save: (next) => {
            saved = next;
          },
        },
  },
);
const snapshot = Object.freeze({
  status: "ready" as const,
  generation: 0,
  session: owner.session,
  viewer: viewer.pubkey,
});
const data = {
  snapshot: () => snapshot,
  subscribe: () => () => {},
  retry() {},
  disconnect() {},
  clearCache: owner.clearCache,
};
const container = document.getElementById("root");
if (!container) throw new Error("Missing fixture root");
createRoot(container).render(
  <div style={{ height: "100vh" }}>
    <ChannelsPage relay={data} panels={new PanelsService(root)} />
  </div>,
);
