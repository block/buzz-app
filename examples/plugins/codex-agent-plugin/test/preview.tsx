/** Manual visual fixture: real Buzz components, local catalog and activity only. */
import * as React from "react";
import { createRoot } from "react-dom/client";
import "../../../../src/shared/styles/globals.css";
import type { AgentType, Context } from "@buzz/author";
import type { AgentTypes } from "../../../../src/features/agent-types/service";
import type {
  AgentControl,
  AgentControlState,
} from "../../../../src/features/agents/control";
import type { RelaySession } from "../../../../src/features/relay/session";
import { AgentCreateDialog } from "../../../../src/bundled/agents/AgentCreateDialog";
import { LiveRunsAccessory } from "../../../../src/bundled/agents/LiveRunsAccessory";
import { createLiveRuns } from "../../../../src/features/agent-types/live";
const bundle = "../dist/plugin.js";
const { apply } = await import(/* @vite-ignore */ bundle);
import { activity } from "../src/activity";
import type { Wire } from "../src/rpc";
let type!: AgentType;
apply({
  react: React,
  agentTypes: {
    register(value: AgentType) {
      type = value;
    },
  },
  host: {
    async connectCommand(_id: string, options: { onLine(text: string): void }) {
      return {
        close() {},
        async send(text: string) {
          const m = JSON.parse(text);
          if (m.id == null) return;
          options.onLine(
            JSON.stringify({
              id: m.id,
              result:
                m.method === "model/list"
                  ? {
                      data: [
                        {
                          model: "fixture-model",
                          displayName: "Codex preview model",
                          description:
                            "Fixture catalog for visual inspection. The installed plugin loads your actual Codex models.",
                          isDefault: true,
                          defaultReasoningEffort: "medium",
                          supportedReasoningEfforts: [
                            {
                              reasoningEffort: "low",
                              description:
                                "Quicker responses for straightforward changes.",
                            },
                            {
                              reasoningEffort: "medium",
                              description:
                                "A balance of speed and deeper reasoning.",
                            },
                            {
                              reasoningEffort: "high",
                              description:
                                "More time to reason through complex work.",
                            },
                          ],
                        },
                      ],
                      nextCursor: null,
                    }
                  : {},
            }),
          );
        },
      };
    },
  },
} as unknown as Context);
const types = [
  {
    ...type,
    key: "buzz.codex-agent-plugin/codex",
    pluginId: "buzz.codex-agent-plugin",
    revision: "fixture",
  },
];
const agentTypes = {
  snapshot: () => types,
  subscribe: () => () => {},
} as unknown as AgentTypes;
const state = {
  status: "ready",
  busy: false,
  data: {
    agents: [],
    createAvailable: true,
    runtimeAvailable: true,
    harnessOptions: [],
    defaultWorkspace: "",
  },
} as unknown as AgentControlState;
const control = {
  snapshot: () => state,
  create: async () => {
    throw new Error("Preview only: no identity or relay writes.");
  },
} as unknown as AgentControl;
const runs = createLiveRuns((flush) => flush());
const run = runs.open({
  agent: { id: "preview", pubkey: "c".repeat(64), name: "Codex" },
  channelId: "preview",
  eventId: "e1",
  threadRootId: "e1",
});
const view = activity(run.live);
const session = {
  profiles: {
    snapshot: () => new Map(),
    subscribe: () => () => {},
    ensure: async () => {},
  },
  media: () => undefined,
} as unknown as RelaySession;
function Preview() {
  const [creating, setCreating] = React.useState(true);
  const [events, setEvents] = React.useState<Wire[]>([]);
  const [position, setPosition] = React.useState(0);
  return (
    <main style={{ maxWidth: 760, margin: "48px auto", padding: 24 }}>
      <h1 className="text-title">Codex plugin preview</h1>
      <p className="text-body-sm text-secondary">
        Local visual fixture. No identities or messages are created.
      </p>
      <button
        type="button"
        className="buzz-button"
        onClick={() => setCreating(true)}
      >
        Create agent
      </button>
      <label className="buzz-field">
        Load local live-test evidence
        <input
          type="file"
          accept="application/json"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (file) {
              const data = JSON.parse(await file.text());
              setEvents(
                data.records.filter((r: Wire) => r.method?.startsWith("item/")),
              );
              setPosition(0);
            }
          }}
        />
      </label>
      <button
        type="button"
        className="buzz-button"
        disabled={position >= events.length}
        onClick={() => {
          const next = events[position];
          if (next) view.accept(next);
          setPosition(position + 1);
        }}
      >
        Next activity event ({position}/{events.length})
      </button>
      <button
        type="button"
        className="buzz-button"
        disabled={position >= events.length}
        onClick={() => {
          events.slice(position).forEach(view.accept);
          setPosition(events.length);
        }}
      >
        Show complete activity
      </button>
      <LiveRunsAccessory
        runs={runs}
        session={session}
        scope="preview"
        channelId="preview"
        canOpen={() => false}
        open={() => false}
      />
      {creating && (
        <AgentCreateDialog
          control={control}
          agentTypes={agentTypes}
          state={state}
          destination="preview"
          owner={"a".repeat(64)}
          onClose={() => setCreating(false)}
        />
      )}
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Preview />);
