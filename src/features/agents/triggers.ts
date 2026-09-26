// The owner's client decides when a provider-backed agent is triggered. It reads
// mentions with the owner's access, admits them, and hands each one to the agent's
// provider plugin at most once. The provider acts as the agent through invoke().
import type { Communities } from "../communities/service";
import { communityDestination, relayOrigin } from "../communities/destination";
import { addChannelMember } from "../channel-members/members";
import type { RelaySession } from "../relay/session";
import type { VisibleEvent } from "../relay/projection";
import { threadReference } from "../relay/thread-reference";
import type { AgentControl, AgentView } from "./control";
import type { AgentProviders, AgentWork } from "./providers";

const LEDGER = "buzz.agent-triggers.v1";
const READ_LIMIT = 100;
/** Re-read this far back each scan; the handled ledger removes repeats. */
const OVERLAP_SECONDS = 600;
const RETAIN_SECONDS = 7 * 24 * 60 * 60;
const MAX_HANDLED = 5000;

type Ledger = {
  /** Per agent pubkey: nothing before this was ever eligible. */
  floors: Record<string, number>;
  /** `${eventId}:${agentPubkey}` → handled-at seconds. */
  handled: Record<string, number>;
};
export type TriggerStorage = Pick<Storage, "getItem" | "setItem">;

function loadLedger(storage: TriggerStorage | undefined, key: string): Ledger {
  try {
    const value = JSON.parse(storage?.getItem(key) ?? "null") as Ledger | null;
    if (
      value &&
      typeof value.floors === "object" &&
      typeof value.handled === "object"
    )
      return value;
  } catch {
    // A corrupt ledger restarts from now; it never replays old history.
  }
  return { floors: {}, handled: {} };
}
function saveLedger(
  storage: TriggerStorage | undefined,
  key: string,
  ledger: Ledger,
  now: number,
) {
  const kept = Object.entries(ledger.handled)
    .filter(([, at]) => now - at < RETAIN_SECONDS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_HANDLED);
  ledger.handled = Object.fromEntries(kept);
  try {
    storage?.setItem(key, JSON.stringify(ledger));
  } catch {
    // Quota failure keeps the in-memory ledger for this session.
  }
}

const channelOf = (event: VisibleEvent) => {
  const destinations = event.tags.filter(([name]) => name === "h");
  return destinations.length === 1 ? destinations[0]?.[1] : undefined;
};
const mentions = (event: VisibleEvent, pubkey: string) =>
  event.tags.some(([name, value]) => name === "p" && value === pubkey);

/** Bind to the selected community's ready session, like mention wake. */
export function bindAgentTriggers(
  control: AgentControl,
  providers: AgentProviders,
  communities: Communities,
  storage: TriggerStorage | undefined = globalThis.localStorage,
) {
  let session: RelaySession | undefined;
  let identity = "";
  let stopScope = () => {};
  const update = () => {
    const client = communities.snapshot();
    const relay = communities.relay.snapshot();
    const origin = client.selected
      ? communityDestination(client.selected).url
      : "";
    const next = `${client.viewer}:${origin}:${relay.status}`;
    if (session === relay.session && identity === next) return;
    stopScope();
    stopScope = () => {};
    session = relay.session;
    identity = next;
    if (
      relay.status !== "ready" ||
      !origin ||
      !client.viewer ||
      relay.viewer !== client.viewer
    )
      return;
    stopScope = startScope(
      relay.session,
      client.viewer,
      origin,
      control,
      providers,
      storage,
    );
  };
  const stop = communities.relay.subscribe(update);
  const stopCommunity = communities.subscribe(update);
  update();
  return () => {
    stopScope();
    stop();
    stopCommunity();
  };
}

function startScope(
  session: RelaySession,
  viewer: string,
  origin: string,
  control: AgentControl,
  providers: AgentProviders,
  storage: TriggerStorage | undefined,
) {
  const lifetime = new AbortController();
  const key = `${LEDGER}:${viewer}:${relayOrigin(origin)}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scanning = false;
  let again = false;
  let bound = "";

  /** Provider-backed agents in this community whose provider is active now. */
  const agents = (): AgentView[] => {
    const active = new Set(providers.snapshot().map((entry) => entry.key));
    return (control.snapshot().data?.agents ?? []).filter(
      (agent) =>
        !!agent.provider &&
        active.has(agent.provider) &&
        relayOrigin(agent.relayUrl) === relayOrigin(origin),
    );
  };
  const schedule = (delay = 250) => {
    if (lifetime.signal.aborted) return;
    clearTimeout(timer);
    timer = setTimeout(() => void scan(), delay);
  };
  const rebind = () => {
    const next = agents()
      .map((agent) => `${agent.id}:${agent.provider}`)
      .sort()
      .join(",");
    if (next === bound) return;
    bound = next;
    schedule(0);
  };

  async function scan() {
    if (scanning) {
      again = true;
      return;
    }
    scanning = true;
    try {
      do {
        again = false;
        await scanOnce();
      } while (again && !lifetime.signal.aborted);
    } catch (error) {
      if (!lifetime.signal.aborted)
        console.warn("Agent trigger scan failed", error);
    } finally {
      scanning = false;
    }
  }

  async function scanOnce() {
    const targets = agents();
    if (!targets.length) return;
    const now = Math.floor(Date.now() / 1000);
    const ledger = loadLedger(storage, key);
    // A newly bound agent starts listening now; earlier history is never replayed.
    for (const agent of targets) ledger.floors[agent.pubkey] ??= now - 60;
    saveLedger(storage, key, ledger, now);
    // One filter per agent: the relay only narrows a single-value #p in SQL.
    const events = (await session.read(
      targets.map((agent) => ({
        kinds: [9],
        "#p": [agent.pubkey],
        since: ledger.floors[agent.pubkey] ?? now - 60,
        limit: READ_LIMIT,
      })),
      { signal: lifetime.signal, fresh: true, priority: "background" },
    )) as readonly VisibleEvent[];
    if (lifetime.signal.aborted) return;
    const agentKeys = new Set(
      (control.snapshot().data?.agents ?? []).map((agent) => agent.pubkey),
    );
    const ordered = [...events].sort(
      (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
    );
    for (const event of ordered) {
      // Only relay-accepted events; a pending local send is not yet work.
      if (event.delivery && !["accepted", "seen"].includes(event.delivery))
        continue;
      // Agents never trigger each other through this path.
      if (agentKeys.has(event.pubkey)) continue;
      const channelId = channelOf(event);
      if (!channelId) continue;
      const channel =
        session.channels
          .list()
          .channels.find((item) => item.id === channelId) ??
        session.channels.get?.(channelId);
      // The owner's own membership is the agent's access rule, even in open channels.
      if (!channel?.members?.includes(viewer)) continue;
      for (const agent of targets) {
        if (!mentions(event, agent.pubkey)) continue;
        if (agent.respondTo !== "anyone" && event.pubkey !== viewer) continue;
        const deliveryId = `${event.id}:${agent.pubkey}`;
        if (ledger.handled[deliveryId]) continue;
        // Record before dispatch: at most once, never a blind replay after a crash.
        ledger.handled[deliveryId] = now;
        saveLedger(storage, key, ledger, now);
        void dispatch(agent, event, channelId, deliveryId).catch((error) => {
          if (!lifetime.signal.aborted)
            console.warn(`Agent provider failed for ${agent.name}`, error);
        });
      }
    }
    for (const agent of targets)
      ledger.floors[agent.pubkey] = Math.max(
        ledger.floors[agent.pubkey] ?? 0,
        now - OVERLAP_SECONDS,
      );
    saveLedger(storage, key, ledger, now);
  }

  async function dispatch(
    agent: AgentView,
    event: VisibleEvent,
    channelId: string,
    deliveryId: string,
  ) {
    const provider = providers
      .snapshot()
      .find((entry) => entry.key === agent.provider);
    if (!provider || !agent.provider) return;
    const channel =
      session.channels.list().channels.find((item) => item.id === channelId) ??
      session.channels.get?.(channelId);
    // The owner invites the agent before it acts; the relay then admits its reads/writes.
    if (!channel?.members?.includes(agent.pubkey))
      await addChannelMember(session, channelId, agent.pubkey, lifetime.signal);
    const thread = threadReference(event);
    const work: AgentWork = Object.freeze({
      deliveryId,
      agent: Object.freeze({
        id: agent.id,
        pubkey: agent.pubkey,
        name: agent.name,
        relayUrl: agent.relayUrl,
        config: Object.freeze({ ...(agent.providerConfig ?? {}) }),
      }),
      owner: viewer,
      channelId,
      replyTo: thread?.rootId ?? event.id,
      threadRootId: thread?.rootId ?? null,
      message: Object.freeze({
        id: event.id,
        author: event.pubkey,
        content: event.content,
        createdAt: event.created_at,
        tags: event.tags,
      }),
    });
    const providerKey = agent.provider;
    await provider.handle(work, {
      signal: lifetime.signal,
      invoke: (request) => {
        if (!control.invoke)
          return Promise.reject(
            new Error("Provider agents need the desktop app to run."),
          );
        return control.invoke({
          ...request,
          id: agent.id,
          provider: providerKey,
        });
      },
    });
  }

  const stopIncoming = session.subscribeIncoming(() => schedule());
  const stopSend =
    session.outbox?.observeSend((event) => {
      if (event.kind !== 9 || event.pubkey !== viewer) return;
      const targets = new Set(agents().map((agent) => agent.pubkey));
      if (
        !event.tags.some(
          ([name, value]) => name === "p" && targets.has(value ?? ""),
        )
      )
        return;
      // Runs after the relay accepts the send.
      return () => schedule(0);
    }) ?? (() => {});
  const stopControl = control.subscribe(rebind);
  const stopProviders = providers.subscribe(rebind);
  // Catch-up needs the local inventory; read it once if nothing has yet.
  if (control.snapshot().status === "idle") void control.refresh();
  rebind();
  // Catch up on anything that arrived while this client was closed or asleep.
  schedule(1000);
  return () => {
    lifetime.abort();
    clearTimeout(timer);
    stopIncoming();
    stopSend();
    stopControl();
    stopProviders();
  };
}
