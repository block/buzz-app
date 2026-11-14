import type { Context } from "@deepseek-ai/cordis";
import { createContributions } from "../../plugins/contributions";

/** Trusted routing supplied by the harness adapter, never by hook input. */
export type AgentHookContext = Readonly<{
  agent: string;
  session: string;
}>;
/** Event names, input and output formats belong to the selected agent type. */
export type AgentHook = Readonly<{
  id: string;
  harness: string;
  event: string;
  run(input: unknown, context: AgentHookContext): unknown | Promise<unknown>;
}>;

export function createAgentHooks(root: Context) {
  const contributions = createContributions<AgentHook>(root);
  return {
    register(ctx: Context, hook: AgentHook) {
      if (!ctx.pluginOwner?.agentHooks?.includes(hook.harness))
        throw new Error(`Declare host.agentHooks access for ${hook.harness}`);
      if (!hook.event.trim() || typeof hook.run !== "function")
        throw new Error("A hook needs an event and callback");
      contributions.register(ctx, hook);
    },
    validate(
      types: readonly {
        key: string;
        hooks?: Readonly<{ events: readonly string[] }>;
      }[],
    ) {
      for (const hook of contributions.snapshot()) {
        const type = types.find((type) => type.key === hook.harness);
        if (type && !type.hooks?.events.includes(hook.event))
          console.warn(
            "Unsupported agent hook",
            hook.key,
            hook.harness,
            hook.event,
          );
      }
    },
    /** Adapters compose results in their own native format. Look up handlers on
     * every event so enabling or removing a plugin needs no process restart. */
    handlers(harness: string, event: string) {
      return contributions
        .snapshot()
        .filter((hook) => hook.harness === harness && hook.event === event)
        .sort((a, b) => a.key.localeCompare(b.key));
    },
  };
}

export type AgentHookDispatchOptions = Readonly<{
  accepts(output: unknown): boolean;
  milliseconds: number;
  /** Label native output using the registered owner, independently of payload. */
  compose?(output: unknown, pluginId: string): unknown;
  /** Joins composed responses that only add context into one, in hook order;
   * undefined when any of them does more. Such responses don't end dispatch,
   * so every plugin's context reaches the agent. */
  join?(outputs: readonly unknown[]): unknown;
}>;

/** Adapters supply native response acceptance and an event-wide time budget. */
export function dispatchAgentHooks(
  hooks: readonly (AgentHook & { pluginId: string })[],
  input: unknown,
  context: AgentHookContext,
  accepts: (output: unknown) => boolean,
  milliseconds: number,
  compose?: AgentHookDispatchOptions["compose"],
  join?: AgentHookDispatchOptions["join"],
): Promise<unknown> {
  const deadline = Date.now() + milliseconds;
  const message = "Agent hook dispatch timed out";
  // Responses that only add context, kept while later callbacks run.
  const joined: unknown[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispatch = (async () => {
    const errors: unknown[] = [];
    for (const hook of hooks) {
      if (Date.now() >= deadline) {
        if (joined.length) break;
        throw new Error(message);
      }
      try {
        const output = await hook.run(input, context);
        if (!accepts(output)) continue;
        const composed = compose ? compose(output, hook.pluginId) : output;
        // The first response that does more than add context wins, as before.
        if (join?.([...joined, composed]) === undefined) return composed;
        joined.push(composed);
      } catch (error) {
        console.warn("Agent hook failed", hook.id, error);
        errors.push(error);
      }
    }
    if (joined.length) return join?.(joined);
    if (errors.length) throw errors[0];
    return undefined;
  })();
  // Context already gathered is delivered at the deadline; otherwise the
  // dispatch fails, as a callback that never answers would make it.
  const expired = new Promise<unknown>((resolve, reject) => {
    timer = setTimeout(
      () =>
        joined.length ? resolve(join?.(joined)) : reject(new Error(message)),
      milliseconds,
    );
  });
  return Promise.race([dispatch, expired]).finally(() => clearTimeout(timer));
}
