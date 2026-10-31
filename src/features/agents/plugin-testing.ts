import type { PluginModule } from "../../plugins/api";
import type { RuntimeLink } from "./exposed";
import { link, type LinkPort, type Served } from "./link";
import type { AgentPresentation, AgentProvider, AgentType } from "./service";
import { PRESENTED } from "./shown-types";

type Present<Config> = (runtime: RuntimeLink) => AgentPresentation<Config>;

/** Starts a harness plugin's agent entry, then its UI entry, on `ctx`, and
 * returns the type it registered with what it presents, its UI reaching the
 * runtime over a link as from another page. Undefined when it registered
 * none. */
export function appliedType<Config>(
  module: Pick<PluginModule, "apply" | "agent">,
  ctx: Readonly<{ agents: object }> & Record<string, unknown>,
): AgentType<Config> | undefined {
  let type: AgentType<Config> | undefined;
  let present: Present<Config> | undefined;
  Object.assign(ctx.agents, {
    register: (registered: AgentType<Config>) => {
      type = registered;
    },
    present: (_id: string, shown: Present<Config>) => {
      present = shown;
    },
  });
  void module.agent?.apply(ctx as never);
  void module.apply(ctx as never);
  if (!type || !present) return type;
  return merged(type, present(runtimeLink(type.expose)));
}

/** What a type's UI reaches of `served`, over a link as from another page.
 * Its messages pass as microtasks, so a macrotask later (`delivered`) each
 * one sent before has arrived, with what it answered. */
export function runtimeLink(served: Served | undefined): RuntimeLink {
  const [runtime, ui] = ports();
  link(runtime, served);
  return link(ui);
}

/** Waits until what the links sent so far, and what that changed, has
 * arrived. */
export const delivered = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

function ports(): [LinkPort, LinkPort] {
  const pair: LinkPort[] = [];
  const port = (other: () => LinkPort | undefined): LinkPort => {
    let closed = false;
    return {
      onmessage: null,
      postMessage(message) {
        // Only what a structured clone keeps crosses, as between pages.
        const data = structuredClone(message);
        queueMicrotask(() => {
          const to = other();
          if (!closed) to?.onmessage?.({ data } as MessageEvent);
        });
      },
      close() {
        closed = true;
      },
    };
  };
  pair.push(
    port(() => pair[1]),
    port(() => pair[0]),
  );
  return pair as [LinkPort, LinkPort];
}

/** The type as the Manager shows it: what it registered, with what its UI
 * entry presents. */
function merged<Config>(
  type: AgentType<Config>,
  shown: AgentPresentation<Config>,
): AgentType<Config> {
  const merged: AgentType<Config> = { ...type };
  for (const field of PRESENTED)
    if (shown[field] !== undefined)
      Object.assign(merged, { [field]: shown[field] });
  if (type.sessionControls && shown.sessionScope)
    merged.sessionControls = {
      ...type.sessionControls,
      scope: shown.sessionScope,
    };
  if (type.provider) {
    // Keep getters, such as `attentionAction`, live.
    const provider = Object.defineProperties(
      {},
      Object.getOwnPropertyDescriptors(type.provider),
    ) as AgentProvider;
    if (shown.provider?.DialogBody)
      Object.assign(provider, { DialogBody: shown.provider.DialogBody });
    if (shown.provider?.DefaultControl)
      Object.assign(provider, {
        DefaultControl: shown.provider.DefaultControl,
      });
    merged.provider = provider;
  }
  return merged;
}
