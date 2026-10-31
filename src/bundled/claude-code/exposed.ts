// What Claude's UI reaches of its runtime: the runtime serves it, and the UI
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
import {
  NATIVE_DEFAULTS,
  type ClaudeDefaults,
  type ClaudeProviderDefaults,
} from "./defaults";
import type { ClaudeRuntime, SavedConversation } from "./runtime";
import { SETUP_START, type ClaudeSetup, type SetupState } from "./setup";
import type { createTabs } from "./tabs";
import type { Conversation } from "./transcript";

/** What the type's UI reaches of its runtime. */
export type ClaudeExposed = Parameters<typeof createTabs>[0];
type Place = Readonly<{ channelId: string; root?: string }>;
type Transcript = Awaited<ReturnType<ClaudeRuntime["transcript"]>>;
/** A channel's label, as one agent reads it. */
type LabelKey = Readonly<{ agent: AgentKey; channelId: string }>;
const NONE: readonly never[] = Object.freeze([]);
const done = () => null;
// The UI stops waiting by itself; reading changes nothing, so it finishes.
const unstopped = () => new AbortController().signal;

/** The runtime's side. */
export function serveClaude(
  setup: ClaudeSetup,
  defaults: ClaudeDefaults,
  runtime: ClaudeRuntime,
): Served {
  const changed = (listener: () => void) => runtime.subscribe(listener);
  return {
    topics: {
      setup: storeTopic(setup),
      defaults: storeTopic(defaults),
      sessions: viewTopic(changed, (key: AgentKey) => runtime.sessions(key)),
      conversations: viewTopic(changed, (key: AgentKey) =>
        runtime.conversations(key),
      ),
      // Told again when its channel list or the runtime changes.
      label: (args) => {
        const { agent, channelId } = args as LabelKey;
        return {
          get: () =>
            (runtime.channelLabel(agent, channelId) ?? null) as unknown as Json,
          subscribe(listener) {
            const stops = [
              changed(listener),
              runtime.subscribeChannels(agent, listener),
            ];
            return () => {
              for (const stop of stops) stop();
            };
          },
        };
      },
    },
    commands: {
      check: (refresh) => setup.check(refresh === true).then(done),
      loadModels: (retry) => setup.loadModels(retry === true).then(done),
      run: (args) => {
        const { step, asked } = args as Readonly<{
          step: "install" | "login";
          asked: boolean;
        }>;
        return setup.run(step, asked).then(done);
      },
      answer: async (text) => {
        await setup.answer(text as string);
        return null;
      },
      cancel: async () => {
        await setup.cancel();
        return null;
      },
      saveDefaults: (next) =>
        defaults.save(next as ClaudeProviderDefaults).then(done),
      find: async (args) => {
        const { key, place, workspace } = args as Readonly<{
          key: AgentKey;
          place: Place;
          workspace: string;
        }>;
        const found = await runtime.find(key, place, workspace, unstopped());
        return (found ?? null) as Json;
      },
      transcript: async (args) => {
        const { conversation, workspace, working } = args as Readonly<{
          conversation: Conversation;
          workspace: string;
          working: boolean;
        }>;
        const read = await runtime.transcript(
          conversation,
          workspace,
          working,
          unstopped(),
        );
        return (read ?? null) as unknown as Json;
      },
    },
  };
}

/** The UI's side: the runtime's handles, reached over `link`. */
export function linkClaude(link: RuntimeLink): ClaudeExposed {
  const setup = linkedStore<SetupState>(link, "setup", SETUP_START);
  const defaults = linkedStore<ClaudeProviderDefaults>(
    link,
    "defaults",
    NATIVE_DEFAULTS,
  );
  const sessions = linkedView<AgentKey, ReturnType<ClaudeRuntime["sessions"]>>(
    link,
    "sessions",
    [],
  );
  const conversations = linkedView<AgentKey, readonly SavedConversation[]>(
    link,
    "conversations",
    NONE,
  );
  const labels = linkedView<
    LabelKey,
    ReturnType<ClaudeRuntime["channelLabel"]>
  >(link, "label", undefined);
  const call = async (command: string, args: unknown = null) => {
    await link.call(command, args as Json);
  };
  return {
    setup: {
      snapshot: setup.snapshot,
      subscribe: setup.subscribe,
      check: (refresh = false) => call("check", refresh),
      loadModels: (retry = false) => call("loadModels", retry),
      run: (step, asked = true) => call("run", { step, asked }),
      answer: (text) => call("answer", text),
      cancel: () => call("cancel"),
    },
    defaults: {
      snapshot: defaults.snapshot,
      subscribe: defaults.subscribe,
      save: (next) => call("saveDefaults", next),
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
      loaded: (key) => conversations.loaded(key),
      channelLabel: (agent, channelId) => labels.read({ agent, channelId }),
      subscribeChannels: (_agent, listener) => labels.subscribe(listener),
      find: async (key, place, workspace, signal) =>
        ((await abortable(
          link.call("find", { key, place, workspace } as unknown as Json),
          signal,
        )) ?? undefined) as SavedConversation | undefined,
      transcript: async (conversation, workspace, working, signal) =>
        ((await abortable(
          link.call("transcript", {
            conversation,
            workspace,
            working,
          } as unknown as Json),
          signal,
        )) ?? undefined) as Transcript,
    },
  };
}
