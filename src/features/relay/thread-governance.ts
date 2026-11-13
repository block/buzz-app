import type { ProfileQueries } from "./profile-directory";
import type { EventData, RelayEvent } from "./events";
import { messageAuthor } from "./fold";
import { eventMs } from "./message-order";
import type { Outbox } from "./outbox";
import type { RelayReader } from "./reader";
import { threadReference } from "./thread-reference";
import { attestedOwner } from "../agents/owner-attestation";
import { objectBody } from "./body";
import { lifecycleChannelId } from "./channel-lifecycle-protocol";

export const THREAD_GOVERNANCE_KIND = 42001;
export const THREAD_TURN_THRESHOLD = 10;
const TYPE = "buzz.thread-governance/v1";
const HEX = /^[0-9a-f]{64}$/;

export type ThreadGovernanceSource = Readonly<{
  channelId: string;
  root: string;
}>;
export type ThreadGovernanceAction =
  | "completed"
  | "extend"
  | "scope-change"
  | "blocker-open"
  | "blocker-resolved"
  | "closed"
  | "defer";
export type ThreadGovernanceState = Readonly<{
  count: number;
  threshold: number;
  tripped: boolean;
  closed: boolean;
  deferred: boolean;
  goal?: string;
  resets: readonly Readonly<{
    action:
      | "human"
      | "extend"
      | "scope-change"
      | "blocker-open"
      | "blocker-resolved";
    by: string;
    at: number;
    reason?: string;
  }>[];
  extensions: readonly Readonly<{
    by: string;
    at: number;
    reason: string;
    threshold: number;
  }>[];
}>;

export type ThreadGovernanceView = Readonly<{
  snapshot(): ThreadGovernanceState;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  dispose(): void;
}>;

export interface ThreadGovernanceCapability {
  readonly available: boolean;
  dispose(): void;
  view(source: ThreadGovernanceSource): ThreadGovernanceView;
  admit(
    source: ThreadGovernanceSource,
    agent: string,
    signal: AbortSignal,
  ): Promise<{
    completed(): void;
  }>;
  act(
    source: ThreadGovernanceSource,
    action: Exclude<ThreadGovernanceAction, "completed">,
    input?: Readonly<{ reason?: string; threshold?: number; goal?: string }>,
  ): void;
}

type GovernanceRecord = Readonly<{
  event: EventData;
  action: ThreadGovernanceAction;
  agent?: string;
  reason?: string;
  threshold?: number;
  goal?: string;
}>;

const emptyState = (): ThreadGovernanceState =>
  Object.freeze({
    count: 0,
    threshold: THREAD_TURN_THRESHOLD,
    tripped: false,
    closed: false,
    deferred: false,
    resets: Object.freeze([]),
    extensions: Object.freeze([]),
  });

function exactTag(event: Pick<EventData, "tags">, name: string) {
  const tags = event.tags.filter(([key]) => key === name);
  return tags.length === 1 && tags[0]?.length === 2 ? tags[0][1] : undefined;
}

function record(
  event: EventData,
  source: ThreadGovernanceSource,
): GovernanceRecord | undefined {
  if (
    event.kind !== THREAD_GOVERNANCE_KIND ||
    exactTag(event, "h") !== source.channelId ||
    exactTag(event, "type") !== TYPE
  )
    return;
  const roots = event.tags.filter(
    ([name, value, , marker]) =>
      name === "e" && value === source.root && marker === "root",
  );
  const action = exactTag(event, "action") as
    | ThreadGovernanceAction
    | undefined;
  if (
    roots.length !== 1 ||
    !action ||
    ![
      "completed",
      "extend",
      "scope-change",
      "blocker-open",
      "blocker-resolved",
      "closed",
      "defer",
    ].includes(action)
  )
    return;
  try {
    const body = event.content
      ? (JSON.parse(event.content) as Record<string, unknown>)
      : {};
    if (body.version !== 1) return;
    const agent =
      typeof body.agent === "string" && HEX.test(body.agent)
        ? body.agent
        : undefined;
    const reason =
      typeof body.reason === "string" && body.reason.trim()
        ? body.reason.trim()
        : undefined;
    const threshold =
      Number.isInteger(body.threshold) &&
      Number(body.threshold) >= THREAD_TURN_THRESHOLD
        ? Number(body.threshold)
        : undefined;
    const goal =
      typeof body.goal === "string" &&
      body.goal.trim() &&
      [...body.goal.trim()].length <= 2000
        ? body.goal.trim()
        : undefined;
    if (action === "completed" && !agent) return;
    if (action === "extend" && (!reason || threshold === undefined)) return;
    if (action === "scope-change" && (!reason || !goal)) return;
    if (["blocker-open", "blocker-resolved"].includes(action) && !reason)
      return;
    return {
      event,
      action,
      ...(agent ? { agent } : {}),
      ...(reason ? { reason } : {}),
      ...(threshold ? { threshold } : {}),
      ...(goal ? { goal } : {}),
    };
  } catch {
    return;
  }
}

const order = (a: EventData, b: EventData) =>
  eventMs(a) - eventMs(b) || a.id.localeCompare(b.id);

/** Pure authority fold. Owner-attested profiles, never `is_agent`, classify turns. */
export function foldThreadGovernance(
  source: ThreadGovernanceSource,
  events: readonly EventData[],
  ownerOf: (pubkey: string) => string | undefined,
  canManage: (pubkey: string) => boolean,
  relayAuthor?: string,
): ThreadGovernanceState {
  let count = 0;
  let threshold = THREAD_TURN_THRESHOLD;
  let closed = false;
  let deferred = false;
  let goal: string | undefined;
  const resets: ThreadGovernanceState["resets"][number][] = [];
  const extensions: ThreadGovernanceState["extensions"][number][] = [];
  for (const event of [
    ...new Map(events.map((event) => [event.id, event])).values(),
  ].sort(order)) {
    const governance = record(event, source);
    if (governance) {
      const actor = messageAuthor(event, relayAuthor);
      if (governance.action === "completed") {
        if (governance.agent && ownerOf(governance.agent) === actor) count++;
        continue;
      }
      if (!canManage(actor)) continue;
      const { action, reason } = governance;
      if (action === "closed") {
        closed = true;
        continue;
      }
      if (action === "defer") {
        deferred = true;
        continue;
      }
      count = 0;
      closed = false;
      deferred = false;
      if (action === "extend") {
        if (!reason) continue;
        threshold = governance.threshold ?? threshold;
        extensions.push({ by: actor, at: eventMs(event), reason, threshold });
      }
      if (action === "scope-change") goal = governance.goal;
      resets.push({
        action,
        by: actor,
        at: eventMs(event),
        ...(reason ? { reason } : {}),
      });
      continue;
    }
    if (![9, 40002].includes(event.kind)) continue;
    const reference = threadReference(event);
    const inSource =
      event.id === source.root || reference?.rootId === source.root;
    if (!inSource) continue;
    const actor = messageAuthor(event, relayAuthor);
    const body =
      event.kind === 40002 ? objectBody(event.content)?.content : event.content;
    const content = typeof body === "string" ? body.trim() : "";
    const blocker = content.match(
      /^\[BLOCKER(?:\s+(RESOLVED))?\](?:\s+([\s\S]+))?/i,
    );
    if (blocker) {
      count = 0;
      closed = false;
      deferred = false;
      resets.push({
        action: blocker[1] ? "blocker-resolved" : "blocker-open",
        by: actor,
        at: eventMs(event),
        ...(blocker[2]?.trim() ? { reason: blocker[2].trim() } : {}),
      });
      continue;
    }
    const scope = content.match(/^\[SCOPE CHANGE\]\s+([\s\S]+)$/i);
    if (scope && canManage(actor)) {
      count = 0;
      closed = false;
      deferred = false;
      goal = scope[1]?.trim();
      resets.push({
        action: "scope-change",
        by: actor,
        at: eventMs(event),
        reason: "Signed thread message",
      });
      continue;
    }
    if (!ownerOf(actor)) {
      count = 0;
      closed = false;
      deferred = false;
      resets.push({ action: "human", by: actor, at: eventMs(event) });
    }
  }
  return Object.freeze({
    count,
    threshold,
    tripped: closed || deferred || count >= threshold,
    closed,
    deferred,
    ...(goal ? { goal } : {}),
    resets: Object.freeze(resets),
    extensions: Object.freeze(extensions),
  });
}

function template(
  source: ThreadGovernanceSource,
  action: ThreadGovernanceAction,
  input: Readonly<{
    agent?: string;
    reason?: string;
    threshold?: number;
    goal?: string;
  }> = {},
) {
  lifecycleChannelId(source.channelId);
  if (!HEX.test(source.root)) throw new Error("Invalid thread source");
  if (action === "completed" && (!input.agent || !HEX.test(input.agent)))
    throw new Error("Invalid agent identity");
  if (
    action === "extend" &&
    (!input.reason?.trim() ||
      !Number.isInteger(input.threshold) ||
      Number(input.threshold) < THREAD_TURN_THRESHOLD)
  )
    throw new Error("A reason and valid turn budget are required");
  if (
    action === "scope-change" &&
    (!input.reason?.trim() ||
      !input.goal?.trim() ||
      [...input.goal.trim()].length > 2000)
  )
    throw new Error(
      "A reason and thread GOAL of at most 2,000 characters are required",
    );
  if (
    (action === "blocker-open" || action === "blocker-resolved") &&
    !input.reason?.trim()
  )
    throw new Error("A blocker reason is required");
  const now = Date.now();
  return {
    kind: THREAD_GOVERNANCE_KIND,
    created_at: Math.floor(now / 1000),
    content: JSON.stringify({ version: 1, ...input }),
    tags: [
      ["h", source.channelId],
      ["e", source.root, "", "root"],
      ["type", TYPE],
      ["action", action],
      ["ms", String(now % 1000)],
    ],
  };
}

export function createThreadGovernance({
  reader,
  outbox,
  profiles,
  viewer,
  relayAuthor,
  canManage,
  receive,
}: {
  reader?: RelayReader;
  outbox?: Outbox;
  profiles: ProfileQueries;
  viewer: string;
  relayAuthor?: string;
  canManage(pubkey: string, channelId: string): boolean;
  receive(listener: (events: readonly RelayEvent[]) => void): () => void;
}): ThreadGovernanceCapability {
  const views = new Map<
    string,
    Set<{
      source: ThreadGovernanceSource;
      events: EventData[];
      owners: Map<string, string>;
      state: ThreadGovernanceState;
      listeners: Set<() => void>;
      disposed: boolean;
    }>
  >();
  const key = ({ channelId, root }: ThreadGovernanceSource) =>
    `${channelId}:${root}`;
  const local = () =>
    outbox
      ?.snapshot()
      .filter((item) => item.delivery !== "failed")
      .map((item) => item.event) ?? [];
  const failedCompletion = (source: ThreadGovernanceSource) =>
    outbox
      ?.snapshot()
      .some(
        (item) =>
          item.delivery === "failed" &&
          record(item.event, source)?.action === "completed",
      ) ?? false;
  const publish = (view: NonNullable<ReturnType<typeof make>>) => {
    const state = foldThreadGovernance(
      view.source,
      [...view.events, ...local()],
      (pubkey) => profiles.owner?.(pubkey) ?? view.owners.get(pubkey),
      (pubkey) => canManage(pubkey, view.source.channelId),
      relayAuthor,
    );
    if (JSON.stringify(state) === JSON.stringify(view.state)) return;
    view.state = state;
    for (const listener of view.listeners) listener();
  };
  async function verifiedOwners(
    source: ThreadGovernanceSource,
    events: readonly EventData[],
  ) {
    const authors = [
      ...new Set(
        events.flatMap((event) => {
          const agent = record(event, source)?.agent;
          return [messageAuthor(event, relayAuthor), ...(agent ? [agent] : [])];
        }),
      ),
    ];
    await profiles.ensure(authors, "foreground");
    const owners = await Promise.all(
      authors.map(async (author) => {
        const event = profiles.event?.(author);
        const owner = event ? await attestedOwner(event) : undefined;
        return owner ? ([author, owner] as const) : undefined;
      }),
    );
    return new Map(
      owners.filter((item): item is readonly [string, string] => !!item),
    );
  }
  const accept = (incoming: readonly EventData[]) => {
    for (const group of views.values())
      for (const view of group) {
        const matched = incoming.filter((event) =>
          event.tags.some(
            ([name, value]) => name === "h" && value === view.source.channelId,
          ),
        );
        if (!matched.length) continue;
        const byId = new Map(
          [...view.events, ...matched].map((event) => [event.id, event]),
        );
        view.events = [...byId.values()];
        publish(view);
        void verifiedOwners(view.source, matched)
          .then((owners) => {
            if (view.disposed) return;
            view.owners = new Map([...view.owners, ...owners]);
            publish(view);
          })
          .catch(() => {});
      }
  };
  const stopReceive = receive(accept);
  const stopLocal = outbox?.subscribe(() => {
    for (const group of views.values()) for (const view of group) publish(view);
  });
  const stopProfiles = profiles.subscribe(() => {
    for (const group of views.values()) for (const view of group) publish(view);
  });

  function make(source: ThreadGovernanceSource) {
    return {
      source,
      events: [] as EventData[],
      owners: new Map<string, string>(),
      state: emptyState(),
      listeners: new Set<() => void>(),
      disposed: false,
    };
  }
  async function refresh(
    view: NonNullable<ReturnType<typeof make>>,
    signal?: AbortSignal,
  ) {
    if (!reader)
      throw new Error("Thread controls are unavailable on this connection");
    const events = await reader.read(
      [
        {
          kinds: [THREAD_GOVERNANCE_KIND],
          "#h": [view.source.channelId],
          "#e": [view.source.root],
          limit: 500,
          consistency: "strong",
        },
        {
          kinds: [9, 40002],
          "#h": [view.source.channelId],
          "#e": [view.source.root],
          limit: 500,
          consistency: "strong",
        },
        {
          kinds: [9, 40002],
          "#h": [view.source.channelId],
          ids: [view.source.root],
          limit: 1,
          consistency: "strong",
        },
      ],
      { ...(signal ? { signal } : {}), fresh: true, priority: "foreground" },
    );
    const owners = await verifiedOwners(view.source, events);
    signal?.throwIfAborted();
    if (view.disposed) return;
    view.events = [
      ...new Map(events.map((event) => [event.id, event])).values(),
    ];
    view.owners = owners;
    publish(view);
  }
  function send(
    source: ThreadGovernanceSource,
    action: ThreadGovernanceAction,
    input?: Readonly<{
      agent?: string;
      reason?: string;
      threshold?: number;
      goal?: string;
    }>,
  ) {
    if (!outbox?.supports(THREAD_GOVERNANCE_KIND))
      throw new Error("Thread controls are unavailable on this connection");
    return outbox.send(template(source, action, input));
  }
  const capability: ThreadGovernanceCapability = Object.freeze({
    available: !!reader && !!outbox?.supports(THREAD_GOVERNANCE_KIND),
    dispose() {
      stopReceive();
      stopLocal?.();
      stopProfiles();
      for (const group of views.values())
        for (const view of group) view.disposed = true;
      views.clear();
    },
    view(source: ThreadGovernanceSource) {
      const view = make(source);
      const id = key(source);
      const group = views.get(id) ?? new Set();
      group.add(view);
      views.set(id, group);
      return Object.freeze({
        snapshot: () => view.state,
        subscribe(listener: () => void) {
          view.listeners.add(listener);
          return () => view.listeners.delete(listener);
        },
        refresh: () => refresh(view),
        dispose() {
          if (view.disposed) return;
          view.disposed = true;
          view.listeners.clear();
          group.delete(view);
          if (!group.size) views.delete(id);
        },
      });
    },
    async admit(
      source: ThreadGovernanceSource,
      agent: string,
      signal: AbortSignal,
    ) {
      if (!HEX.test(agent)) throw new Error("Invalid agent identity");
      if (failedCompletion(source))
        throw new Error(
          "The previous agent turn's thread record was not saved. Retry it before starting another turn.",
        );
      const view = make(source);
      await refresh(view, signal);
      if (failedCompletion(source))
        throw new Error(
          "The previous agent turn's thread record was not saved. Retry it before starting another turn.",
        );
      if (view.state.tripped)
        throw new Error(
          `Thread turn budget reached (${view.state.count}/${view.state.threshold}). An owner or lead must close, extend, change scope, or move the remainder to DEFER.`,
        );
      let done = false;
      return Object.freeze({
        completed() {
          if (done) return;
          done = true;
          send(source, "completed", { agent });
        },
      });
    },
    act(
      source: ThreadGovernanceSource,
      action: Exclude<ThreadGovernanceAction, "completed">,
      input?: Readonly<{ reason?: string; threshold?: number; goal?: string }>,
    ) {
      if (!canManage(viewer, source.channelId))
        throw new Error(
          "Only a channel owner or lead can change the thread budget",
        );
      send(source, action, input);
    },
  });
  return capability;
}
