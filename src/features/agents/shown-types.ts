// An agent type as the Manager shows it: what the Runner says of the type
// (`TypeInfo`), with what its plugin's UI entry presents. What needs the
// runtime (models, usage, session state, the provider's status) is asked of
// the Runner over the link.
import { abortable } from "./exposed";
import type { managerSide, ProviderStatus, TypeInfo } from "./runner-link";
import type {
  Agent,
  AgentPresentation,
  AgentProvider,
  AgentType,
  Models,
  RegisteredAgentType,
  SessionPlace,
  SessionState,
  SessionUsage,
} from "./service";

type Runner = Pick<
  ReturnType<typeof managerSide>,
  | "models"
  | "usage"
  | "session"
  | "sessionState"
  | "watchSession"
  | "provider"
  | "watchProvider"
  | "check"
  | "attend"
>;

/** What only `present` gives for a type that runs here. */
export const PRESENTED = [
  "icon",
  "Peek",
  "Create",
  "CreateModel",
  "tabs",
  "adopt",
  "importShared",
  "carry",
  "describeMigration",
  "migrationWarning",
  "summary",
] as const;

const CHECKING = Object.freeze({ readiness: "checking" as const });

/** The type the Manager's readers see, until `close`. */
export function shownType(
  info: TypeInfo,
  runner: Runner,
  shown: AgentPresentation | undefined,
): Readonly<{ type: RegisteredAgentType; close(): void }> {
  const stops = new Set<() => void>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  // One watch for each agent and place read, of the agent as last read.
  const sessions = new Map<string, Readonly<{ agent: string; stop(): void }>>();
  const state = (agent: Agent, place: SessionPlace): SessionState => {
    const id = `${agent.key}\n${JSON.stringify(place)}`;
    const json = JSON.stringify(agent);
    const watched = sessions.get(id);
    if (watched?.agent !== json) {
      if (watched) {
        stops.delete(watched.stop);
        watched.stop();
      }
      const stop = runner.watchSession(info, agent, place, notify);
      stops.add(stop);
      sessions.set(id, { agent: json, stop });
    }
    return runner.sessionState(info, agent, place) ?? "unavailable";
  };
  let status: ProviderStatus | undefined;
  if (info.has.provider)
    stops.add(
      runner.watchProvider(info, () => {
        status = runner.provider(info) ?? undefined;
        notify();
      }),
    );
  const provider: AgentProvider | undefined = info.has.provider
    ? {
        snapshot: () => status?.snapshot ?? CHECKING,
        subscribe,
        check: () => runner.check(info),
        get attentionAction() {
          return status?.attend ? () => void runner.attend(info) : undefined;
        },
        ...(shown?.provider?.DialogBody && {
          DialogBody: shown.provider.DialogBody,
        }),
        ...(shown?.provider?.DefaultControl && {
          DefaultControl: shown.provider.DefaultControl,
        }),
      }
    : undefined;
  // Only what a type shows and how it is managed comes from `present`.
  const presented: Partial<AgentType> = {};
  for (const field of PRESENTED)
    if (shown?.[field] !== undefined)
      Object.assign(presented, { [field]: shown[field] });
  const sessionScope = shown?.sessionScope;
  const type: AgentType = {
    ...presented,
    id: info.id,
    title: info.title,
    ...(info.description !== undefined && { description: info.description }),
    ...(info.timeoutMs !== undefined && { timeoutMs: info.timeoutMs }),
    ...(info.resumes !== undefined && { resumes: info.resumes }),
    defaults: () => {
      if (info.defaults === undefined)
        throw new Error(`Agent type ${info.key} has invalid defaults`);
      return structuredClone(info.defaults) as ReturnType<
        AgentType["defaults"]
      >;
    },
    ...(info.has.models && {
      models: async (agent: Agent) =>
        (await runner.models(info, agent)) as Models,
    }),
    ...(info.has.usage && {
      usage: async (
        agent: Agent,
        { since, signal }: Readonly<{ since: number; signal: AbortSignal }>,
      ) =>
        (await abortable(
          runner.usage(info, agent, since),
          signal,
        )) as readonly SessionUsage[],
    }),
    ...(info.has.sessionControls && {
      sessionControls: {
        ...(sessionScope && { scope: sessionScope }),
        state,
        run: (agent, place, action) =>
          runner.session(agent.key, info.key, place, action),
        subscribe,
      },
    }),
    ...(provider && { provider }),
  };
  return {
    type: Object.freeze({
      ...type,
      key: info.key,
      pluginId: info.pluginId,
      revision: info.revision,
    }) as RegisteredAgentType,
    close() {
      for (const stop of stops) stop();
      stops.clear();
      sessions.clear();
      listeners.clear();
    },
  };
}
