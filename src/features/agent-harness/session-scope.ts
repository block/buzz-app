import type { SessionControls } from "./session-control";
import type { AgentKey } from "../agents/membership";
import type { AgentStore } from "../agents/store";

export type SessionScope = "thread" | "channel" | "community";

// Channel ids cannot contain this reserved prefix. Agent membership supplies
// the community boundary; this key never names a relay channel.
export const COMMUNITY_SESSION = "@community";

export const sessionScope = (value: unknown): SessionScope =>
  value === "community" || value === "channel" ? value : "thread";

/** Selects harness identity without changing the request's reply destination. */
export function scopedSessionKey(
  scope: SessionScope,
  channelId: string,
  root?: string,
) {
  return scope === "community"
    ? COMMUNITY_SESSION
    : scope === "thread" && root
      ? `${channelId}/${root}`
      : channelId;
}

export const scopeOfSession = (key: string, channelId: string): SessionScope =>
  key === COMMUNITY_SESSION
    ? "community"
    : key === channelId
      ? "channel"
      : "thread";

const sourceKey = (agent: AgentKey) =>
  `buzz.agents.community-session-source.v1:${agent}`;

/** Navigation metadata only. It never selects a session or grants access. */
export async function rememberCommunitySource(
  storage: AgentStore,
  agent: AgentKey,
  key: string,
  channelId: string,
) {
  if (key === COMMUNITY_SESSION) await storage.set(sourceKey(agent), channelId);
}

export function sessionSource(
  storage: AgentStore,
  agent: AgentKey,
  key: string,
): { channelId: string; root?: string; community?: true } {
  if (key === COMMUNITY_SESSION)
    return {
      channelId: storage.get(sourceKey(agent)) ?? "",
      community: true as const,
    };
  const [channelId = key, root] = key.split("/");
  return { channelId, ...(root ? { root } : {}) };
}

type Policy = {
  topLevel: boolean;
  handed: Promise<unknown>;
  settled: Promise<unknown>;
  cancel(): void;
};

/** An unaddressed wake joins the shared lifetime with no tool destination.
 * Its tools cannot replace a conversation's defaults until that turn ends. */
export async function communityTurn<T>(
  policies: Map<string, Policy>,
  signal: AbortSignal,
  controls: SessionControls,
  control: string,
  run: (signal: AbortSignal) => Promise<T>,
) {
  const prior = [...policies.values()];
  const cancel = new AbortController();
  const lifetime = AbortSignal.any([signal, cancel.signal]);
  const done = Promise.resolve().then(async () => {
    await Promise.all(prior.map((policy) => policy.settled));
    lifetime.throwIfAborted();
    let result!: T;
    await controls.deliver(control, async () => {
      lifetime.throwIfAborted();
      result = await run(lifetime);
    }).done;
    return result;
  });
  const policy = {
    topLevel: false,
    handed: done,
    settled: done.catch(() => undefined),
    cancel: () => cancel.abort(),
  };
  policies.set(COMMUNITY_SESSION, policy);
  try {
    return await done;
  } finally {
    if (policies.get(COMMUNITY_SESSION) === policy)
      policies.delete(COMMUNITY_SESSION);
  }
}
