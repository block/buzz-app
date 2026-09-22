// Synthetic signed events and isolated RAM transport only. No broker or disk.
import { matchesEvent } from "../../src/features/relay/projection";
import type { ThreadView } from "../../src/features/relay/threads";
import { createRelaySession } from "../../src/features/relay/session";
import {
  keypair,
  message,
  roster,
  bounds,
  summary,
  profile,
  signed,
  type Key,
} from "../../src/features/relay/testing";
import type { OutboxStorage } from "../../src/features/relay/outbox";
import type { ReadFilter, RelayEvent } from "../../src/features/relay/events";
import type {
  RelayData,
  RelaySnapshot,
} from "../../src/features/relay/service";

export function sessionsData({
  channelType = "stream",
  canonicalScope = false,
  rowCount = 2,
  identities,
  outboxStorage = { load: () => [], save() {} },
}: {
  channelType?: "stream" | "forum" | "dm" | "session";
  canonicalScope?: boolean;
  rowCount?: number;
  identities?: readonly [Key, Key, Key, Key];
  outboxStorage?: OutboxStorage;
} = {}) {
  const [viewer, authority, member, human] = identities ?? [
    keypair(),
    keypair(),
    keypair(),
    keypair(),
  ];
  const scope = canonicalScope
    ? `https://sessions.example:${viewer.pubkey}`
    : "sessions-fixture";
  const now = Date.UTC(2026, 8, 21, 14) / 1000;
  const report = {
    queries: [] as (readonly ReadFilter[])[],
    published: [] as RelayEvent[],
    readers: 0,
    activeReaders: 0,
    readingLeases: 0,
  };
  const rows: { rootId: string }[] = [];
  const summaries: RelayEvent[] = [];
  const events: RelayEvent[] = [];
  for (let i = 0; i < rowCount; i++) {
    const at = now - (i < 3 ? 0 : i < 7 ? 86400 : 86400 * (i - 5));
    const title =
      i === 0
        ? "Review the release checklist"
        : i === 1
          ? "Explore the onboarding flow"
          : `Investigate task ${i + 1}`;
    const root = message(
      viewer,
      "general",
      title,
      at - 120,
      i === 1 ? [] : [["p", member.pubkey]],
    );
    const reply = message(
      human,
      "general",
      `Fixture reply for task ${i + 1}. The conversation stays in its original thread.`,
      at,
      [["e", root.id, "", "reply"], ...(i === 1 ? [["p", member.pubkey]] : [])],
    );
    events.push(root, reply);
    rows.push({ rootId: root.id });
    summaries.push(
      summary(authority, "general", root.id, {
        reply_count: 1,
        participants: [human.pubkey],
      }),
    );
  }
  const humanRoot = message(
    viewer,
    "general",
    "Human-only planning thread",
    now - 130,
  );
  events.push(
    humanRoot,
    message(human, "general", "No agent involved", now, [
      ["e", humanRoot.id, "", "reply"],
    ]),
  );
  summaries.push(
    summary(authority, "general", humanRoot.id, {
      reply_count: 1,
      participants: [human.pubkey],
    }),
  );
  const unanswered = message(
    viewer,
    "general",
    "Unanswered agent request",
    now - 140,
    [["p", member.pubkey]],
  );
  events.push(unanswered);
  let receive = (_events: readonly RelayEvent[]) => {};
  let failThread = false;
  let threadGate: ReturnType<typeof deferred> | undefined;
  let threadStarted: ReturnType<typeof deferred> | undefined;
  let denied = false;
  let publicationGate: ReturnType<typeof deferred> | undefined;
  let publicationStarted: ReturnType<typeof deferred> | undefined;
  let failPublication = false;
  let evidenceGate: ReturnType<typeof deferred> | undefined;
  let evidenceStarted: ReturnType<typeof deferred> | undefined;
  let profilesMissing = false;
  let profilesGate: ReturnType<typeof deferred> | undefined;
  let profilesStarted: ReturnType<typeof deferred> | undefined;
  let isAgent = true;
  let revision = now;
  let channelName = "General";
  let memberName = "Fixture member";
  const channelMetadata = (id: string) => {
    const type =
      id === "general"
        ? channelType
        : id === "private-work"
          ? "session"
          : "stream";
    return signed(authority, {
      kind: 39000,
      created_at: revision,
      content: "",
      tags: [
        ["d", id],
        [
          "name",
          id === "general"
            ? channelName
            : id === "private-work"
              ? "Private work"
              : "Other",
        ],
        ["t", type === "session" ? "stream" : type],
        ...(type === "dm" ? [["hidden"]] : []),
        ...(type === "session"
          ? [["private"], ["about", "Buzz session (buzz.sessions/v1)"]]
          : []),
      ],
    });
  };
  const channels = () =>
    ["general", "other", "private-work"].flatMap((id) => [
      roster(
        authority,
        id,
        denied && id === "general" ? [] : [viewer.pubkey, member.pubkey],
        revision,
      ),
      channelMetadata(id),
    ]);
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: authority.pubkey,
      scope,
      media: () => undefined,
      subscribe(callbacks) {
        receive = callbacks.receive;
        callbacks.state({ status: "connected", routes: [] });
        return { update() {}, retry() {}, dispose() {} };
      },
      async query(filters) {
        report.queries = [...report.queries, filters];
        if (
          threadGate &&
          filters.some((filter) => filter.ids || filter.depth_limit)
        ) {
          threadStarted?.resolve();
          await threadGate.promise;
        }
        if (
          profilesGate &&
          filters.some((filter) => filter.kinds?.includes(0))
        ) {
          profilesStarted?.resolve();
          await profilesGate.promise;
        }
        if (
          evidenceGate &&
          filters.some((filter) => filter["#e"] && !filter.depth_limit)
        ) {
          evidenceStarted?.resolve();
          await evidenceGate.promise;
        }
        return filters.flatMap((filter) => {
          if (filter.kinds?.includes(39002) || filter.kinds?.includes(39000))
            return channels().filter((event) => matchesEvent(event, filter));
          if (filter.kinds?.includes(0))
            return [
              profile(viewer, { name: "Fixture reader" }),
              ...(!profilesMissing
                ? [
                    profile(
                      member,
                      { name: memberName, is_agent: isAgent },
                      revision,
                    ),
                  ]
                : []),
              profile(human, { name: memberName }),
            ].filter((event) => matchesEvent(event, filter));
          if (filter["#e"] && !filter.depth_limit)
            return events
              .filter((event) => matchesEvent(event, filter))
              .slice(0, filter.limit);
          if (filter.ids || filter.depth_limit) {
            if (failThread) throw new Error("Fixture thread read failed");
            // Same forward order as threads.ts: timestamp, then ID ascending.
            // Short pages still need an empty cursor page to finish traversal.
            return events
              .filter(
                (event) =>
                  (!filter.ids || filter.ids.includes(event.id)) &&
                  (!filter.kinds || filter.kinds.includes(event.kind)) &&
                  (!filter["#h"] ||
                    event.tags.some(
                      ([name, id]) =>
                        name === "h" && filter["#h"]?.includes(id ?? ""),
                    )) &&
                  (!filter["#e"] ||
                    event.tags.some(
                      ([name, id]) =>
                        name === "e" && filter["#e"]?.includes(id ?? ""),
                    )) &&
                  (filter.thread_cursor === undefined ||
                    event.created_at > filter.thread_cursor ||
                    (event.created_at === filter.thread_cursor &&
                      event.id.localeCompare(filter.thread_cursor_id ?? "") >
                        0)),
              )
              .sort(
                (a, b) =>
                  a.created_at - b.created_at || a.id.localeCompare(b.id),
              )
              .slice(0, filter.limit);
          }
          if (filter["#h"])
            return [
              ...events.filter(
                (event) =>
                  !event.tags.some(([name]) => name === "e") &&
                  event.tags.some(
                    ([name, id]) =>
                      name === "h" && filter["#h"]?.includes(id ?? ""),
                  ),
              ),
              ...summaries.filter((event) =>
                event.tags.some(
                  ([key, id]) =>
                    key === "h" && filter["#h"]?.includes(id ?? ""),
                ),
              ),
              ...filter["#h"].map((id) =>
                bounds(authority, id, "head", {
                  has_more: false,
                  next_cursor: null,
                }),
              ),
            ];
          return [];
        });
      },
      writer: {
        kinds: [9, 40003],
        async sign(template) {
          return signed(viewer, template);
        },
        async publish(event) {
          publicationStarted?.resolve();
          if (publicationGate) await publicationGate.promise;
          if (failPublication) throw new Error("Fixture publication unknown");
          report.published.push(event);
          events.push(event);
          receive([event]);
        },
      },
    },
    { warm: false, outboxStorage },
  );
  let activeThread: ThreadView | undefined;
  // Wrap only allocation to measure the real reader lifetime, not substitute it.
  const session = {
    ...owner.session,
    unread: {
      ...owner.session.unread,
      reading(...args: Parameters<typeof owner.session.unread.reading>) {
        report.readingLeases++;
        return owner.session.unread.reading(...args);
      },
    },
    thread(...args: Parameters<typeof owner.session.thread>) {
      report.readers++;
      report.activeReaders++;
      const view = owner.session.thread(...args);
      activeThread = view;
      let closed = false;
      return {
        ...view,
        dispose() {
          if (!closed) {
            closed = true;
            report.activeReaders--;
            if (activeThread === view) activeThread = undefined;
          }
          view.dispose();
        },
      };
    },
  };
  let connection: RelaySnapshot = {
    status: "ready",
    scope,
    generation: 1,
    viewer: viewer.pubkey,
    session,
  };
  const listeners = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => connection,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry() {},
    disconnect() {},
    clearCache: owner.clearCache,
  };
  return {
    owner,
    viewer: viewer.pubkey,
    ingest(incoming: readonly RelayEvent[]) {
      events.push(...incoming);
      receive(incoming);
    },
    replyTo(rootId: string, createdAt = now + 60) {
      const reply = message(
        human,
        "general",
        "A later human follow-up",
        createdAt,
        [["e", rootId, "", "reply"]],
      );
      events.push(reply);
      receive([reply]);
    },
    member: member.pubkey,
    human: human.pubkey,
    humanRoot: humanRoot.id,
    relay,
    rows,
    now,
    report,
    scope,
    session,
    threadSnapshot: () => activeThread?.snapshot(),
    refreshThread() {
      if (!activeThread) throw new Error("No active fixture thread");
      return activeThread.refresh();
    },
    failPublication(value: boolean) {
      failPublication = value;
    },
    holdPublication() {
      publicationGate = deferred();
      publicationStarted = deferred();
      return {
        started: publicationStarted.promise,
        release() {
          publicationGate?.resolve();
          publicationGate = undefined;
        },
      };
    },
    holdProfiles() {
      profilesGate = deferred();
      profilesStarted = deferred();
      return {
        started: profilesStarted.promise,
        release() {
          profilesGate?.resolve();
          profilesGate = undefined;
        },
      };
    },
    holdEvidence() {
      evidenceGate = deferred();
      evidenceStarted = deferred();
      return {
        started: evidenceStarted.promise,
        release() {
          evidenceGate?.resolve();
          evidenceGate = undefined;
        },
      };
    },
    missingAgentProfile(value: boolean) {
      profilesMissing = value;
    },
    agentHint(value: boolean) {
      isAgent = value;
      receive([
        profile(member, { name: memberName, is_agent: isAgent }, ++revision),
      ]);
    },
    holdThread() {
      threadGate = deferred();
      threadStarted = deferred();
      return {
        started: threadStarted.promise,
        release() {
          threadGate?.resolve();
          threadGate = undefined;
        },
      };
    },
    failThread(value: boolean) {
      failThread = value;
    },
    revoke() {
      denied = true;
      receive([roster(authority, "general", [], ++revision)]);
    },
    regrant() {
      denied = false;
      receive([
        roster(
          authority,
          "general",
          [viewer.pubkey, member.pubkey],
          ++revision,
        ),
      ]);
    },
    renameChannel(name: string) {
      channelName = name;
      revision++;
      receive([channelMetadata("general")]);
    },
    renameMember(name: string) {
      memberName = name;
      receive([profile(member, { name, is_agent: isAgent }, ++revision)]);
    },
    replace() {
      connection = { ...connection, generation: connection.generation + 1 };
      for (const listener of listeners) listener();
    },
    dispose: owner.dispose,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
