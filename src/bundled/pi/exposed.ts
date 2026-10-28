// What Pi's UI reaches of its runtime: the runtime serves it, and the UI
// reaches it over the link to the runtime, with the same shape as the
// runtime's own handles.
import {
  abortable,
  linkedStore,
  linkedView,
  viewTopic,
  type RuntimeLink,
} from "../../features/agents/exposed";
import type { Json, Served } from "../../features/agents/link";
import type { AgentKey } from "../../features/agents/membership";
import type { PiRuntime, Place } from "./runtime";
import type { PiSetup } from "./setup";
import type { createTabs } from "./tabs";

/** What the type's UI reaches of its runtime. */
export type PiExposed = Parameters<typeof createTabs>[0];
type Answer<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;
const NONE: readonly never[] = Object.freeze([]);
const json = (value: unknown) => (value ?? null) as Json;
// The UI stops waiting by itself; reading changes nothing, so it finishes.
const unstopped = () => new AbortController().signal;

/** The runtime's side. */
export function servePi(setup: PiSetup, runtime: PiRuntime): Served {
  type Args = Readonly<Record<string, unknown>>;
  const changed = (listener: () => void) => runtime.subscribe(listener);
  // Each change the runtime tells of, as a count, so the UI rereads what it
  // asks for by command (its places) on the same changes.
  let changes = 0;
  const counted = new Set<() => void>();
  let stop: (() => void) | undefined;
  return {
    topics: {
      changes: () => ({
        get: () => changes,
        subscribe(listener) {
          counted.add(listener);
          stop ??= changed(() => {
            changes += 1;
            for (const each of [...counted]) each();
          });
          return () => {
            counted.delete(listener);
            if (counted.size) return;
            stop?.();
            stop = undefined;
          };
        },
      }),
      working: viewTopic(changed, (key: AgentKey) => runtime.working(key)),
    },
    commands: {
      providers: () => setup.providers().then(json),
      models: (id) => setup.models(id as string).then(json),
      login: async (args) => {
        const { id, key } = args as Args;
        await setup.login(id as string, key as string);
        return null;
      },
      test: (choice) =>
        setup.test(choice as Parameters<PiSetup["test"]>[0]).then(json),
      places: (agent) => runtime.places(agent as AgentKey).then(json),
      transcript: (args) => {
        const { agent, place, working } = args as Args;
        return runtime
          .transcript(
            agent as AgentKey,
            place as Place,
            working as boolean,
            unstopped(),
          )
          .then(json);
      },
    },
  };
}

/** The UI's side: the runtime's handles, reached over `link`. */
export function linkPi(link: RuntimeLink): PiExposed {
  const changes = linkedStore<number>(link, "changes", 0);
  const working = linkedView<AgentKey, ReturnType<PiRuntime["working"]>>(
    link,
    "working",
    NONE,
  );
  const ask = <T>(command: string, args: unknown = null) =>
    link.call(command, args as Json) as Promise<T>;
  return {
    setup: {
      providers: () => ask<Answer<PiSetup["providers"]>>("providers"),
      models: (id) => ask<Answer<PiSetup["models"]>>("models", id),
      login: async (id, key) => {
        await ask("login", { id, key });
      },
      test: (choice) => ask<Answer<PiSetup["test"]>>("test", choice),
    },
    runtime: {
      subscribe(listener) {
        const stops = [
          changes.subscribe(listener),
          working.subscribe(listener),
        ];
        return () => {
          for (const stop of stops) stop();
        };
      },
      working: (key) => working.read(key),
      places: (key) => ask<Answer<PiRuntime["places"]>>("places", key),
      transcript: (agent, place, working, signal) =>
        abortable(
          ask<Answer<PiRuntime["transcript"]>>("transcript", {
            agent,
            place,
            working,
          }),
          signal,
        ),
    },
  };
}
