// What goose's UI reaches of its runtime: the runtime serves it, and the UI
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
import type { AgentProviderSnapshot } from "../../features/agents/service";
import type { GooseRuntime } from "./runtime";
import type { GooseSetup } from "./setup";
import type { createTabs } from "./tabs";
import type { GooseHistory } from "./transcript";

/** What the type's UI reaches of its runtime. */
export type GooseExposed = Parameters<typeof createTabs>[0];
type Setup = GooseSetup;
type History = GooseHistory;
type Arg<
  F extends (...args: never[]) => unknown,
  N extends number,
> = Parameters<F>[N];
type Answer<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;
const CHECKING: AgentProviderSnapshot = Object.freeze({
  readiness: "checking",
});
const done = () => null;
const json = (value: unknown) => (value ?? null) as Json;
// The UI stops waiting by itself; reading changes nothing, so it finishes.
const unstopped = () => new AbortController().signal;

/** The runtime's side. */
export function serveGoose(
  setup: Setup,
  runtime: GooseRuntime,
  history: History,
): Served {
  type Args = Readonly<Record<string, unknown>>;
  const changed = (listener: () => void) => runtime.subscribe(listener);
  return {
    topics: {
      setup: storeTopic(setup),
      sessions: viewTopic(changed, (key: AgentKey) => runtime.sessions(key)),
    },
    commands: {
      check: () => setup.check().then(done),
      providers: () => setup.providers().then(json),
      models: (id) => setup.models(id as string).then(json),
      efforts: (choice) =>
        setup.efforts(choice as Arg<Setup["efforts"], 0>).then(json),
      // A set does not cross; its names do.
      saved: async (id) => [...(await setup.saved(id as string))],
      save: (args) => {
        const { id, fields } = args as Args;
        return setup
          .save(id as string, fields as Arg<Setup["save"], 1>)
          .then(done);
      },
      saveDefaults: (args) => {
        const { choice, fields } = args as Args;
        return setup
          .saveDefaults(
            choice as Arg<Setup["saveDefaults"], 0>,
            fields as Arg<Setup["saveDefaults"], 1>,
          )
          .then(done);
      },
      test: (choice) => setup.test(choice as Arg<Setup["test"], 0>).then(json),
      find: (args) => {
        const { agent, workspace, place } = args as Args;
        return history
          .find(
            agent as string,
            workspace as string,
            place as Arg<History["find"], 2>,
            unstopped(),
          )
          .then(json);
      },
      recent: (args) => {
        const { agent, workspace } = args as Args;
        return history
          .recent(agent as string, workspace as string, unstopped())
          .then(json);
      },
      transcript: (lookup) =>
        history
          .transcript(lookup as Arg<History["transcript"], 0>, unstopped())
          .then(json),
    },
  };
}

/** The UI's side: the runtime's handles, reached over `link`. */
export function linkGoose(link: RuntimeLink): GooseExposed {
  const setup = linkedStore<AgentProviderSnapshot>(link, "setup", CHECKING);
  const sessions = linkedView<AgentKey, ReturnType<GooseRuntime["sessions"]>>(
    link,
    "sessions",
    [],
  );
  const ask = <T>(command: string, args: unknown = null) =>
    link.call(command, args as Json) as Promise<T>;
  const undefinedOf = <T>(value: T | null) => value ?? undefined;
  return {
    setup: {
      snapshot: setup.snapshot,
      subscribe: setup.subscribe,
      check: async () => {
        await ask("check");
      },
      providers: () => ask<Answer<Setup["providers"]>>("providers"),
      models: (id) => ask<Answer<Setup["models"]>>("models", id),
      efforts: (choice) => ask<Answer<Setup["efforts"]>>("efforts", choice),
      saved: async (id) => new Set(await ask<string[]>("saved", id)),
      save: async (id, fields) => {
        await ask("save", { id, fields });
      },
      saveDefaults: async (choice, fields = {}) => {
        await ask("saveDefaults", { choice, fields });
      },
      test: (choice) => ask<Answer<Setup["test"]>>("test", choice),
    },
    runtime: {
      subscribe: sessions.subscribe,
      sessions: (key) => sessions.read(key),
      loaded: (key) => sessions.loaded(key),
    },
    history: {
      find: async (agent, workspace, place, signal) =>
        undefinedOf(
          await abortable(
            ask<Answer<History["find"]> | null>("find", {
              agent,
              workspace,
              place,
            }),
            signal,
          ),
        ),
      recent: (agent, workspace, signal) =>
        abortable(
          ask<Answer<History["recent"]>>("recent", { agent, workspace }),
          signal,
        ),
      transcript: async (lookup, signal) =>
        undefinedOf(
          await abortable(
            ask<Answer<History["transcript"]> | null>("transcript", lookup),
            signal,
          ),
        ),
    },
  };
}
