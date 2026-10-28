// What Codex's UI reaches of its runtime: the runtime serves it, and the UI
// reaches it over the link to the runtime, with the same shape as the
// runtime's own handles.
import {
  abortable,
  linkedStore,
  linkedView,
  storeTopic,
  viewTopic,
  type RuntimeLink,
} from "../../features/agents/exposed";
import type { Json, Served } from "../../features/agents/link";
import type { AgentKey } from "../../features/agents/membership";
import type { CodexRuntime, SavedConversation } from "./runtime";
import { type CodexSetup, SETUP_START, type SetupState } from "./setup";
import {
  type CodexProvider,
  type createTabs,
  type ProviderDefaults,
  type ProviderState,
  resolveConfig,
  type TranscriptRead,
} from "./tabs";

type Tabs = Parameters<typeof createTabs>;
/** What the type's UI reaches of its runtime. */
export type CodexExposed = Readonly<{
  provider: Tabs[0];
  runtime: Tabs[1];
  transcript: Tabs[2];
  setup: Tabs[3];
}>;
type Agent = Parameters<TranscriptRead>[0];
type Place = Readonly<{ channelId: string; root?: string }>;
const NONE: readonly never[] = Object.freeze([]);
// Checking from the start, so the UI waits for the runtime's own check.
const CHECKING: ProviderState = Object.freeze({
  readiness: "checking",
  checking: true,
  data: undefined,
  error: "",
  defaults: Object.freeze({ model: "", effort: "" }),
});
const done = () => null;
// The UI stops waiting by itself; reading changes nothing, so it finishes.
const unstopped = () => new AbortController().signal;

/** The runtime's side. */
export function serveCodex(
  provider: CodexProvider,
  setup: CodexSetup,
  runtime: CodexRuntime,
  transcript: TranscriptRead,
): Served {
  return {
    topics: {
      provider: storeTopic(provider),
      setup: storeTopic(setup),
      sessions: viewTopic(runtime.subscribe, (key: AgentKey) =>
        runtime.sessions(key),
      ),
      conversations: viewTopic(runtime.subscribe, (key: AgentKey) =>
        runtime.conversations(key),
      ),
    },
    commands: {
      check: () => provider.check().then(done),
      saveDefaults: (next) =>
        provider.saveDefaults(next as ProviderDefaults).then(done),
      run: (args) => {
        const { step, asked } = args as Readonly<{
          step: "install" | "login";
          asked: boolean;
        }>;
        return setup.run(step, asked).then(done);
      },
      cancel: async () => {
        await setup.cancel();
        return null;
      },
      find: async (args) => {
        const { agent, place } = args as Readonly<{
          agent: Agent;
          place: Place;
        }>;
        const found = await runtime.find(agent, place, unstopped());
        return (found ?? null) as Json;
      },
      transcript: async (args) => {
        const { agent, conversation } = args as Readonly<{
          agent: Agent;
          conversation: SavedConversation;
        }>;
        const read = await transcript(agent, conversation, unstopped());
        return (read ?? null) as unknown as Json;
      },
    },
  };
}

/** The UI's side: the runtime's handles, reached over `link`. */
export function linkCodex(link: RuntimeLink): CodexExposed {
  const provider = linkedStore<ProviderState>(link, "provider", CHECKING);
  const setup = linkedStore<SetupState>(link, "setup", SETUP_START);
  const sessions = linkedView<AgentKey, ReturnType<CodexRuntime["sessions"]>>(
    link,
    "sessions",
    NONE,
  );
  const conversations = linkedView<AgentKey, readonly SavedConversation[]>(
    link,
    "conversations",
    NONE,
  );
  const call = async (command: string, args: unknown = null) => {
    await link.call(command, args as Json);
  };
  return {
    provider: {
      snapshot: provider.snapshot,
      subscribe: provider.subscribe,
      check: () => call("check"),
      saveDefaults: (next) => call("saveDefaults", next),
      // From the provider's state the UI has, as the runtime resolves it.
      resolve: (raw) => resolveConfig(provider.snapshot(), raw),
    },
    runtime: {
      subscribe(listener) {
        const stops = [
          sessions.subscribe(listener),
          conversations.subscribe(listener),
        ];
        return () => {
          for (const stop of stops) stop();
        };
      },
      sessions: (key) => sessions.read(key),
      conversations: (key) => conversations.read(key),
      find: async (agent, place, signal) =>
        ((await abortable(
          link.call("find", { agent, place } as unknown as Json),
          signal,
        )) ?? undefined) as SavedConversation | undefined,
    },
    transcript: async (agent, conversation, signal) =>
      ((await abortable(
        link.call("transcript", { agent, conversation } as unknown as Json),
        signal,
      )) ?? undefined) as Awaited<ReturnType<TranscriptRead>>,
    setup: {
      snapshot: setup.snapshot,
      subscribe: setup.subscribe,
      run: (step, asked = true) => call("run", { step, asked }),
      cancel: () => call("cancel"),
    },
  };
}
