import { useState, useSyncExternalStore } from "react";
import { createNavigationController } from "../../src/features/navigation/controller";
import { createMemoryHistory } from "../../src/features/navigation/history";
import { MessageComposer } from "../../src/features/messages/MessageComposer";
import { createRoot } from "react-dom/client";
import { AgentsPage } from "../../src/bundled/agents/AgentsPage";
import { createRelaySession } from "../../src/features/relay/session";
import type {
  RelayData,
  RelaySnapshot,
} from "../../src/features/relay/service";
import { createAgentControl } from "../../src/features/agents/control";
import { controlFixture } from "../../src/features/agents/control-testing";
import { Button } from "../../src/shared/design-system/ui/Button";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import "../../src/shared/styles/globals.css";

const fixture = controlFixture();
const modelCalls: string[] = [];
let modelMode = "success";
let releaseModels: (() => void) | undefined;
fixture.host.models = {
  begin: async () => {
    modelCalls.push("begin");
    return modelCalls.length;
  },
  cancel: async () => {
    modelCalls.push("cancel");
    releaseModels?.();
  },
  run: async (_ticket, request) => {
    if (request.integration.kind !== "databricks")
      throw new Error("Fixture supports Databricks only");
    modelCalls.push(request.action);
    if (modelMode === "wait")
      await new Promise<void>((resolve) => {
        releaseModels = resolve;
      });
    if (modelMode === "error") throw "Synthetic connection failure.";
    return {
      integration: {
        kind: "databricks",
        host: request.integration.settings.host,
      },
      discovery:
        request.action === "disconnect"
          ? null
          : {
              source: "databricksCatalog",
              authentication: "authenticated",
              catalog: "remote",
            },
      models:
        modelMode === "empty" || request.action === "disconnect"
          ? []
          : [
              {
                id: "catalog.schema.real-model",
                name: "Friendly Model",
                effort: { status: "unsupported" },
              },
              {
                id: "endpoint-two",
                name: "Other Model",
                effort: { status: "unsupported" },
              },
            ],
      modelOverridden: false,
      disconnected: request.action === "disconnect",
    };
  },
};
const control = createAgentControl(fixture.host);
const viewer = "de".repeat(32);
const scope = `https://relay.example.test:${viewer}`;
const channelId = "11111111-1111-4111-8111-111111111111";
const session = createRelaySession({
  viewer: "de".repeat(32),
  relayAuthor: "ef".repeat(32),
  scope: "https://relay.example.test",
  writer: {
    kinds: [9],
    async sign() {
      throw new Error("This preview cannot sign or send messages.");
    },
    async publish() {
      throw new Error("This preview cannot publish messages.");
    },
  },
  async readAgentLibrary() {
    return {
      definitions: [
        { id: "fixture", name: fixture.agent.name },
        { id: "unlinked", name: "Library only" },
      ],
      identities: [
        {
          pubkey: fixture.agent.pubkey,
          name: fixture.agent.name,
          definitionId: "fixture",
        },
      ],
    };
  },
  async query(filters) {
    if (filters.some((filter) => filter.kinds?.includes(39002)))
      return [
        {
          id: "12".repeat(32),
          pubkey: "ef".repeat(32),
          kind: 39002,
          created_at: 1,
          content: "",
          tags: [
            ["d", channelId],
            ["p", viewer],
            ["p", fixture.agent.pubkey],
          ],
        },
        {
          id: "13".repeat(32),
          pubkey: "ef".repeat(32),
          kind: 39000,
          created_at: 1,
          content: JSON.stringify({ name: "shared-fixture" }),
          tags: [
            ["d", channelId],
            ["t", "stream"],
          ],
        },
      ];
    return [];
  },
  media: () => undefined,
});
const relaySnapshot: RelaySnapshot = {
  status: "ready",
  scope,
  viewer,
  generation: 1,
  session: session.session,
};
const relay: RelayData = {
  snapshot: () => relaySnapshot,
  subscribe: () => () => {},
  retry() {},
  disconnect() {},
  clearCache: async () => {},
};
Object.assign(window, {
  agentModelsFixture: {
    calls: modelCalls,
    mode: (value: string) => {
      modelMode = value;
    },
    release: () => releaseModels?.(),
  },
});
Object.assign(window, { agentControlFixture: { ...fixture, control } });
const navigationHost = createNavigationController(createMemoryHistory());
navigationHost.complete(navigationHost.navigation.snapshot().attempt, {
  status: "opened",
});
navigationHost.navigation.subscribe(() => {
  const state = navigationHost.navigation.snapshot();
  if (state.status === "opening")
    navigationHost.complete(state.attempt, { status: "opened" });
});
function Fixture() {
  useKeyboardFocusVisibility();
  const [shown, setShown] = useState(true);
  const route = useSyncExternalStore(
    navigationHost.navigation.subscribe,
    navigationHost.navigation.snapshot,
  );
  const inChannel = route.entry.target.kind === "conversation";
  const [failure, setFailure] = useState(false);
  const [browser, setBrowser] = useState(false);
  const [unavailable] = useState(() => createAgentControl(null));
  return (
    <main
      data-buzz-ui=""
      className="mx-auto max-w-4xl space-y-4 p-4 text-body text-primary"
    >
      <header className="space-y-3 rounded-xl bg-panel p-4">
        <h1 className="text-heading">Agent editor · Isolated fixture</h1>
        <p className="text-secondary">
          Temporary, in-memory identities only. No Keychain, real libraries,
          relay connection, or agent processes. All Start/Stop and import
          actions here are simulated. Reload resets changes; use sample values
          only.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setShown(!shown)}>Toggle page</Button>
          <Button
            onClick={() => {
              fixture.failSave(!failure);
              setFailure(!failure);
            }}
          >
            {failure ? "Allow saves" : "Reject saves"}
          </Button>
          <Button
            onClick={() => {
              fixture.agent.revision++;
              void control.refresh();
            }}
          >
            Simulate newer revision
          </Button>
          <Button
            onClick={() => {
              fixture.data.runtimeAvailable = !fixture.data.runtimeAvailable;
              void control.refresh();
            }}
          >
            Toggle runtime availability
          </Button>
          <Button onClick={() => setBrowser(!browser)}>
            Toggle browser-only mode
          </Button>
          <Button
            onClick={() => {
              const root = document.documentElement;
              root.dataset.colorMode =
                root.dataset.colorMode === "dark" ? "light" : "dark";
            }}
          >
            Toggle appearance
          </Button>
        </div>
      </header>
      {shown && inChannel ? (
        <section aria-label="Fixture channel" className="space-y-3 p-4">
          <Button
            onClick={() =>
              void navigationHost.navigation.open({ version: 1, kind: "home" })
            }
          >
            Back to Agents
          </Button>
          <h2>#shared-fixture · No publication transport</h2>
          <MessageComposer
            session={session.session}
            scope={scope}
            channelId={channelId}
            channelName="shared-fixture"
            disabled
          />
        </section>
      ) : (
        shown && (
          <AgentsPage
            relay={relay}
            key={browser ? "browser" : "native"}
            control={browser ? unavailable : control}
          />
        )
      )}
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
