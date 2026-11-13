import type { ProfileQueries } from "./profile-directory";
import { eventDto, newer, type EventData, type RelayEvent } from "./events";
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
const PAGE = 500;
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
  ): Promise<void>;
}

type GovernanceRecord = Readonly<{
  event: EventData;
  action: ThreadGovernanceAction;
  agent?: string;
  reason?: string;
  threshold?: number;
  goal?: string;
  approval?: RelayEvent;
}>;

type OwnerHead = Readonly<{
  profile: RelayEvent;
  owner?: string;
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
    const approval =
      action === "completed" || body.approval === undefined
        ? undefined
        : eventDto(body.approval);
    if (action === "completed" && !agent) return;
    if (action !== "completed" && !approval) return;
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
      ...(approval ? { approval } : {}),
    };
  } catch {
    return;
  }
}

const order = (a: EventData, b: EventData) =>
  eventMs(a) - eventMs(b) || a.id.localeCompare(b.id);

type AdministratorHead = Readonly<{
  event: RelayEvent;
  roles: ReadonlyMap<string, "owner" | "admin">;
}>;

type ManagementAuthority = Readonly<{
  heads: readonly AdministratorHead[];
  roleChanges: readonly Readonly<{
    event: RelayEvent;
    target: string;
    role?: string;
  }>[];
}>;

function administratorHead(
  value: unknown,
  source: ThreadGovernanceSource,
  relayAuthor?: string,
): AdministratorHead | undefined {
  if (!relayAuthor) return;
  let approval: RelayEvent;
  try {
    approval = eventDto(value);
  } catch {
    return;
  }
  if (
    approval.kind !== 39001 ||
    approval.pubkey !== relayAuthor ||
    exactTag(approval, "d") !== source.channelId
  )
    return;
  const roles = new Map<string, "owner" | "admin">();
  for (const entry of approval.tags.filter(([name]) => name === "p")) {
    const [, pubkey, role] = entry;
    if (
      entry.length !== 3 ||
      !pubkey ||
      !HEX.test(pubkey) ||
      (role !== "owner" && role !== "admin") ||
      roles.has(pubkey)
    )
      return;
    roles.set(pubkey, role);
  }
  return {
    event: approval,
    roles,
  };
}

function managementAuthority(
  source: ThreadGovernanceSource,
  events: readonly EventData[],
  records: ReadonlyMap<string, GovernanceRecord>,
  relayAuthor?: string,
): ManagementAuthority {
  const heads = new Map<string, AdministratorHead>();
  const roleChanges = new Map<
    string,
    Readonly<{ event: RelayEvent; target: string; role?: string }>
  >();
  const addHead = (value: unknown) => {
    const head = administratorHead(value, source, relayAuthor);
    if (head) heads.set(head.event.id, head);
  };
  for (const event of events) {
    if (event.kind === 39001) addHead(event);
    const embedded = records.get(event.id)?.approval;
    if (embedded) addHead(embedded);
    if (![9000, 9001].includes(event.kind)) continue;
    let verified: RelayEvent;
    try {
      verified = eventDto(event);
    } catch {
      continue;
    }
    if (exactTag(verified, "h") !== source.channelId) continue;
    const sharedRole = exactTag(verified, "role");
    for (const entry of verified.tags.filter(([name]) => name === "p")) {
      const [, target, targetRole] = entry;
      if (
        (entry.length !== 2 && entry.length !== 3) ||
        !target ||
        !HEX.test(target)
      )
        continue;
      const role = targetRole || sharedRole;
      roleChanges.set(`${verified.id}:${target}`, {
        event: verified,
        target,
        ...(role ? { role } : {}),
      });
    }
  }
  return {
    heads: [...heads.values()],
    roleChanges: [...roleChanges.values()],
  };
}

function managementApproval(
  approval: RelayEvent | undefined,
  actor: string,
  source: ThreadGovernanceSource,
  relayAuthor?: string,
  action?: EventData,
  authority?: ManagementAuthority,
) {
  const approved = administratorHead(approval, source, relayAuthor);
  if (!approved?.roles.has(actor)) return false;
  if (!action || !authority) return true;
  const actionAt = eventMs(action);
  if (eventMs(approved.event) > actionAt) return false;
  const effective = authority.heads
    .filter(({ event }) => eventMs(event) <= actionAt)
    .reduce<AdministratorHead | undefined>((current, candidate) => {
      if (!current) return candidate;
      return newer(current.event, candidate.event) === candidate.event
        ? candidate
        : current;
    }, undefined);
  if (effective?.event.id !== approved.event.id) return false;
  // NIP-29 moderation events are immutable relay-accepted authority changes.
  // Any later command that changes this actor's elevated role retires the
  // embedded roster head, even if a still-later command promotes them again.
  // Role-preserving additions do not manufacture a change. The next action
  // after a real change must bind the fresh relay-authored 39001 head.
  return !authority.roleChanges.some(
    ({ event, target, role }) =>
      target === actor &&
      (event.kind === 9001 ||
        (role !== undefined && role !== approved.roles.get(actor))) &&
      order(approved.event, event) < 0 &&
      order(event, action) <= 0,
  );
}

/** Pure authority fold. Owner-attested profiles, never `is_agent`, classify turns. */
export function foldThreadGovernance(
  source: ThreadGovernanceSource,
  events: readonly EventData[],
  ownerOf: (pubkey: string) => string | undefined,
  relayAuthor?: string,
): ThreadGovernanceState {
  let count = 0;
  let threshold = THREAD_TURN_THRESHOLD;
  let closed = false;
  let deferred = false;
  let goal: string | undefined;
  const resets: ThreadGovernanceState["resets"][number][] = [];
  const extensions: ThreadGovernanceState["extensions"][number][] = [];
  const eventsByTime = [
    ...new Map(events.map((event) => [event.id, event])).values(),
  ].sort(order);
  const records = new Map<string, GovernanceRecord>();
  for (const event of eventsByTime) {
    const governance = record(event, source);
    if (governance) records.set(event.id, governance);
  }
  const authority = managementAuthority(
    source,
    eventsByTime,
    records,
    relayAuthor,
  );
  for (const event of eventsByTime) {
    const governance = records.get(event.id);
    if (governance) {
      const actor = messageAuthor(event, relayAuthor);
      if (governance.action === "completed") {
        if (governance.agent && ownerOf(governance.agent) === actor) count++;
        continue;
      }
      if (
        !managementApproval(
          governance.approval,
          actor,
          source,
          relayAuthor,
          event,
          authority,
        )
      )
        continue;
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
    approval?: RelayEvent;
  }> = {},
) {
  lifecycleChannelId(source.channelId);
  if (!HEX.test(source.root)) throw new Error("Invalid thread source");
  if (action === "completed" && (!input.agent || !HEX.test(input.agent)))
    throw new Error("Invalid agent identity");
  if (action !== "completed" && !input.approval)
    throw new Error("Current owner or lead approval is required");
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
      owners: Map<string, OwnerHead>;
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
      .filter(
        (item) =>
          item.delivery !== "failed" &&
          item.event.kind === THREAD_GOVERNANCE_KIND,
      )
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
    const owner = (pubkey: string) => {
      const current = profiles.event?.(pubkey);
      const cached = view.owners.get(pubkey);
      return (
        profiles.owner?.(pubkey) ??
        (current && cached?.profile.id === current.id
          ? cached.owner
          : undefined)
      );
    };
    const state = foldThreadGovernance(
      view.source,
      [...view.events, ...local()],
      owner,
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
        const profile = profiles.event?.(author);
        if (!profile) return;
        const owner = await attestedOwner(profile);
        return [author, { profile, ...(owner ? { owner } : {}) }] as const;
      }),
    );
    return new Map(
      owners.filter(
        (item): item is readonly [string, OwnerHead] => item !== undefined,
      ),
    );
  }
  function installOwners(
    view: NonNullable<ReturnType<typeof make>>,
    incoming: ReadonlyMap<string, OwnerHead>,
    replace = false,
  ) {
    const next = replace ? new Map<string, OwnerHead>() : new Map(view.owners);
    for (const [author, head] of incoming)
      if (profiles.event?.(author)?.id === head.profile.id)
        next.set(author, head);
    view.owners = next;
  }
  const accept = (incoming: readonly EventData[]) => {
    for (const group of views.values())
      for (const view of group) {
        const matched = incoming.filter(
          (event) =>
            event.tags.some(
              ([name, value]) =>
                name === "h" && value === view.source.channelId,
            ) ||
            (event.kind === 39001 &&
              exactTag(event, "d") === view.source.channelId),
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
            installOwners(view, owners);
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
      owners: new Map<string, OwnerHead>(),
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
    const readAll = async (filter: {
      kinds: readonly number[];
      "#h": readonly string[];
      "#e"?: readonly string[];
    }) => {
      const found: RelayEvent[] = [];
      let cursor: { until: number; before_id: string } | undefined;
      for (;;) {
        const page = [
          ...(await reader.read(
            [{ ...filter, ...cursor, limit: PAGE, consistency: "strong" }],
            {
              ...(signal ? { signal } : {}),
              fresh: true,
              priority: "foreground",
            },
          )),
        ].sort(
          (a, b) =>
            b.created_at - a.created_at ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
        signal?.throwIfAborted();
        const previous = cursor;
        if (
          previous &&
          page.some(
            (event) =>
              event.created_at > previous.until ||
              (event.created_at === previous.until &&
                event.id <= previous.before_id),
          )
        )
          throw new Error("Thread governance history did not advance");
        found.push(...page);
        if (page.length < PAGE) return found;
        const last = page.at(-1);
        if (!last) return found;
        cursor = { until: last.created_at, before_id: last.id };
      }
    };
    const readAdministrators = () =>
      relayAuthor
        ? reader.read(
            [
              {
                kinds: [39001],
                authors: [relayAuthor],
                "#d": [view.source.channelId],
                limit: 1,
                consistency: "strong",
              },
            ],
            {
              ...(signal ? { signal } : {}),
              fresh: true,
              priority: "foreground",
            },
          )
        : Promise.resolve<readonly RelayEvent[]>([]);
    const [governance, messages, roleChanges, administrators, root] =
      await Promise.all([
        readAll({
          kinds: [THREAD_GOVERNANCE_KIND],
          "#h": [view.source.channelId],
          "#e": [view.source.root],
        }),
        readAll({
          kinds: [9, 40002],
          "#h": [view.source.channelId],
          "#e": [view.source.root],
        }),
        readAll({
          kinds: [9000, 9001],
          "#h": [view.source.channelId],
        }),
        readAdministrators(),
        reader.read(
          [
            {
              kinds: [9, 40002],
              "#h": [view.source.channelId],
              ids: [view.source.root],
              limit: 1,
              consistency: "strong",
            },
          ],
          {
            ...(signal ? { signal } : {}),
            fresh: true,
            priority: "foreground",
          },
        ),
      ]);
    const events = [
      ...governance,
      ...messages,
      ...roleChanges,
      ...administrators,
      ...root,
    ];
    const owners = await verifiedOwners(view.source, events);
    signal?.throwIfAborted();
    if (view.disposed) return;
    view.events = [
      ...new Map(events.map((event) => [event.id, event])).values(),
    ];
    installOwners(view, owners, true);
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
      approval?: RelayEvent;
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
    async act(
      source: ThreadGovernanceSource,
      action: Exclude<ThreadGovernanceAction, "completed">,
      input?: Readonly<{ reason?: string; threshold?: number; goal?: string }>,
    ) {
      if (!canManage(viewer, source.channelId))
        throw new Error(
          "Only a channel owner or lead can change the thread budget",
        );
      if (!reader || !relayAuthor)
        throw new Error("Thread controls are unavailable on this connection");
      const approvals = await reader.read(
        [
          {
            kinds: [39001],
            authors: [relayAuthor],
            "#d": [source.channelId],
            limit: 1,
            consistency: "strong",
          },
        ],
        { fresh: true, priority: "foreground" },
      );
      const [approval] = approvals;
      if (
        approvals.length !== 1 ||
        !approval ||
        !managementApproval(approval, viewer, source, relayAuthor)
      )
        throw new Error(
          "Current owner or lead approval could not be verified. Refresh membership and try again.",
        );
      send(source, action, { ...input, approval });
    },
  });
  return capability;
}
