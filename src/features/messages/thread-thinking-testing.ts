import { Context } from "@deepseek-ai/cordis";
import { PluginRuntime } from "../../plugins/runtime";
import { ConversationService } from "../conversation/service";
import { ActivityAccessory } from "../../bundled/agent-activity/ActivityAccessory";
import { createAgentActivity } from "../agents/activity";
import { createRelaySession } from "../relay/session";
import { keypair, signed } from "../relay/testing";
import type { ThreadView, ThreadSnapshot } from "../relay/threads";
import type { ChannelMessage } from "../relay/contracts";

/** Isolated fixture identities and in-memory transport; never uses the live broker. */
export async function threadThinkingFixture() {
  const context = new Context();
  const runtime = new PluginRuntime(context, async () => ({
    inject: ["conversation"],
    apply(ctx) {
      ctx.conversation.registerAccessory({
        id: "activity",
        title: "Agent Activity",
        placement: "conversation",
        component: ActivityAccessory,
      });
    },
  }));
  const extensions = new ConversationService(context);
  const ready = new Promise<void>((resolve) => {
    const stop = extensions.accessories.subscribe(() => {
      if (extensions.accessories.snapshot().length) {
        stop();
        resolve();
      }
    });
  });
  runtime.reconcile([
    {
      manifest: { id: "preview.activity", name: "Activity", apiVersion: 1 },
      enabled: true,
      source: "external",
      revision: "one",
      previous: null,
      reloadable: true,
      error: null,
    },
  ]);
  await ready;
  const agent = keypair();
  const viewer = keypair();
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => [
      signed(agent, {
        kind: 0,
        tags: [],
        content: JSON.stringify({ name: "Buzzy", is_agent: true }),
      }),
      signed(viewer, {
        kind: 0,
        tags: [],
        content: JSON.stringify({ name: "Alex" }),
      }),
    ],
  });
  let generation = 0;
  let seq = 0;
  const activity = createAgentActivity(
    true,
    (next) => {
      generation = next ?? 0;
    },
    () => true,
  );
  activity.queries.activate();
  activity.state({
    status: "connected",
    routes: [{ id: "observer", status: "live", replay: "unknown" }],
  });
  function observe(
    kind: string,
    turnId: string,
    payload: unknown = {},
    agentId = agent.pubkey,
  ) {
    activity.receive(
      {
        id: `${++seq}`.padStart(64, "0"),
        agent: agentId,
        createdAt: Math.floor(Date.now() / 1000),
        plaintext: JSON.stringify({
          kind,
          turnId,
          channelId: "channel",
          seq,
          timestamp: new Date().toISOString(),
          payload,
        }),
      },
      generation,
    );
  }
  const turns = new Map<string, string>();
  const session = {
    ...owner.session,
    agentActivity: activity.queries,
    presence: {
      ...owner.session.presence,
      // Stable sample presence, independent of simulated work and reset.
      status: (pubkey: string) =>
        pubkey === agent.pubkey ? ("online" as const) : ("unknown" as const),
    },
  };
  const root = (id: string, content: string): ChannelMessage => ({
    id,
    content,
    channelId: "channel",
    authorId: viewer.pubkey,
    createdAt: Math.floor(Date.now() / 1000) - 120,
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
  });
  const first = root("1".repeat(64), "Can you check the onboarding copy?");
  const second = root(
    "2".repeat(64),
    "Can you review the notification settings?",
  );
  const snapshots = new Map<string, ThreadSnapshot>();
  const threadListeners = new Map<string, Set<() => void>>();
  for (const item of [first, second]) {
    const reply = (
      suffix: string,
      authorId: string,
      content: string,
      offset: number,
    ) => ({
      ...item,
      id: item.id.slice(0, 63) + suffix,
      authorId,
      content,
      threadRootId: item.id,
      replyParentId: item.id,
      createdAt: item.createdAt + offset,
    });
    snapshots.set(item.id, {
      status: "ready",
      root: item,
      error: undefined,
      canLoadMore: false,
      limited: false,
      replies: [
        reply("a", agent.pubkey, "I checked the first draft.", 1),
        reply(
          "b",
          viewer.pubkey,
          "Thanks. Can you check the latest changes too?",
          2,
        ),
      ],
    });
  }
  const initialSnapshots = new Map(snapshots);
  const previewSession = {
    ...session,
    thread(_channel: string, rootId: string): ThreadView {
      const snapshot = snapshots.get(rootId);
      if (!snapshot) throw new Error("Unknown fixture thread");
      return {
        snapshot: () => snapshots.get(rootId) ?? snapshot,
        subscribe(listener) {
          const listeners = threadListeners.get(rootId) ?? new Set();
          threadListeners.set(rootId, listeners);
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        refresh: async () => {},
        loadMore: async () => {},
        dispose() {},
      };
    },
  };
  return {
    session: previewSession,
    extensions,
    observe,
    reset() {
      turns.clear();
      activity.clear();
      activity.state({
        status: "connected",
        routes: [{ id: "observer", status: "live", replay: "unknown" }],
      });
      for (const [id, snapshot] of initialSnapshots) {
        snapshots.set(id, snapshot);
        for (const listener of threadListeners.get(id) ?? []) listener();
      }
    },
    start(rootId: string, withDetails = false) {
      if (turns.has(rootId)) return;
      const turnId = `${rootId}:${seq}`;
      turns.set(rootId, turnId);
      observe("turn_started", turnId, { triggeringEventIds: [rootId] });
      if (withDetails) {
        for (const [toolCallId, title, status, rawInput] of [
          [
            "read",
            "buzz-dev-mcp__read_file",
            "completed",
            { path: "/project/onboarding.md" },
          ],
          [
            "search",
            "buzz-dev-mcp__read_file",
            "in_progress",
            { path: "/project/notification-settings.md" },
          ],
        ] as const) {
          observe("acp_read", turnId, {
            method: "session/update",
            params: {
              update: {
                sessionUpdate: "tool_call",
                toolCallId,
                title,
                status,
                rawInput,
              },
            },
          });
        }
      }
    },
    respond(rootId: string) {
      const turnId = turns.get(rootId);
      if (!turnId) return;
      observe("turn_completed", turnId);
      turns.delete(rootId);
      const snapshot = snapshots.get(rootId);
      if (!snapshot?.root) return;
      const reply: ChannelMessage = {
        ...snapshot.root,
        id: `${rootId}:${seq}`,
        authorId: agent.pubkey,
        createdAt: Math.floor(Date.now() / 1000),
        threadRootId: rootId,
        replyParentId: rootId,
        content:
          rootId === first.id
            ? "I've checked the latest copy. The onboarding steps read clearly now."
            : "I've reviewed the settings. The notification labels are clear and consistent.",
      };
      snapshots.set(rootId, {
        ...snapshot,
        replies: [...snapshot.replies, reply],
      });
      for (const listener of threadListeners.get(rootId) ?? []) listener();
    },
    finish(rootId: string) {
      const turnId = turns.get(rootId);
      if (turnId) observe("turn_completed", turnId);
      turns.delete(rootId);
    },
    activity,
    agent: agent.pubkey,
    first,
    second,
    signal(rootId: string, kind = 20002, channelId = "channel") {
      activity.channelEvents([
        signed(agent, {
          kind,
          created_at: Math.floor(Date.now() / 1000),
          content: kind === 9 ? "Done" : "",
          tags: [
            ["h", channelId],
            ["e", rootId, "", "root"],
            ["e", rootId, "", "reply"],
          ],
        }),
      ]);
    },
    async dispose() {
      await runtime.dispose();
      await context.fiber.dispose();
      activity.dispose();
      owner.dispose();
    },
  };
}
