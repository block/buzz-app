import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ActivityDetails } from "../../src/bundled/agent-activity/ActivityPanel";
import { createAgentActivity } from "../../src/features/agents/activity";
import type { RelaySession } from "../../src/features/relay/session";
import { Button } from "../../src/shared/design-system/ui/Button";
import { Panel } from "../../src/shared/design-system/ui/Panel";
import { PanelHeader } from "../../src/shared/design-system/ui/PanelHeader";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import "../../src/shared/styles/globals.css";

const agent = "a".repeat(64);
const live = {
  status: "connected" as const,
  routes: [
    { id: "observer", status: "live" as const, replay: "unknown" as const },
  ],
};
function fixture() {
  let generation: number | null = null;
  const activity = createAgentActivity(
    true,
    (next) => {
      generation = next;
    },
    () => true,
  );
  const release = activity.queries.activate();
  activity.state(live);
  let id = 0;
  function send(kind: string, turnId: string, payload: unknown) {
    activity.receive(
      {
        id: (++id).toString(16).padStart(64, "0"),
        agent,
        createdAt: Math.floor(Date.now() / 1000),
        plaintext: JSON.stringify({
          kind,
          turnId,
          channelId: "design",
          sessionId: "S",
          timestamp: new Date().toISOString(),
          payload,
        }),
      },
      generation ?? 0,
    );
  }
  function update(turn: string, sessionUpdate: string, extra: object) {
    send("acp_read", turn, {
      method: "session/update",
      params: { sessionId: "S", update: { sessionUpdate, ...extra } },
    });
  }
  function seed() {
    activity.state(live);
    send("acp_write", "first", {
      method: "session/prompt",
      params: {
        prompt: [
          {
            type: "text",
            text: "Can you look into the agent selection disappearing after a failed send?",
          },
        ],
      },
    });
    update("first", "agent_thought_chunk", {
      content: {
        type: "text",
        text: "I’ll check how recipients are restored when sending fails.",
      },
    });
    update("first", "tool_call", {
      toolCallId: "read",
      title: "Reading MessageComposer.tsx",
      status: "in_progress",
      rawInput: { path: "src/features/messages/MessageComposer.tsx" },
    });
    update("first", "tool_call_update", {
      toolCallId: "read",
      status: "completed",
      rawOutput:
        "The draft is cleared before the rejected send restores its recipients.",
    });
    update("first", "agent_message_chunk", {
      content: {
        type: "text",
        text: "Found it. The error path is restoring the message text without its selected agent.",
      },
    });
    send("turn_completed", "first", {});
    send("acp_write", "second", {
      method: "session/prompt",
      params: {
        prompt: [
          {
            type: "text",
            text: "Please fix that and check the retry path too.",
          },
        ],
      },
    });
    update("second", "tool_call", {
      toolCallId: "edit",
      title: "Updating draft recovery",
      status: "completed",
      rawInput: { path: "src/features/messages/MessageComposer.tsx" },
      rawOutput: "The original draft is preserved after rejection.",
    });
    update("second", "tool_call", {
      toolCallId: "test",
      title: "Running composer tests",
      status: "in_progress",
      rawInput: { command: "pnpm vitest run MessageComposer.test.tsx" },
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: "✓ retains recipients after rejection\n✓ retries with the original draft",
          },
        },
      ],
    });
  }
  const profiles = new Map([[agent, { name: "Rivet" }]]);
  const channels = {
    status: "ready",
    channels: [{ id: "design", name: "Design" }],
  };
  const session = {
    agentActivity: activity.queries,
    profiles: { snapshot: () => profiles, subscribe: () => () => {} },
    channels: { list: () => channels, subscribeList: () => () => {} },
    live: { retry: () => activity.state(live) },
  } as unknown as RelaySession;
  seed();
  return {
    session,
    activity,
    seed,
    dispose: () => {
      release();
      activity.dispose();
    },
  };
}
function Preview() {
  useKeyboardFocusVisibility();
  const [data, setData] = useState<ReturnType<typeof fixture>>();
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const next = fixture();
    setData(next);
    return next.dispose;
  }, []);
  useEffect(() => {
    document.documentElement.dataset.colorMode = dark ? "dark" : "light";
  }, [dark]);
  return (
    <main className="min-h-screen bg-surface-panel p-6 text-standard">
      <header className="mb-8 flex flex-wrap items-center gap-3 text-body-sm">
        <span>Real activity renderer · synthetic events</span>
        <Button size="sm" variant="ghost" onClick={() => setDark(!dark)}>
          {dark ? "Light" : "Dark"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            data?.activity.state({ status: "retrying", routes: [] })
          }
        >
          Interrupt feed
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => data?.activity.clear()}
        >
          Clear
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            data?.activity.clear();
            data?.seed();
          }}
        >
          Reset sample
        </Button>
      </header>
      <div style={{ maxWidth: "36rem", marginInline: "auto" }}>
        <Panel>
          <PanelHeader title="Agent activity" />
          {data && (
            <ActivityDetails
              session={data.session}
              selection={{ agent, channelId: "design" }}
            />
          )}
        </Panel>
      </div>
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Preview />);
