// Production plugin, document UI, channel workspace, sessions and outboxes.
// Only the upstream relay/identity inventory is replaced with disposable keys.
import { Context } from "@deepseek-ai/cordis";
import {
  StrictMode,
  useState,
  useSyncExternalStore,
  useLayoutEffect,
  useEffect,
} from "react";
import { createRoot } from "react-dom/client";
import * as notes from "../../src/bundled/relay-notes";
import { ConversationService } from "../../src/features/conversation/service";
import { provideNavigation } from "../../src/features/navigation/service";
import { PagesService } from "../../src/features/pages/service";
import { PanelsService } from "../../src/features/panels/service";
import { notesFixture } from "../../src/features/notes/testing";
import {
  noteMarkdownLink,
  parseNote,
  type NoteAddress,
} from "../../src/features/notes/model";
import type {
  RelayData,
  RelaySnapshot,
} from "../../src/features/relay/service";
import { message, signed } from "../../src/features/relay/testing";
import type { AddedTool } from "../../src/buzz-mcp/session-tools";
import type { PageNavigation } from "../../src/features/navigation/service";
import type { PageProps } from "../../src/features/pages/service";
import type { ComponentType } from "react";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import { ChannelWorkspaceFixture } from "./channel-workspace";
import "../../src/shared/styles/globals.css";

const f = await notesFixture();
const research = f.seed(
  "Storage research",
  "# Findings\n\nEach working page has its own private system channel.\n\n- Stable page identity\n- Retained revisions\n- Explicit sharing",
);
const plan = f.seed(
  "Connected pages plan",
  `# Connected notes\n\nA working plan for people and their agents.\n\n1. Create and edit the same document.\n2. Follow supporting research.\n3. Share the note deliberately.\n\n## Supporting research\n\n${noteMarkdownLink(research, f.origin)}`,
);
const legacy = signed(f.carl, {
  kind: 30023,
  content: "# Earlier findings\n\nKeep this shared reference readable.",
  tags: [
    ["d", "old-research"],
    ["title", "Legacy research"],
  ],
});
f.accepted.push(legacy);
const general = "00000001-1111-4111-8111-111111111111";
f.channels.set(general, {
  id: general,
  name: "pages-design",
  creator: f.viewer.pubkey,
  labels: [],
  type: "stream",
  roles: { [f.viewer.pubkey]: "owner", [f.carl.pubkey]: "member" },
  created: 1_790_000_000,
  updated: 1_790_000_000,
});
f.accepted.push(
  message(
    f.carl,
    general,
    `I’ve updated the ${noteMarkdownLink(plan, f.origin)}. Open it beside this conversation to review the plan.`,
    1_790_000_100,
  ),
);
// The fixture seeds this conversation after constructing its session. Admit
// its signed state before mounting, as a real membership notification would.
await f.session.channels.resolve?.([general], { consistency: "strong" });
const snapshot: RelaySnapshot = {
  status: "ready",
  generation: 1,
  viewer: f.viewer.pubkey,
  scope: f.session.scope,
  origin: f.origin,
  session: f.session,
};
const relay: RelayData = {
  snapshot: () => snapshot,
  subscribe: () => () => {},
  retry() {},
  disconnect() {},
  clearCache: () => f.owner.clearCache(),
};
const ctx = new Context();
ctx.provide("pluginStatus", {
  isActive: () => true,
  subscribe: () => () => {},
});
const conversation = new ConversationService(ctx);
const host = provideNavigation(ctx, undefined);
const pages = new PagesService(ctx),
  panels = new PanelsService(ctx);
ctx.provide("relay", relay);
const tools = new Map<string, AddedTool>();
ctx.provide("agents", {
  relay: () => relay,
  addTool: (tool: AddedTool) => tools.set(tool.name, tool),
  snapshot: () => ({
    status: "unavailable",
    agents: [],
    running: [],
    teams: [],
  }),
  subscribe: () => () => {},
});
const scope = ctx
  .extend({ pluginOwner: { id: "buzz.relay-notes", revision: "fixture" } })
  .plugin(notes);
await scope;
const tool = (name: string) => {
  const found = tools.get(name);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
};
Object.assign(window, {
  workingNotesFixture: {
    navigation: () => host.navigation.snapshot(),
    queryKinds: () => [
      ...new Set(
        f.queries.flatMap((filters) =>
          filters.flatMap((filter) => filter.kinds ?? []),
        ),
      ),
    ],
    legacy: () => f.accepted.filter((event) => event.kind === 30023),
    plan,
    research,
    sam: f.sam.pubkey,
    unverifyCarl() {
      f.profiles.push(
        signed(f.carl, {
          kind: 0,
          content: "{}",
          tags: [],
          created_at: 2_000_000_000,
        }),
      );
    },
    makeAdministrator(address: NoteAddress) {
      const channel = f.channels.get(address.channel);
      if (!channel) throw new Error("Missing channel");
      channel.roles[f.sam.pubkey] = "admin";
      channel.updated++;
    },
    head(id: string) {
      const event = f.heads.get(id);
      return event ? parseNote(event) : undefined;
    },
    async agentEdit(address: NoteAddress, markdown: string) {
      const event = f.heads.get(address.id);
      if (!event) throw new Error("Missing page");
      const note = parseNote(event);
      if (!note) throw new Error("Unsupported page");
      return f.edit(f.carl, note, { title: note.title, markdown });
    },
    async agentCreate(title: string, text: string) {
      return JSON.parse(
        (await tool("page_set").call(
          f.client(),
          {},
          { id: crypto.randomUUID(), title, text },
        )) as string,
      );
    },
    async agentRead(address: NoteAddress) {
      return JSON.parse(
        (await tool("page_get").call(
          f.client(),
          {},
          { id: address.id, channel: address.channel },
        )) as string,
      );
    },
    async readAsSam(address: NoteAddress) {
      return f.client(f.sam).query([
        {
          kinds: [45010],
          "#h": [address.channel],
          "#d": [address.id],
          limit: 1,
          consistency: "strong",
        },
      ]);
    },
    revoke(address: NoteAddress) {
      const channel = f.channels.get(address.channel);
      if (!channel) throw new Error("Missing channel");
      delete channel.roles[f.viewer.pubkey];
      channel.updated++;
    },
    makeReader(address: NoteAddress) {
      const channel = f.channels.get(address.channel);
      if (channel) {
        channel.roles[f.sam.pubkey] = "owner";
        channel.roles[f.viewer.pubkey] = "guest";
        channel.updated++;
      }
    },
  },
});

const notesTarget = {
  version: 1,
  kind: "page",
  pluginId: "buzz.relay-notes",
  pageId: "notes",
  scope: { viewer: f.viewer.pubkey, communityOrigin: f.origin },
} as const;
function RoutedNotes({ Entry }: { Entry: ComponentType<PageProps> }) {
  const state = useSyncExternalStore(
    host.navigation.subscribe,
    host.navigation.snapshot,
  );
  const [request, setRequest] = useState<PageNavigation>();
  useLayoutEffect(() => {
    if (
      state.entry.target.kind !== "page" ||
      state.entry.target.pluginId !== "buzz.relay-notes"
    )
      return;
    const binding = host.request(state.attempt, {
      valid: () => true,
      subscribe: () => () => {},
    });
    setRequest(binding.request);
    binding.request.complete({ status: "opened" });
    return binding.dispose;
  }, [state.attempt, state.entry.target]);
  return <Entry navigation={request} />;
}
function Fixture() {
  const navigation = useSyncExternalStore(
    host.navigation.subscribe,
    host.navigation.snapshot,
  );
  const selected =
    navigation.entry.target.kind === "conversation" ? "conversation" : "notes";
  useEffect(() => {
    if (host.navigation.snapshot().entry.target.kind === "home")
      void host.navigation.open(notesTarget, { replace: true });
  }, []);
  const entries = useSyncExternalStore(pages.subscribe, pages.snapshot);
  const Entry = entries.find((entry) => entry.id === "notes")?.component;
  return (
    <ToastProvider>
      <div
        style={{
          height: "100dvh",
          display: "flex",
          flexDirection: "column",
          padding: "1rem",
          gap: "0.75rem",
        }}
      >
        <nav
          aria-label="Fixture navigation"
          style={{ display: "flex", gap: "1rem" }}
        >
          <button
            type="button"
            onClick={() => {
              void host.navigation.open(notesTarget);
            }}
          >
            Notes browser
          </button>
          <button
            type="button"
            onClick={() => {
              void host.navigation.open({
                version: 1,
                kind: "conversation",
                scope: notesTarget.scope,
                channelId: general,
              });
            }}
          >
            Conversation
          </button>
        </nav>
        <main style={{ flex: 1, minHeight: 0 }}>
          <div hidden={selected !== "notes"} style={{ height: "100%" }}>
            {Entry && <RoutedNotes Entry={Entry} />}
          </div>
          <div hidden={selected !== "conversation"} style={{ height: "100%" }}>
            <ChannelWorkspaceFixture
              extensions={conversation}
              relay={relay}
              panels={panels}
              pages={pages}
              host={host}
            />
          </div>
        </main>
      </div>
    </ToastProvider>
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
  void scope.dispose();
  void ctx.fiber.dispose();
  f.dispose();
});
