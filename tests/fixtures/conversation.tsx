// Automated boundary proof only. No live broker, persistent messages or real keys.
import { Context } from "@deepseek-ai/cordis";
import {
  StrictMode,
  useState,
  useSyncExternalStore,
  useLayoutEffect,
} from "react";
import { createRoot } from "react-dom/client";
import { createPluginManager } from "../../src/plugins/manager";
import { PagesService } from "../../src/features/pages/service";
import { PanelsService } from "../../src/features/panels/service";
import { ConversationService } from "../../src/features/conversation/service";
import { bundledPlugins } from "../../src/bundled";
import { createRelaySession } from "../../src/features/relay/session";
import { PublishRejected } from "../../src/features/relay/outbox";
import {
  keypair,
  message,
  signed,
  metadata,
  roster,
  profile,
  bounds,
} from "../../src/features/relay/testing";
import type { RelayEvent } from "../../src/features/relay/events";
import type { PluginStorage } from "../../src/plugins/storage";
import "../../src/shared/styles/globals.css";

const viewer = keypair(),
  relayKey = keypair(),
  member = keypair();
const report = { signed: [] as RelayEvent[], published: [] as RelayEvent[] };
let failCatalog = false;
const owners = ["a", "b"].map((community) => {
  let incoming = (_events: readonly RelayEvent[]) => {};
  let time = 1;
  let catalog = signed(member, {
    kind: 30030,
    created_at: time,
    content: "",
    tags: [
      ["d", "buzz:custom-emoji"],
      ["emoji", "party", `https://${community}.test/media/current.png`],
    ],
  });
  const historic = message(viewer, "general", "History :party:", 10, [
    ["emoji", "party", `https://${community}.test/media/history.png`],
  ]);
  const reaction = signed(member, {
    kind: 7,
    content: ":party:",
    tags: [
      ["e", historic.id],
      ["emoji", "party", `https://${community}.test/media/reaction.png`],
    ],
  });
  const events = [historic, reaction];
  const rejected = new Set<string>();
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relayKey.pubkey,
      scope: community,
      media: (url) =>
        url.startsWith("https://")
          ? `/proof-media/${encodeURIComponent(url)}`
          : undefined,
      subscribe(callbacks) {
        incoming = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
      async query(filters) {
        return filters.flatMap((filter) => {
          if (filter.kinds?.includes(30030)) {
            if (failCatalog) throw new Error("Fixture emoji offline");
            return [catalog];
          }
          if (filter.kinds?.includes(39002))
            return [
              roster(relayKey, "general", [viewer.pubkey, member.pubkey]),
            ];
          if (filter.kinds?.includes(39000))
            return [metadata(relayKey, "general", "General")];
          if (filter.kinds?.includes(0))
            return [
              profile(viewer, { name: "Reader" }),
              profile(member, { name: "Member" }),
            ];
          if (filter.ids)
            return events.filter((event) => filter.ids?.includes(event.id));
          if (filter.depth_limit) return [];
          if (filter["#h"]?.includes("general"))
            return [
              ...events,
              bounds(relayKey, "general", "head", {
                has_more: false,
                next_cursor: null,
              }),
            ];
          return [];
        });
      },
      writer: {
        kinds: [9, 40003],
        async sign(template) {
          const event = signed(viewer, template);
          report.signed.push(event);
          return event;
        },
        async publish(event) {
          report.published.push(event);
          if (event.content.includes("reject") && !rejected.has(event.id)) {
            rejected.add(event.id);
            throw new PublishRejected("Fixture rejection");
          }
          events.push(event);
          incoming([event]);
        },
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owner.session.channels.ensureList();
  return {
    ...owner,
    community,
    replace() {
      catalog = signed(member, {
        kind: 30030,
        created_at: ++time,
        content: "",
        tags: [
          ["d", "buzz:custom-emoji"],
          ["emoji", "party", `https://${community}.test/media/replaced.png`],
        ],
      });
      incoming([catalog]);
    },
  };
});
let selected = 0;
function activeOwner(index = selected) {
  const owner = owners[index];
  if (!owner) throw new Error("Missing fixture community");
  return owner;
}
let connection = {
  status: "ready" as const,
  generation: 1,
  scope: "a",
  session: activeOwner(0).session,
  viewer: viewer.pubkey,
};
const listeners = new Set<() => void>();
const relay = {
  snapshot: () => connection,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  retry() {},
  disconnect() {},
  async clearCache() {},
};
async function api(path: string, body?: unknown) {
  const response = await fetch(
    `/__proof/${path}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
function withProbe(result: Awaited<ReturnType<PluginStorage["getCatalog"]>>) {
  if (result.status === "ready")
    result.catalog.plugins.push({
      manifest: { id: "test.probe", name: "Probe", apiVersion: 1 },
      source: "bundled",
      enabled: probeEnabled,
      revision: "bundled",
      previous: null,
      error: null,
    });
  return result;
}
const storage: PluginStorage = {
  getCatalog: async () => withProbe(await api("catalog")),
  changePlugin: async (action, id) =>
    withProbe(await api("change", { action, id })),
  recoverSettings: () => api("recover", {}),
  readModule: async (id, revision) =>
    (await api("module", { id, revision })).code,
};
const ctx = new Context();
let savedEdit: ((text: string) => boolean) | undefined;
let latestEdit: ((text: string) => boolean) | undefined;
let removedEditResult: boolean | undefined;
let attackRemoval = false;
let probeEnabled = true;
const probe = {
  manifest: { id: "test.probe", name: "Probe", apiVersion: 1 as const },
  module: {
    inject: ["conversation"],
    apply(ctx: Context) {
      ctx.conversation.registerTool({
        id: "probe",
        title: "Probe",
        component: ({ insertText }) => {
          useLayoutEffect(() => {
            latestEdit = insertText;
          }, [insertText]);
          return (
            <button
              type="button"
              onClick={() => {
                insertText("ONE");
                insertText("TWO");
              }}
            >
              Insert twice
            </button>
          );
        },
      });
    },
  },
};
const plugins = createPluginManager(ctx, {
  bundled: [...bundledPlugins, probe],
  storage,
});
const pages = new PagesService(ctx);
new PanelsService(ctx);
const conversation = new ConversationService(ctx);
// Deliberately fire a removed contribution's command before React can unmount it.
conversation.tools.subscribe(() => {
  if (
    attackRemoval &&
    !conversation.tools
      .snapshot()
      .some((tool) => tool.pluginId === "test.probe")
  ) {
    attackRemoval = false;
    removedEditResult = savedEdit?.("STALE");
  }
});
ctx.provide("relay", relay);
Object.assign(window, {
  conversationFixture: {
    report,
    saveEdit() {
      savedEdit = latestEdit;
    },
    callSaved: () => savedEdit?.("STALE"),
    removedResult: () => removedEditResult,
    async removeProbe() {
      attackRemoval = true;
      probeEnabled = false;
      await plugins.retry();
    },
    async enableProbe() {
      probeEnabled = true;
      await plugins.retry();
    },
    switch() {
      selected = 1 - selected;
      const owner = activeOwner();
      connection = {
        ...connection,
        scope: owner.community,
        session: owner.session,
      };
      for (const listener of listeners) listener();
    },
    replace: () => activeOwner().replace(),
    async fail(value: boolean) {
      failCatalog = value;
      if (value) await activeOwner().session.emoji.refresh();
    },
    change: (action: string, id: string) =>
      plugins.change(action as "enable" | "disable", id),
    update: () => api("update", {}).then(() => plugins.retry()),
  },
});
function Fixture() {
  const registered = useSyncExternalStore(
    pages.subscribe,
    pages.snapshot,
    pages.snapshot,
  );
  const [selection, select] = useState("buzz.channels");
  const entry = registered.find((page) => page.pluginId === selection);
  const Page = entry?.component;
  return (
    <>
      <nav aria-label="Proof pages">
        {registered.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => select(entry.pluginId)}
          >
            {entry.title}
          </button>
        ))}
      </nav>
      <main style={{ height: 800 }}>
        {Page ? <Page /> : <p>Page unavailable</p>}
      </main>
    </>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
window.addEventListener("pagehide", () => {
  void plugins.dispose();
  void ctx.fiber.dispose();
  for (const owner of owners) owner.dispose();
});
