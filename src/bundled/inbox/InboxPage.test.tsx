// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { InboxPage } from "./InboxPage";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { createRelaySession } from "../../features/relay/session";
import type { RelaySnapshot, RelayData } from "../../features/relay/service";
import type { Navigation } from "../../features/navigation/controller";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import { matchesEvent } from "../../features/relay/projection";
import {
  deferredSidebar,
  sidebarAccount,
  sidebarFixture,
  sidebarRow,
} from "../../features/relay/sidebar-testing";
import type { MessageReadState } from "../../features/relay/sidebar-api";
import {
  bounds,
  keypair,
  message,
  metadata,
  profile,
  roster,
  signed,
} from "../../features/relay/testing";

// The sidebar API validates channel ids as UUIDs before any write.
const ROOM = "00000000-0000-4000-8000-000000000001";
const DM_ROOM = "00000000-0000-4000-8000-000000000002";
const AGENT_DM = "00000000-0000-4000-8000-000000000003";
const owners: ReturnType<typeof createRelaySession>[] = [];
composerDOMFixture();
beforeEach(() => localStorage.clear());
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
HTMLElement.prototype.scrollIntoView = vi.fn();
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});
function fixture(
  options: {
    failRoster?: boolean;
    withDm?: boolean;
    withSenders?: boolean;
    holdProfiles?: boolean;
    withWriter?: boolean;
    sessionChannel?: boolean;
    memberAgents?: 1 | 2;
    readCapability?: "unsupported";
  } = {},
) {
  const viewer = keypair(),
    alice = keypair(),
    agent = keypair(),
    profileAgent = keypair(),
    late = keypair(),
    unknown = keypair(),
    relayKey = keypair();
  let releaseProfiles = () => {};
  const profilesGate = options.holdProfiles
    ? new Promise<void>((resolve) => {
        releaseProfiles = resolve;
      })
    : undefined;
  let rosterFailure = options.failRoster ?? false;
  let rosterGate: Promise<void> | undefined;
  let rosterStarted = false;
  let evidenceReads = 0;
  const historyRequests: string[] = [];
  const threadRequests: string[] = [];
  const exactRequests: string[] = [];
  const published: RelayEvent[] = [];
  const historyGates = new Map<string, Promise<void>>();
  let addressedGate: Promise<void> | undefined;
  let releaseAddressed = () => {};
  let failAux = false;
  let auxGate: Promise<void> | undefined;
  let releaseAux = () => {};
  const historyFailures = new Set<string>();
  const answer = (filter: ReadFilter): RelayEvent[] => {
    const result = events.filter((event) => matchesEvent(event, filter));
    if (filter.depth_limit) {
      return result
        .filter(
          (event) =>
            filter.thread_cursor === undefined ||
            event.created_at > filter.thread_cursor ||
            (event.created_at === filter.thread_cursor &&
              event.id > (filter.thread_cursor_id ?? "")),
        )
        .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
        .slice(0, filter.limit);
    }
    if (filter.top_level && filter["#h"]?.[0]) {
      return [
        ...result,
        ...events.filter(
          (event) =>
            event.kind === 5 &&
            event.tags.some(
              ([key, value]) => key === "h" && value === filter["#h"]?.[0],
            ),
        ),
        bounds(
          relayKey,
          filter["#h"][0],
          filter.until === undefined
            ? "head"
            : `${filter.until}:${filter.before_id}`,
          { has_more: false, next_cursor: null },
        ),
      ];
    }
    // The ordinary #p feed has no implicit include_aux. Exact #e pages
    // terminate only on empty even if visibility shortened an earlier page.
    if (filter["#e"])
      return result
        .filter(
          (event) =>
            filter.until === undefined ||
            event.created_at < filter.until ||
            (event.created_at === filter.until &&
              event.id > (filter.before_id ?? "")),
        )
        .slice(0, filter.limit);
    return result.slice(0, filter.limit);
  };
  // Thread readers cannot load their window in this fixture: UUID channel ids
  // take the strict thread-window probe, and there is no 39007 fake. No page
  // case may assert thread content; the browser lane owns that.
  const bff = sidebarFixture();
  let saveFailure = false;
  let failThreadSave = false;
  let hold: Promise<void> | undefined;
  let saveStarted = false;
  let emit: (events: readonly RelayEvent[]) => void = () => {};
  const roots = [message(viewer, ROOM, "Our discussion", 20)];
  const mention = message(alice, ROOM, "Please review **this**", 21, [
    ["p", viewer.pubkey],
  ]);
  const reply = message(alice, ROOM, "A thread update", 22, [
    ["e", roots[0]?.id ?? "", "", "reply"],
  ]);
  const events = [
    roster(
      relayKey,
      ROOM,
      [
        viewer.pubkey,
        alice.pubkey,
        ...(options.memberAgents ? [agent.pubkey] : []),
        ...(options.memberAgents === 2 ? [profileAgent.pubkey] : []),
      ],
      10,
    ),
    metadata(
      relayKey,
      ROOM,
      "Design",
      10,
      options.sessionChannel
        ? [
            ["t", "stream"],
            ["private"],
            ["about", "Buzz session (buzz.sessions/v1)"],
          ]
        : [["t", "stream"]],
    ),
    profile(alice, { name: "Alice" }),
    ...roots,
    mention,
    reply,
    ...(options.withDm
      ? [
          roster(relayKey, DM_ROOM, [viewer.pubkey, alice.pubkey], 10),
          metadata(relayKey, DM_ROOM, "Direct message", 10, [
            ["t", "dm"],
            ["hidden"],
          ]),
          message(alice, DM_ROOM, "A direct reply", 23),
        ]
      : []),
    ...(options.withSenders
      ? [
          roster(relayKey, AGENT_DM, [viewer.pubkey, agent.pubkey], 10),
          metadata(relayKey, AGENT_DM, "Agent direct", 10, [
            ["t", "dm"],
            ["hidden"],
          ]),
          message(agent, AGENT_DM, "Agent direct reply", 24),
          message(agent, ROOM, "Agent mention", 25, [["p", viewer.pubkey]]),
          message(unknown, ROOM, "Unprofiled mention", 26, [
            ["p", viewer.pubkey],
          ]),
          profile(profileAgent, { name: "Public agent", is_agent: true }),
          message(profileAgent, ROOM, "Public agent mention", 27, [
            ["p", viewer.pubkey],
          ]),
          message(late, ROOM, "Late profile mention", 28, [
            ["p", viewer.pubkey],
          ]),
        ]
      : []),
  ];
  // Relay verdict oracle: admission and reads are the relay's answer, not a
  // client fold. Explicit `bff.messages` entries override it per message.
  const attention = { status: "exact", value: 1 } as const;
  const read = new Set<string>();
  const channelOf = (event: RelayEvent) =>
    event.tags.find(([key]) => key === "h")?.[1] ?? "";
  const rootOf = (event: RelayEvent) =>
    event.tags.find(
      ([key, , , marker]) => key === "e" && marker === "root",
    )?.[1] ??
    event.tags.find(
      ([key, , , marker]) => key === "e" && marker === "reply",
    )?.[1];
  const isDm = (channel: string) =>
    events.some(
      (event) =>
        event.kind === 39000 &&
        event.tags.some(([key, value]) => key === "d" && value === channel) &&
        event.tags.some(([key, value]) => key === "t" && value === "dm"),
    );
  const verdict = (id: string): MessageReadState => {
    const explicit = bff.messages.get(id);
    if (explicit) return explicit;
    const event = events.find((candidate) => candidate.id === id);
    if (!event) return { message_id: id, status: "unknown" };
    if (read.has(id)) return { message_id: id, status: "read" };
    if (event.pubkey === viewer.pubkey)
      return { message_id: id, status: "not_counted" };
    const root = rootOf(event);
    const reason = isDm(channelOf(event))
      ? "direct"
      : event.tags.some(
            ([key, value]) => key === "p" && value === viewer.pubkey,
          )
        ? "mention"
        : root &&
            events.some(
              (candidate) =>
                candidate.id === root && candidate.pubkey === viewer.pubkey,
            )
          ? "conversation"
          : null;
    return reason
      ? { message_id: id, status: "unread", reason }
      : { message_id: id, status: "not_counted" };
  };
  const latest = (channel: string) => {
    const newest = events
      .filter(
        (event) =>
          bff.api.eligibleKinds.includes(event.kind) &&
          channelOf(event) === channel,
      )
      .sort((a, b) => b.created_at - a.created_at || (b.id < a.id ? -1 : 1))[0];
    return newest
      ? { latest_message_id: newest.id, latest_message_at: newest.created_at }
      : {};
  };
  bff.api.contexts.mockImplementation(async (queries) => ({
    account: sidebarAccount,
    contexts: queries.map((query) => ({
      status: "available" as const,
      through_timestamp: null,
      messages: query.message_ids.map(verdict),
    })),
  }));
  bff.api.sidebar.mockImplementation(async (query) => ({
    account: sidebarAccount,
    channels: [
      ...new Set(
        events
          .filter((event) => event.kind === 39002)
          .flatMap((event) =>
            event.tags.filter(([key]) => key === "d").map(([, value]) => value),
          ),
      ),
    ]
      .filter(
        (id): id is string =>
          !!id && (!("channel_ids" in query) || query.channel_ids.includes(id)),
      )
      .map(
        (id) =>
          bff.rows.get(id) ??
          sidebarRow(id, {
            channel_type: isDm(id) ? "dm" : "stream",
            attention,
            ...latest(id),
          }),
      ),
    next_cursor: null,
  }));
  bff.api.write.mockImplementation(async (intents) =>
    intents.map((intent) => {
      const through = events.find((event) => event.id === intent.message_id);
      if (!through) return { status: "invalid" as const };
      const channel =
        intent.type === "mark_through"
          ? intent.target.channel_id
          : intent.channel_id;
      const root =
        intent.type === "mark_through" ? intent.target.root_id : undefined;
      for (const event of events)
        if (
          event.kind === 9 &&
          channelOf(event) === channel &&
          (intent.type === "mark_channel_read" ||
            (root ? rootOf(event) === root : !rootOf(event))) &&
          (event.created_at < through.created_at ||
            (event.created_at === through.created_at && event.id <= through.id))
        )
          read.add(event.id);
      return { status: "applied" as const };
    }),
  );
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relayKey.pubkey,
      query: async (filters) => {
        if (
          filters.some((filter) => !!filter["#p"] && filter.kinds?.includes(9))
        )
          await addressedGate;
        if (
          filters.some(
            (filter) => !!filter["#e"] && filter.kinds?.includes(40003),
          )
        ) {
          await auxGate;
          if (failAux) throw new Error("auxiliary history unavailable");
        }
        if (profilesGate && filters.some((filter) => filter.kinds?.includes(0)))
          await profilesGate;
        if (filters.some((filter) => filter.kinds?.includes(39002))) {
          rosterStarted = true;
          if (rosterGate) await rosterGate;
          if (rosterFailure) throw new Error("roster offline");
        }
        if (filters.some((filter) => filter.kinds?.includes(9)))
          evidenceReads++;
        for (const filter of filters) {
          const channelId = filter["#h"]?.[0];
          if (filter.top_level && channelId) historyRequests.push(channelId);
          if (filter.depth_limit && channelId) threadRequests.push(channelId);
          if (filter.ids && channelId) exactRequests.push(...filter.ids);
          if (
            (filter.top_level || filter.depth_limit || filter.ids) &&
            channelId
          ) {
            await historyGates.get(channelId);
            if (historyFailures.has(channelId))
              throw new Error("history offline");
          }
        }
        return filters.flatMap(answer);
      },
      media: () => undefined,
      ...(options.withWriter
        ? {
            writer: {
              kinds: [9, 9007],
              sign: async (template: import("nostr-tools").EventTemplate) =>
                signed(viewer, template),
              publish: async (event: RelayEvent) => {
                published.push(event);
              },
            },
          }
        : {}),
      ...(options.withSenders || options.memberAgents
        ? {
            readAgentLibrary: async () => ({
              definitions: [],
              identities: [
                { pubkey: agent.pubkey, name: "Scout" },
                ...(options.memberAgents === 2
                  ? [{ pubkey: profileAgent.pubkey, name: "Second agent" }]
                  : []),
              ],
            }),
          }
        : {}),
      subscribe(callbacks) {
        if (options.memberAgents)
          callbacks.state({ status: "connected", routes: [] });
        emit = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
      ...(options.readCapability === "unsupported"
        ? {}
        : { sidebarApi: bff.api }),
    },
    {
      outboxStorage: { load: () => [], save: () => {} },
      sidebarStorage: {
        async update(change) {
          if (hold) {
            saveStarted = true;
            const wait = hold;
            hold = undefined;
            await wait;
          }
          if (saveFailure) {
            saveFailure = false;
            throw new Error("disk full");
          }
          const current = bff.journal();
          const next = change(current);
          if (
            failThreadSave &&
            next.pending.some(
              ({ id, intent }) =>
                intent.type === "mark_through" &&
                intent.target.root_id &&
                !current.pending.some((p) => p.id === id),
            )
          ) {
            failThreadSave = false;
            throw new Error("thread disk full");
          }
          return bff.storage.update(() => next);
        },
        close() {},
      },
    },
  );
  owners.push(owner);
  if (!options.failRoster) emit(events);
  const scope = {
    viewer: viewer.pubkey,
    communityOrigin: "https://relay.test",
  };
  const readSteps: {
    target: Parameters<typeof owner.session.unread.markThrough>[0];
    id: string;
    work: ReturnType<typeof owner.session.unread.markThrough>;
  }[] = [];
  /** Dispatches of prepared channel reads (DM/channel rows), per attempt. */
  const channelReads: string[] = [];
  const retrySync = vi.fn(() => owner.session.unread.retrySync());
  const observedSession = {
    ...owner.session,
    unread: {
      ...owner.session.unread,
      retrySync,
      prepareChannelRead(channelId: string) {
        const read = owner.session.unread.prepareChannelRead(channelId);
        return () => {
          channelReads.push(channelId);
          return read();
        };
      },
      markThrough(
        target: Parameters<typeof owner.session.unread.markThrough>[0],
        id: string,
      ) {
        const work = owner.session.unread.markThrough(target, id);
        readSteps.push({ target, id, work });
        return work;
      },
    },
  };
  let connection: RelaySnapshot = {
    status: "ready",
    generation: 1,
    scope: `${scope.communityOrigin}:${scope.viewer}`,
    viewer: scope.viewer,
    session: observedSession,
  };
  const subscribers = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => connection,
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    retry() {},
    disconnect() {},
    clearCache: owner.clearCache,
  };
  const open = vi.fn<Navigation["open"]>(async () => ({ status: "opened" }));
  return {
    owner,
    relay,
    retrySync,
    readSteps,
    channelReads,
    evidenceReads: () => evidenceReads,
    historyRequests,
    holdAddressed() {
      addressedGate = new Promise<void>((resolve) => {
        releaseAddressed = resolve;
      });
      return () => {
        addressedGate = undefined;
        releaseAddressed();
      };
    },
    holdAux() {
      auxGate = new Promise<void>((resolve) => {
        releaseAux = resolve;
      });
      return () => {
        auxGate = undefined;
        releaseAux();
      };
    },
    failAux(value = true) {
      failAux = value;
    },
    threadRequests,
    exactRequests,
    published,
    addEvent(event: RelayEvent) {
      events.push(event);
    },
    deleteHistory(channelId: string) {
      const deletions = events
        .filter(
          (e) =>
            e.kind === 9 &&
            e.tags.some(([k, v]) => k === "h" && v === channelId),
        )
        .map((event) =>
          signed(event.pubkey === viewer.pubkey ? viewer : alice, {
            kind: 5,
            tags: [
              ["h", channelId],
              ["e", event.id],
            ],
            content: "",
            created_at: 200,
          }),
        );
      events.push(...deletions);
      emit(deletions);
    },
    retireThreadRoot() {
      const root = roots[0];
      if (!root) throw new Error("Missing fixture root");
      const deletion = signed(viewer, {
        kind: 5,
        tags: [
          ["h", ROOM],
          ["e", root.id],
        ],
        content: "",
        created_at: 200,
      });
      events.push(deletion);
      emit([deletion]);
    },
    root: roots[0],
    failHistory(channelId: string) {
      historyFailures.add(channelId);
    },
    recoverHistory(channelId: string) {
      historyFailures.delete(channelId);
    },
    emptyHistory(channelId: string) {
      for (let i = events.length - 1; i >= 0; i--)
        if (
          events[i]?.kind === 9 &&
          events[i]?.tags.some(([k, v]) => k === "h" && v === channelId)
        )
          events.splice(i, 1);
    },
    holdHistory(channelId: string) {
      let release = () => {};
      historyGates.set(
        channelId,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return () => {
        historyGates.delete(channelId);
        release();
      };
    },
    rosterStarted: () => rosterStarted,
    releaseProfiles,
    agent,
    unknown,
    late,
    alice,
    viewer,
    profileAgent,
    emit,
    events,
    publishLateProfile() {
      act(() => emit([profile(late, { name: "Late person" }, 30)]));
    },
    publishAgentProfile() {
      act(() => emit([profile(agent, { name: "Scout", is_agent: true }, 27)]));
    },
    publishMalformedProfile() {
      act(() =>
        emit([
          signed(unknown, {
            kind: 0,
            tags: [],
            content: "broken",
            created_at: 27,
          }),
        ]),
      );
    },
    recoverRoster() {
      rosterFailure = false;
      rosterStarted = false;
      let release = () => {};
      rosterGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    scope,
    mention,
    /** The viewer-authored root `reply` answers. */
    threadRoot: roots[0] as RelayEvent,
    reply,
    open,
    bff,
    journal: () => bff.journal(),
    /** Read intents the relay received, in order. */
    writes: () => bff.api.write.mock.calls.flatMap(([intents]) => intents),
    /**
     * Created-at of the newest committed read (pending or sent) for a thread
     * root, or for a channel's top-level prefix; undefined when none landed.
     */
    through(where: { root: string } | { channel: string }) {
      const intents = [
        ...bff.api.write.mock.calls.flatMap(([intents]) => intents),
        ...bff.journal().pending.map((entry) => entry.intent),
      ].filter((intent) =>
        "root" in where
          ? intent.type === "mark_through" &&
            intent.target.root_id === where.root
          : intent.type === "mark_channel_read"
            ? intent.channel_id === where.channel
            : intent.target.channel_id === where.channel &&
              !intent.target.root_id,
      );
      const times = intents.flatMap(
        (intent) =>
          events.find((event) => event.id === intent.message_id)?.created_at ??
          [],
      );
      return times.length ? Math.max(...times) : undefined;
    },
    view: (
      <StrictMode>
        <InboxPage
          relay={relay}
          navigator={{ open } as unknown as Navigation}
        />
      </StrictMode>
    ),
    revokeRoom() {
      emit([roster(relayKey, ROOM, [alice.pubkey], 100)]);
    },
    restoreRoom() {
      const restored = roster(
        relayKey,
        ROOM,
        [viewer.pubkey, alice.pubkey],
        101,
      );
      events.push(restored);
      emit([restored, mention, reply, ...roots]);
    },
    renameRoom() {
      const renamed = metadata(relayKey, ROOM, "Renamed", 99, [
        ["t", "stream"],
      ]);
      events.push(renamed);
      emit([renamed]);
    },
    failSave() {
      saveFailure = true;
    },
    failThreadSave() {
      failThreadSave = true;
    },
    saveStarted: () => saveStarted,
    holdSave() {
      saveStarted = false;
      let release = () => {};
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    disconnect() {
      connection = { ...connection, status: "disconnected", generation: 2 };
      for (const listener of subscribers) listener();
    },
  };
}
/** Storage/expiry alerts by text: the unrendered thread reader adds its own. */
const findAlert = (text: string) =>
  waitFor(() => {
    const alert = screen
      .getAllByRole("alert")
      .find((item) => item.textContent?.includes(text));
    if (!alert) throw Error(`Missing alert: ${text}`);
    return alert;
  });
/**
 * The thread row vehicle: a top-level mention click writes nothing. Storage
 * arms run just before the click so startup saves cannot consume them.
 */
async function openThreadRow(arm: () => void = () => {}) {
  await screen.findByText("A thread update");
  await chooseFilter("Threads");
  arm();
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in #Design" }),
  );
}
const rows = () =>
  within(
    screen.getByRole("list", { name: "Inbox conversations" }),
  ).queryAllByRole("listitem");
async function chooseFilter(label: string, control = "Activity type") {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: control }));
  await user.click(await screen.findByRole("option", { name: label }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: control })).toHaveTextContent(
      label,
    ),
  );
}
async function openRowMenu(
  method: "context" | "keyboard" | "contextKey" = "context",
) {
  const row = rows()[0];
  if (!row) throw new Error("Missing inbox row");
  if (method === "context")
    fireEvent.contextMenu(within(row).getByRole("button", { name: /^Open / }), {
      clientX: 20,
      clientY: 20,
    });
  else {
    const open = within(row).getByRole("button", { name: /^Open / });
    open.focus();
    fireEvent.keyDown(
      open,
      method === "keyboard"
        ? { key: "F10", shiftKey: true }
        : { key: "ContextMenu" },
    );
  }
  return screen.findByRole("menuitem", { name: "Mark unread" });
}
it("filters real session evidence and opens an exact message; only a thread row writes at click time", async () => {
  // A top-level mention has no readThrough step (unread.ts:395-404), so the
  // click writes nothing; its read comes from reader dwell (observe(),
  // unread.ts:826-854), which this error-state fixture cannot exercise. The
  // thread row in the same view is the click-time positive arm.
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  expect(rows()).toHaveLength(2);
  await chooseFilter("Mentions");
  expect(rows()).toHaveLength(1);
  fireEvent.click(
    await screen.findByRole("button", { name: "Open Alice in #Design" }),
  );
  expect(
    await screen.findByRole("region", { name: "Inbox detail" }),
  ).toBeInTheDocument();
  expect(h.open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Open in channel" }));
  await waitFor(() =>
    expect(h.open).toHaveBeenCalledWith({
      version: 1,
      kind: "conversation",
      scope: h.scope,
      channelId: ROOM,
      messageId: h.mention.id,
    }),
  );
  expect(h.readSteps).toHaveLength(0);
  expect(h.channelReads).toHaveLength(0);
  // Unread only does nothing until the relay lists read rows.
  fireEvent.click(screen.getByRole("checkbox", { name: "Unread only" }));
  expect(rows()).toHaveLength(1);
  await chooseFilter("Threads");
  expect(rows()).toHaveLength(1);
  const thread = rows()[0];
  if (!thread) throw Error("Missing thread row");
  expect(thread).toHaveTextContent("A thread update");
  fireEvent.click(within(thread).getByRole("button", { name: /^Open / }));
  await waitFor(() =>
    expect(h.through({ root: h.threadRoot.id })).toBe(h.reply.created_at),
  );
  expect(h.readSteps.map((step) => step.id)).toEqual([h.reply.id]);
});

it("puts the actual channel or DM source below the sender without category tags", async () => {
  const h = fixture({ withDm: true });
  render(h.view);
  await screen.findByText("A direct reply");
  await waitFor(() => expect(rows()).toHaveLength(3));
  const dmRow = rows().find((row) =>
    row.textContent?.includes("A direct reply"),
  );
  const mentionRow = rows().find((row) =>
    row.textContent?.includes("Please review this"),
  );
  if (!dmRow || !mentionRow) throw new Error("Expected DM and channel rows");
  const dmSource = dmRow.querySelector("[data-inbox-source]");
  const channelSource = mentionRow.querySelector("[data-inbox-source]");
  expect(dmSource).toHaveTextContent("DM · Alice");
  expect(channelSource).toHaveTextContent("#Design");
  expect(
    within(dmRow).getByText("Alice", { selector: "strong" }),
  ).toBeInTheDocument();
  expect(
    within(mentionRow).getByText("Alice", { selector: "strong" }),
  ).toBeInTheDocument();
  expect(dmSource).toHaveClass(/source/);
  expect(channelSource).toHaveClass(/source/);
  expect(
    (dmSource?.compareDocumentPosition(
      within(dmRow).getByText("A direct reply"),
    ) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    (channelSource?.compareDocumentPosition(
      within(mentionRow).getByText("Please review this"),
    ) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  for (const row of [dmRow, mentionRow]) {
    expect(row).not.toHaveTextContent(
      / · (Mention|Thread|Agent)|Needs action|Project update/,
    );
  }
  expect(
    within(dmRow).getByRole("button", { name: "Open Alice in DM · Alice" }),
  ).toBeInTheDocument();
  await chooseFilter("DMs");
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent("A direct reply");
  await chooseFilter("Mentions");
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent("Please review this");
  await chooseFilter("All activity");
  expect(rows()).toHaveLength(3);
});

it("distinguishes same-sender thread choices by their visible safe preview", async () => {
  const h = fixture();
  const root = message(h.viewer, ROOM, "Another discussion", 30);
  const reply = message(h.alice, ROOM, "A **different** thread update", 31, [
    ["e", root.id, "", "reply"],
  ]);
  h.events.push(root, reply);
  h.emit([root, reply]);
  render(h.view);
  await screen.findByText("A different thread update");
  await chooseFilter("Threads");
  expect(rows()).toHaveLength(2);
  for (const preview of ["A thread update", "A different thread update"]) {
    const choice = screen.getByRole("button", {
      name: "Open Alice in #Design",
      description: preview,
    });
    expect(choice).toContainElement(screen.getByText(preview));
  }
});

it("offers Show more only while matching unread conversations remain paginated", async () => {
  const h = fixture();
  const extra = Array.from({ length: 49 }, (_, index) =>
    message(h.alice, ROOM, `Additional mention ${index}`, 100 + index, [
      ["p", h.viewer.pubkey],
    ]),
  );
  h.events.push(...extra);
  h.emit(extra);
  render(h.view);
  await screen.findByText("Additional mention 48");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  expect(rows()).toHaveLength(50);
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  expect(rows()).toHaveLength(51);
  expect(
    screen.queryByRole("button", { name: "Show more" }),
  ).not.toBeInTheDocument();
  await act(async () => {
    await h.owner.session.unread.markChannelRead(ROOM);
  });
  // Read rows leave the relay-backed list; Unread only is inert until the
  // relay lists read rows (docs/inbox.md), so both states show none.
  await waitFor(() => expect(rows()).toHaveLength(0));
  for (let toggle = 0; toggle < 2; toggle++) {
    fireEvent.click(screen.getByRole("checkbox", { name: "Unread only" }));
    expect(rows()).toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: "Show more" }),
    ).not.toBeInTheDocument();
  }
});

it("intersects activity and representative sender evidence without inferring missing profiles", async () => {
  const h = fixture({ withDm: true, withSenders: true, holdProfiles: true });
  render(h.view);
  await screen.findByText("Agent direct reply");
  expect(
    screen.getByRole("combobox", { name: "Activity type" }),
  ).toHaveTextContent("All activity");
  expect(screen.getByRole("combobox", { name: "Sender" })).toHaveTextContent(
    "Everyone",
  );
  await chooseFilter("DMs");
  await chooseFilter("Agents", "Sender");
  // Inbox's idle-only ensure reads the shared choices; no filter-owned inventory.
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent("Agent direct reply");
  await chooseFilter("Mentions");
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent("Agent mention");
  await chooseFilter("Humans", "Sender");
  expect(rows()).toHaveLength(0);
  try {
    await act(async () => h.releaseProfiles());
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent("Please review this");
    await chooseFilter("Agents", "Sender");
    h.publishAgentProfile();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(
      rows().some((row) => row.textContent?.includes("Public agent mention")),
    ).toBe(true);
    await chooseFilter("Humans", "Sender");
    h.publishMalformedProfile();
    h.publishLateProfile();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(
      rows().some((row) => row.textContent?.includes("Late profile mention")),
    ).toBe(true);
    expect(
      rows().some((row) => row.textContent?.includes("Unprofiled mention")),
    ).toBe(false);
    await chooseFilter("Everyone", "Sender");
    await waitFor(() => expect(rows().length).toBeGreaterThan(4));
    expect(
      rows().some((row) => row.textContent?.includes("Unprofiled mention")),
    ).toBe(true);
    // Filtering never marks read; positive arm: a thread row click does.
    expect(h.through({ root: h.threadRoot.id })).toBeUndefined();
    expect(h.writes()).toEqual([]);
    await chooseFilter("Threads");
    fireEvent.click(
      screen.getByRole("button", { name: "Open Alice in #Design" }),
    );
    await waitFor(() =>
      expect(h.through({ root: h.threadRoot.id })).toBe(h.reply.created_at),
    );
  } finally {
    h.releaseProfiles();
  }
});

it("omits visible row overflow buttons and preserves disabled unread via right-click", async () => {
  // On the DM row: unlike a top-level mention, its click writes a read, so the
  // right-click "no write" below is paired with a positive arm.
  const h = fixture({ withDm: true });
  render(h.view);
  await screen.findByText("A direct reply");
  await chooseFilter("DMs");
  const row = rows()[0];
  if (!row) throw new Error("Missing inbox row");
  expect(within(row).getAllByRole("button")).toHaveLength(1);
  expect(
    within(row).queryByRole("button", { name: /^Actions for / }),
  ).not.toBeInTheDocument();
  expect(row.querySelector("[data-inbox-row-overflow]")).toBeNull();
  expect(within(row).getByRole("img", { name: "Unread" })).toBeInTheDocument();
  const action = await openRowMenu("context");
  expect(action).toHaveAttribute("aria-disabled", "true");
  expect(
    screen.queryByRole("region", { name: "Inbox detail" }),
  ).not.toBeInTheDocument();
  expect(h.through({ channel: DM_ROOM })).toBeUndefined();
  fireEvent.keyDown(action, { key: "Escape" });
  fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
  await waitFor(() => expect(h.through({ channel: DM_ROOM })).toBe(23));
});

it("opens the disabled unread action with the ContextMenu key without changing selection", async () => {
  // DM row: its click writes, so the menu's "no write" has a positive arm.
  const h = fixture({ withDm: true });
  render(h.view);
  await screen.findByText("A direct reply");
  await chooseFilter("DMs");
  const action = await openRowMenu("contextKey");
  expect(action).toHaveTextContent("Mark unread");
  expect(action).toHaveAttribute("aria-disabled", "true");
  expect(
    screen.queryByRole("region", { name: "Inbox detail" }),
  ).not.toBeInTheDocument();
  expect(h.through({ channel: DM_ROOM })).toBeUndefined();
  fireEvent.keyDown(action, { key: "Escape" });
  const row = rows()[0];
  if (!row) throw Error("Missing DM row");
  fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
  await waitFor(() => expect(h.through({ channel: DM_ROOM })).toBe(23));
});

it("holds read actions pending, surfaces storage failure, and retries without losing evidence", async () => {
  // Restated on the thread row: a top-level mention click writes nothing.
  const h = fixture();
  render(h.view);
  await screen.findByText("A thread update");
  await chooseFilter("Threads");
  const release = h.holdSave();
  h.failSave();
  try {
    fireEvent.click(
      screen.getByRole("button", { name: "Open Alice in #Design" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Inbox detail" }),
      ).toBeInTheDocument(),
    );
  } finally {
    await act(async () => release());
  }
  // The thread reader has its own alert here: this fixture serves no signed
  // thread window (no transport scope), so pick the storage alert by text.
  await waitFor(() =>
    expect(
      screen
        .getAllByRole("alert")
        .some((alert) => alert.textContent?.includes("disk full")),
    ).toBe(true),
  );
  expect(screen.getAllByText("A thread update").length).toBeGreaterThan(0);
  expect(h.through({ root: h.threadRoot.id })).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
  await waitFor(() =>
    expect(h.through({ root: h.threadRoot.id })).toBe(h.reply.created_at),
  );
});

it.each([
  ["Close", false, false],
  ["Escape", false, false],
  ["Close", true, false],
  ["Escape", true, false],
  ["access", false, true],
  ["Close", false, true],
] as const)(
  "a thread read %s during its admitted save (storage failure=%s, access loss=%s)",
  async (action, storageFailure, accessLoss) => {
    // readThrough is one thread step (unread.ts:395-404); this keeps the old
    // two-step matrix's contract: Close/Escape during an admitted held save
    // lets it settle, and a genuine rejection still surfaces.
    const h = fixture();
    const user = userEvent.setup();
    const root = message(h.alice, ROOM, "Cancelled root", 30, [
      ["p", h.viewer.pubkey],
    ]);
    const child = message(h.alice, ROOM, "Cancelled reply", 31, [
      ["p", h.viewer.pubkey],
      ["e", root.id, "", "reply"],
    ]);
    h.events.push(root, child);
    h.emit([root, child]);
    render(h.view);
    await screen.findByText("Cancelled root");
    await waitFor(() =>
      expect(h.owner.session.inboxFeed.snapshot().status).toBe("ready"),
    );
    const release = h.holdSave();
    if (storageFailure) h.failSave();
    try {
      const row = rows().find((row) =>
        row.textContent?.includes("Cancelled root"),
      );
      if (!row) throw Error("Missing thread row");
      await user.click(within(row).getByRole("button"));
      await waitFor(() => expect(h.saveStarted()).toBe(true));
      expect(h.readSteps.map((step) => step.id)).toEqual([child.id]);
      const close = screen.getByRole("button", { name: "Close thread" });
      if (action === "Close") await user.click(close);
      if (action === "Escape") {
        close.focus();
        await user.keyboard("{Escape}");
      }
      if (accessLoss) act(() => h.revokeRoom());
      const detail = screen.queryByRole("region", { name: "Inbox detail" });
      // Lost access retires the reader in place; only Close/Escape dismiss.
      if (action === "access")
        expect(detail).toHaveTextContent(
          "This conversation is unavailable. Open it in Channels to check access.",
        );
      else expect(detail).not.toBeInTheDocument();
    } finally {
      await act(async () => release());
    }
    await waitFor(() =>
      expect(
        screen.getByRole("list", {
          name: "Inbox conversations",
        }),
      ).toHaveAttribute("aria-busy", "false"),
    );
    expect(h.readSteps.map((step) => step.id)).toEqual([child.id]);
    if (storageFailure || accessLoss) {
      expect(h.through({ root: root.id })).toBeUndefined();
      expect(screen.getByRole("alert")).toHaveTextContent(
        storageFailure ? "disk full" : "Reading context changed",
      );
    } else {
      expect(h.through({ root: root.id })).toBe(31);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    }
    if (action === "access") {
      // Back still closes the unavailable detail; with no rows left, focus
      // follows the chain to the Activity type filter (InboxPage.tsx:244-256).
      const detail = screen.getByRole("region", { name: "Inbox detail" });
      await user.click(
        within(detail).getByRole("button", { name: "Close detail" }),
      );
      expect(detail).not.toBeInTheDocument();
      expect(rows()).toHaveLength(0);
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "Activity type" }),
        ).toHaveFocus(),
      );
    }
  },
);

it.each(["retry", "other", "blur"] as const)(
  "held read Retry completion preserves focus ownership (%s)",
  async (focusOwner) => {
    // Restated on the DM row: a top-level mention click writes nothing, and
    // the thread reader's own focus is not observable in this fixture.
    const h = fixture({ withDm: true });
    const user = userEvent.setup();
    render(h.view);
    await screen.findByText("A direct reply");
    const dmRow = rows().find((item) =>
      item.textContent?.includes("A direct reply"),
    );
    if (!dmRow) throw Error("Missing DM row");
    h.failSave();
    await user.click(within(dmRow).getByRole("button", { name: /^Open / }));
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    expect(h.through({ channel: DM_ROOM })).toBeUndefined();
    const detail = screen.getByRole("region", { name: "Inbox detail" });
    const retry = screen.getByRole("button", { name: "Retry inbox" });
    const other = within(detail).getByRole("button", {
      name: "Open in channel",
    });
    const release = h.holdSave();
    try {
      retry.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(h.saveStarted()).toBe(true));
      expect(retry).toBeInTheDocument();
      expect(retry).toHaveFocus();
      expect(retry).not.toBeDisabled();
      expect(retry).toHaveAttribute("aria-disabled", "true");
      await user.keyboard("{Enter}");
      // The failed click and one Retry; the held second Enter dispatches nothing.
      expect(h.channelReads).toEqual([DM_ROOM, DM_ROOM]);
      if (focusOwner === "other") other.focus();
      if (focusOwner === "blur") retry.blur();
    } finally {
      await act(async () => release());
    }
    await waitFor(() =>
      expect(screen.queryByText("disk full")).not.toBeInTheDocument(),
    );
    expect(h.through({ channel: DM_ROOM })).toBe(23);
    if (focusOwner === "retry") {
      expect(
        within(detail).getByRole("button", { name: "Close detail" }),
      ).toHaveFocus();
      await user.keyboard("{Escape}");
      expect(detail).not.toBeInTheDocument();
    } else expect(focusOwner === "other" ? other : document.body).toHaveFocus();
  },
);

it("a second rejected Retry retains its focused control until a successful recovery", async () => {
  // Restated on the DM row: the thread reader's own focus is not observable here.
  const h = fixture({ withDm: true });
  const user = userEvent.setup();
  render(h.view);
  await screen.findByText("A direct reply");
  const dmRow = rows().find((item) =>
    item.textContent?.includes("A direct reply"),
  );
  if (!dmRow) throw Error("Missing DM row");
  h.failSave();
  await user.click(within(dmRow).getByRole("button", { name: /^Open / }));
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  const detail = screen.getByRole("region", { name: "Inbox detail" });
  const retry = screen.getByRole("button", { name: "Retry inbox" });
  const release = h.holdSave();
  h.failSave();
  try {
    retry.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(h.saveStarted()).toBe(true));
    expect(retry).toHaveFocus();
  } finally {
    await act(async () => release());
  }
  await waitFor(() =>
    expect(
      screen.getByRole("list", {
        name: "Inbox conversations",
      }),
    ).toHaveAttribute("aria-busy", "false"),
  );
  expect(retry).toHaveFocus();
  expect(screen.getByRole("alert")).toHaveTextContent("disk full");
  expect(h.through({ channel: DM_ROOM })).toBeUndefined();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.queryByText("disk full")).not.toBeInTheDocument(),
  );
  expect(h.through({ channel: DM_ROOM })).toBe(23);
  expect(
    within(detail).getByRole("button", { name: "Close detail" }),
  ).toHaveFocus();
});

it.each([true, false])(
  "source Retry stays mounted through held refresh and hands off list focus only when owned (%s)",
  async (keepFocus) => {
    const h = fixture();
    const user = userEvent.setup();
    render(h.view);
    await screen.findByText("Please review this");
    await waitFor(() =>
      expect(h.owner.session.inboxFeed.snapshot().status).toBe("ready"),
    );
    h.failAux();
    await act(async () => h.owner.session.inboxFeed.refresh());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "auxiliary history unavailable",
    );
    h.failAux(false);
    const release = h.holdAux();
    const retry = screen.getByRole("button", { name: "Retry inbox" });
    const other = screen.getByRole("combobox", { name: "Sender" });
    try {
      retry.focus();
      await user.keyboard("{Enter}");
      await waitFor(() =>
        expect(h.owner.session.inboxFeed.snapshot().incomplete).toContain(
          h.mention.id,
        ),
      );
      expect(retry).toHaveFocus();
      expect(retry).toHaveAttribute("aria-disabled", "true");
      if (!keepFocus) other.focus();
    } finally {
      await act(async () => release());
    }
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(
      keepFocus
        ? screen.getByRole("combobox", { name: "Activity type" })
        : other,
    ).toHaveFocus();
  },
);

it("shows two accessible filters without removed options, bulk action or coverage boilerplate", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  expect(screen.getAllByRole("combobox")).toHaveLength(2);
  expect(
    screen.getByRole("combobox", { name: "Activity type" }),
  ).toHaveTextContent("All activity");
  expect(screen.getByRole("combobox", { name: "Sender" })).toHaveTextContent(
    "Everyone",
  );
  expect(screen.getByText("Activity type")).toHaveClass("sr-only");
  expect(screen.getByText("Sender", { selector: ".sr-only" })).toHaveClass(
    "sr-only",
  );
  expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", {
      name: /Mark shown as read|Mark as read|Mark unread/,
    }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(
      /Verified recent conversations|Results are bounded|Feed history reached its result limit|Read-state sync is unavailable on this host/,
    ),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("checkbox", { name: "Unread only" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Refresh" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("combobox", { name: "Activity type" }));
  for (const label of ["Projects", "Needs action"]) {
    expect(
      screen.queryByRole("option", { name: label }),
    ).not.toBeInTheDocument();
  }
  expect(screen.queryByText("Activity")).not.toBeInTheDocument();
  expect(
    screen.getByRole("option", { name: "All activity" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("option", { name: "Drafts" }),
  ).not.toBeInTheDocument();
});

it("waits for roster recovery before explicit evidence refresh", async () => {
  const h = fixture({ failRoster: true });
  render(h.view);
  expect(await screen.findByRole("alert")).toHaveTextContent("roster offline");
  const baseline = h.evidenceReads();
  const release = h.recoverRoster();
  try {
    fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
    await waitFor(() => expect(h.rosterStarted()).toBe(true));
    expect(h.evidenceReads()).toBe(baseline);
    expect(h.retrySync).toHaveBeenCalledOnce();
  } finally {
    await act(async () => release());
  }
  await screen.findByText("Please review this");
  expect(h.evidenceReads()).toBeGreaterThan(baseline);
});

it("cache clear shows explicit refresh instead of a spinner with no pending work", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  await act(async () => {
    await h.owner.clearCache();
  });
  expect(screen.getByText("Check recent activity.")).toBeVisible();
  expect(
    screen.queryByText("Checking recent activity…"),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Please review this");
  expect(h.retrySync).not.toHaveBeenCalled();
});

it("keeps a failed origin navigation above the retained preview instead of adding a grid column", async () => {
  const h = fixture({ withDm: true, withWriter: true });
  h.open.mockResolvedValue({ status: "failed", reason: "unavailable" });
  render(h.view);
  await screen.findByText("A direct reply");
  await chooseFilter("DMs");
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in DM · Alice" }),
  );
  const detail = screen.getByRole("region", { name: "Inbox detail" });
  const preview = within(detail).getByRole("region", {
    name: "Conversation preview",
  });
  fireEvent.click(
    within(detail).getByRole("button", { name: "Open in channel" }),
  );
  const error = await within(detail).findByRole("alert");
  expect(error).toHaveTextContent("This conversation could not be opened");
  // The retained reader has its own hidden/inert wrapper during revalidation;
  // the alert still shares its one detail-body column, above that wrapper.
  const retainedReader = preview.parentElement;
  expect(error.nextElementSibling).toBe(retainedReader);
  expect(error.parentElement).toBe(retainedReader?.parentElement);
  expect(error.parentElement?.parentElement).toBe(detail);
  expect(within(preview).getAllByRole("textbox")).toHaveLength(1);
});

it("does not accept a second row selection while its explicit read is pending", async () => {
  // The second row is the thread row: its click writes, unlike a top-level mention.
  const h = fixture({ withDm: true });
  render(h.view);
  await screen.findByText("A direct reply");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  const release = h.holdSave();
  try {
    fireEvent.click(
      screen.getByRole("button", { name: "Open Alice in DM · Alice" }),
    );
    await waitFor(() => expect(h.saveStarted()).toBe(true));
    const other = rows().find((row) =>
      row.textContent?.includes("A thread update"),
    );
    if (!other) throw Error("missing second row");
    const button = within(other).getByRole("button");
    expect(button).toBeDisabled();
    expect(
      screen.getByRole("list", { name: "Inbox conversations" }),
    ).toHaveAttribute("aria-busy", "true");
    fireEvent.click(button);
    expect(
      screen.getByRole("heading", { name: "DM with Alice" }),
    ).toBeInTheDocument();
    expect(h.through({ root: h.threadRoot.id })).toBeUndefined();
  } finally {
    await act(async () => release());
  }
  await waitFor(() =>
    expect(
      screen.getByRole("list", { name: "Inbox conversations" }),
    ).toHaveAttribute("aria-busy", "false"),
  );
  const other = rows().find((row) =>
    row.textContent?.includes("A thread update"),
  );
  if (!other) throw Error("missing second row");
  fireEvent.click(within(other).getByRole("button"));
  await waitFor(() =>
    expect(h.through({ root: h.threadRoot.id })).toBe(h.reply.created_at),
  );
});
it("a failed captured read cannot retry after access retirement", async () => {
  const h = fixture();
  render(h.view);
  await openThreadRow(() => h.failSave());
  await findAlert("disk full");
  act(() => h.revokeRoom());
  await waitFor(() => expect(rows()).toHaveLength(0));
  fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
  await findAlert("Inbox action expired");
  expect(h.through({ root: h.threadRoot.id })).toBeUndefined();
});

it("closing a pending failed action cancels its retry intent without cancelling admitted storage", async () => {
  const h = fixture();
  render(h.view);
  let release = () => {};
  try {
    await openThreadRow(() => {
      release = h.holdSave();
      h.failSave();
    });
    await waitFor(() => expect(h.saveStarted()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Close thread" }));
  } finally {
    await act(async () => release());
  }
  await findAlert("disk full");
  fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
  await waitFor(() =>
    expect(screen.queryByText("disk full")).not.toBeInTheDocument(),
  );
  expect(h.through({ root: h.threadRoot.id })).toBeUndefined();
});

it("classifies cached profile-only agents beyond the first 50 without unbounded enrichment", async () => {
  const h = fixture();
  const agent = profile(
    h.profileAgent,
    { name: "Cached outside", is_agent: true },
    100,
  );
  const first = Array.from({ length: 51 }, (_, index) =>
    message(h.unknown, ROOM, `Unknown ${index}`, 100 + index, [
      ["p", h.viewer.pubkey],
    ]),
  );
  const outside = message(h.profileAgent, ROOM, "Outside first fifty", 90, [
    ["p", h.viewer.pubkey],
  ]);
  h.events.push(agent, ...first, outside);
  h.emit([agent, ...first, outside]);
  render(h.view);
  await screen.findByText("Unknown 50");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  // Roster completion clears optional profiles; restore genuinely shared cache evidence after it.
  act(() => h.emit([agent]));
  await chooseFilter("Agents", "Sender");
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent("Outside first fifty");
  expect(
    screen.queryByRole("button", { name: "Show more" }),
  ).not.toBeInTheDocument();
  await chooseFilter("Humans", "Sender");
  expect(
    rows().some((row) => row.textContent?.includes("Outside first fifty")),
  ).toBe(false);
  act(() => h.emit([profile(h.profileAgent, { name: "Cached outside" }, 101)]));
  await waitFor(() =>
    expect(
      rows().some((row) => row.textContent?.includes("Outside first fifty")),
    ).toBe(true),
  );
});

it("feed invalidation has its own local recovery even when shared unread stays ready", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await waitFor(() =>
    expect(h.owner.session.inboxFeed.snapshot().status).toBe("ready"),
  );
  expect(h.owner.session.unread.inbox().status).toBe("ready");
  act(() => h.owner.session.inboxFeed.clear());
  expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(h.owner.session.inboxFeed.snapshot().status).toBe("ready"),
  );
  expect(
    screen.queryByRole("button", { name: "Refresh" }),
  ).not.toBeInTheDocument();
});
it("a newer manual intent invalidates retry of an earlier rejected read", async () => {
  const h = fixture();
  render(h.view);
  await openThreadRow(() => h.failSave());
  await findAlert("disk full");
  const target = {
    kind: "thread",
    channelId: ROOM,
    rootId: h.threadRoot.id,
  } as const;
  await act(async () => h.owner.session.unread.markUnreadLocal(target));
  fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
  await findAlert("Inbox action expired");
  expect(h.through({ root: h.threadRoot.id })).toBeUndefined();
  expect(h.owner.session.unread.snapshot(target).manual).toBe("local-only");
});

it("a newer read that leaves the row unchanged still supersedes a failed read Retry", async () => {
  // Restated on a failed thread read: an explicit read through the first of
  // two replies leaves the row unread and in place, yet is a newer intent.
  const h = fixture();
  const root = message(h.alice, ROOM, "Superseded root", 30, [
    ["p", h.viewer.pubkey],
  ]);
  const first = message(h.alice, ROOM, "First reply", 31, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  const second = message(h.alice, ROOM, "Second reply", 32, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  h.addEvent(root);
  h.addEvent(first);
  h.addEvent(second);
  h.emit([root, first, second]);
  render(h.view);
  await screen.findByText("Superseded root");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  const row = rows().find((item) =>
    item.textContent?.includes("Superseded root"),
  );
  if (!row) throw Error("Missing thread row");
  h.failSave();
  fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
  await findAlert("disk full");
  const threadWrites = () =>
    [...h.writes(), ...h.journal().pending.map((entry) => entry.intent)].filter(
      (intent) =>
        intent.type === "mark_through" && intent.target.root_id === root.id,
    ).length;
  await act(async () =>
    h.owner.session.unread.markThrough(
      { kind: "thread", channelId: ROOM, rootId: root.id },
      first.id,
    ),
  );
  expect(threadWrites()).toBe(1);
  expect(
    h.owner.session.unread
      .inbox()
      .items.some((item) => item.id === `${ROOM}:${root.id}`),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
  await findAlert("Inbox action expired");
  expect(threadWrites()).toBe(1);
  expect(h.through({ root: root.id })).toBe(31);
});

it("a relay acknowledgement does not advance intent revision or cancel a failed read Retry", async () => {
  // Restated from publication timers onto the current relay write ack.
  const h = fixture({ withDm: true });
  render(h.view);
  await screen.findByText("A direct reply");
  const ack = deferredSidebar<{ status: "applied" }[]>();
  h.bff.api.write.mockImplementationOnce(() => ack.promise);
  const dmRow = rows().find((item) =>
    item.textContent?.includes("A direct reply"),
  );
  if (!dmRow) throw Error("Missing DM row");
  fireEvent.click(within(dmRow).getByRole("button", { name: /^Open / }));
  await waitFor(() => expect(h.bff.api.write).toHaveBeenCalledTimes(1));
  expect(h.journal().pending).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Close detail" }));
  await openThreadRow(() => h.failSave());
  await findAlert("disk full");
  const revision = h.owner.session.unread.revision();
  await act(async () => ack.resolve([{ status: "applied" }]));
  await waitFor(() => expect(h.journal().pending).toHaveLength(0));
  expect(h.owner.session.unread.revision()).toBe(revision);
  expect(h.through({ root: h.threadRoot.id })).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
  await waitFor(() =>
    expect(h.through({ root: h.threadRoot.id })).toBe(h.reply.created_at),
  );
  expect(screen.queryByText("Inbox action expired")).not.toBeInTheDocument();
});

it.each([true, false])(
  "Inbox activity replies preserve shared recipient policy (session=%s)",
  async (sessionChannel) => {
    const h = fixture({ withWriter: true, sessionChannel, memberAgents: 1 });
    render(h.view);
    await screen.findByText("Please review this");
    await chooseFilter("Mentions");
    fireEvent.click(
      screen.getByRole("button", { name: "Open Alice in #Design" }),
    );
    const editor = await screen.findByRole("textbox", {
      name: "Reply to thread",
    });
    fireEvent.change(editor, { target: { value: "Respond to this" } });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled(),
    );
    // The thread reader's own window error is fixture baseline (see the
    // fixture comment); the send must add no alert of its own.
    const baseline = screen.queryAllByRole("alert").map((el) => el.textContent);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => {
      const alerts = screen.queryAllByRole("alert").map((el) => el.textContent);
      const failed = h.owner.session.outbox
        ?.snapshot()
        .filter((row) => row.delivery === "failed");
      expect({ alerts, failed, published: h.published.length }).toEqual({
        alerts: baseline,
        failed: [],
        published: 1,
      });
    });
    const sent = h.published[0];
    if (!sent) throw Error("Missing publication");
    expect(sent.tags).toContainEqual(["h", ROOM]);
    expect(sent.tags).toContainEqual(["e", h.mention.id, "", "reply"]);
    expect(sent.tags.filter(([name]) => name === "p")).toEqual(
      sessionChannel ? [["p", h.agent.pubkey]] : [],
    );
  },
);
it("Inbox session activity with multiple agents requires an explicit recipient", async () => {
  const h = fixture({
    withWriter: true,
    sessionChannel: true,
    memberAgents: 2,
  });
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Mentions");
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in #Design" }),
  );
  const editor = await screen.findByRole("textbox", {
    name: "Reply to thread",
  });
  fireEvent.change(editor, { target: { value: "Choose someone first" } });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(
    await screen.findByText(
      "There are multiple agents in this session. @mention who should respond.",
    ),
  ).toBeInTheDocument();
  expect(h.published).toEqual([]);
  expect(editor).toHaveValue("Choose someone first");
});

it.each(["preview", "name", "history"])(
  "failed read Retry survives harmless channel %s replacement",
  async (change) => {
    // Restated on a failed thread read: an enabled Mark unread is unreachable
    // while every listed row is unread (unread.ts:337-343).
    const h = fixture();
    render(h.view);
    await openThreadRow(() => h.failSave());
    await findAlert("disk full");
    const before = h.owner.session.channels
      .list()
      .channels.find((channel) => channel.id === ROOM);
    const revision = h.owner.session.unread.revision();
    const row = h.owner.session.unread
      .inbox()
      .items.find((row) => row.id === `${ROOM}:${h.threadRoot.id}`);
    if (!before || !row) throw Error("Missing ready evidence");
    if (change === "name") act(() => h.renameRoom());
    else if (change === "preview")
      act(() => h.emit([message(h.alice, ROOM, "Unrelated traffic", 60)]));
    else {
      h.events.push(message(h.alice, ROOM, "Historical preview", 61));
      act(() => h.owner.session.channels.ensure(ROOM));
      await waitFor(() =>
        expect(h.owner.session.channels.window(ROOM).status).toBe("ready"),
      );
    }
    await waitFor(() =>
      expect(
        h.owner.session.channels
          .list()
          .channels.find((channel) => channel.id === ROOM),
      ).not.toBe(before),
    );
    expect(h.owner.session.unread.revision()).toBe(revision);
    expect(
      h.owner.session.unread.inbox().items.find((item) => item.id === row.id),
    ).toEqual(row);
    expect(h.through({ root: h.threadRoot.id })).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
    await waitFor(() =>
      expect(h.through({ root: h.threadRoot.id })).toBe(h.reply.created_at),
    );
    expect(screen.queryByText("Inbox action expired")).not.toBeInTheDocument();
  },
);
it("revoke and regrant cannot revive a captured failed Inbox mutation", async () => {
  const h = fixture();
  render(h.view);
  await openThreadRow(() => h.failSave());
  await findAlert("disk full");
  act(() => {
    h.revokeRoom();
    h.restoreRoom();
  });
  await waitFor(() =>
    expect(
      rows().some((row) => row.textContent?.includes("A thread update")),
    ).toBe(true),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
  await findAlert("Inbox action expired. Close and reopen the conversation.");
  expect(h.through({ root: h.threadRoot.id })).toBeUndefined();
});

it("unsupported host lists no relay-verdict rows and writes nothing", async () => {
  // Rows need relay verdicts (unread.ts:337-343); without the sidebar API
  // there is nothing to open or mark. The read-only capability is gone.
  const h = fixture({ readCapability: "unsupported" });
  render(h.view);
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  expect(h.owner.session.unread.sync().capability).toBe("unsupported");
  expect(h.owner.session.unread.inbox().items).toEqual([]);
  expect(rows()).toHaveLength(0);
  await act(async () => {});
  expect(h.writes()).toEqual([]);
  expect(h.journal().pending).toEqual([]);
});

it("retiring a session removes its open disabled unread menu without another write", async () => {
  const h = fixture({ withDm: true });
  render(h.view);
  await screen.findByText("A direct reply");
  // Positive arm: this fixture lands a DM read before the menu opens.
  const writesBefore = h.writes().length;
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice in DM · Alice" }),
  );
  await waitFor(() => expect(h.through({ channel: DM_ROOM })).toBe(23));
  expect(h.writes().length).toBeGreaterThan(writesBefore);
  fireEvent.click(
    within(screen.getByRole("region", { name: "Inbox detail" })).getByRole(
      "button",
      { name: "Close detail" },
    ),
  );
  await chooseFilter("Mentions");
  const action = await openRowMenu();
  expect(action).toHaveAttribute("aria-disabled", "true");
  const before = h.journal();
  const writes = h.writes().length;
  act(() => h.disconnect());
  expect(action).not.toBeInTheDocument();
  await act(async () => {});
  expect(h.journal()).toEqual(before);
  expect(h.writes()).toHaveLength(writes);
});

it("All activity stays chat-only when addressed project and approval evidence arrives", async () => {
  const h = fixture();
  const nonchat = [1621, 46010].map((kind) =>
    signed(h.alice, {
      kind,
      content: `Not an Inbox conversation ${kind}`,
      created_at: 40,
      tags: [
        ["h", ROOM],
        ["p", h.viewer.pubkey],
        ["a", `30617:${h.alice.pubkey}:repo`],
      ],
    }),
  );
  h.events.push(...nonchat);
  render(h.view);
  await screen.findByText("Please review this");
  await waitFor(() =>
    expect(h.owner.session.inboxFeed.snapshot().status).toBe("ready"),
  );
  expect(rows()).toHaveLength(2);
  act(() => h.emit(nonchat));
  expect(rows()).toHaveLength(2);
  expect(screen.queryByText(/Not an Inbox conversation/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Open in project" })).toBeNull();
});

it("keeps the captured reply selected when its older root is verified", async () => {
  const h = fixture();
  const unknownRoot = message(h.alice, ROOM, "Late root", 39);
  const reply = message(h.alice, ROOM, "Orphan addressed reply", 42, [
    ["p", h.viewer.pubkey],
    ["e", unknownRoot.id, "", "reply"],
  ]);
  h.events.push(reply);
  h.emit([reply]);
  render(h.view);
  await screen.findByText("Orphan addressed reply");
  const row = rows().find((item) =>
    item.textContent?.includes("Orphan addressed reply"),
  );
  if (!row) throw Error("Missing orphan row");
  // A landed read removes the row; a failed one keeps it selected and listed.
  h.failSave();
  const open = within(row).getByRole("button", { name: /^Open / });
  fireEvent.click(open);
  await findAlert("disk full");
  expect(
    screen.getByRole("region", { name: "Inbox detail" }),
  ).toBeInTheDocument();
  const kept = rows().find((item) =>
    item.textContent?.includes("Orphan addressed reply"),
  );
  if (!kept) throw Error("Failed read dropped the orphan row");
  expect(within(kept).getByRole("button", { name: /^Open / })).toHaveAttribute(
    "aria-current",
    "page",
  );
  act(() => h.emit([unknownRoot]));
  expect(
    screen.getByRole("region", { name: "Inbox detail" }),
  ).toBeInTheDocument();
  const regrouped = rows().find((item) =>
    item.textContent?.includes("Orphan addressed reply"),
  );
  if (!regrouped) throw Error("Missing regrouped row");
  expect(
    within(regrouped).getByRole("button", { name: /^Open / }),
  ).toHaveAttribute("aria-current", "page");
  fireEvent.click(screen.getByRole("button", { name: "Open in channel" }));
  await waitFor(() =>
    expect(h.open).toHaveBeenCalledWith({
      version: 1,
      kind: "conversation",
      scope: h.scope,
      channelId: ROOM,
      messageId: reply.id,
      threadRootId: unknownRoot.id,
    }),
  );
});

it("shows only the exact unfinished row's placeholder through held edits and retry, never an unverified body", async () => {
  const h = fixture();
  const old = message(h.alice, ROOM, "OLD BODY", 39, [["p", h.viewer.pubkey]]);
  const edit = signed(h.alice, {
    kind: 40003,
    content: "CURRENT BODY",
    created_at: 40,
    tags: [
      ["h", ROOM],
      ["e", old.id],
    ],
  });
  h.events.push(old, edit);
  const release = h.holdAux();
  render(h.view);
  try {
    await waitFor(() =>
      expect(h.owner.session.inboxFeed.snapshot().incomplete).toContain(old.id),
    );
    const unfinished = rows().find((row) =>
      row.textContent?.includes("Preview updating…"),
    );
    if (!unfinished) throw Error("Missing pending preview row");
    expect(unfinished).not.toHaveTextContent("OLD BODY");
    expect(
      within(unfinished).getByRole("button", { name: /^Open / }),
    ).toHaveAccessibleDescription("Preview updating…");
    const unaffected = rows().find((row) =>
      row.textContent?.includes("A thread update"),
    );
    expect(unaffected).toBeDefined();
    expect(unaffected).not.toHaveTextContent("Preview updating…");
    fireEvent.click(within(unfinished).getByRole("button", { name: /^Open / }));
    expect(
      screen.getByRole("region", { name: "Inbox detail" }),
    ).toHaveTextContent("Preview updating…");
    expect(
      screen.getByRole("region", { name: "Inbox detail" }),
    ).not.toHaveTextContent("OLD BODY");
    h.failAux();
  } finally {
    await act(async () => release());
  }
  await waitFor(() =>
    expect(
      screen.getByRole("region", { name: "Inbox detail" }),
    ).toHaveTextContent("Preview unavailable. Retry inbox."),
  );
  expect(
    screen.getByRole("button", {
      name: /^Open /,
      current: "page",
    }),
  ).toHaveAccessibleDescription("Preview unavailable. Retry inbox.");
  h.failAux(false);
  fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
  await waitFor(() =>
    expect(h.owner.session.inboxFeed.snapshot()).toMatchObject({
      status: "ready",
      incomplete: [],
    }),
  );
  expect(
    screen.getByRole("button", {
      name: /^Open /,
      current: "page",
    }),
  ).toHaveAccessibleDescription("CURRENT BODY");
  expect(rows().some((row) => row.textContent?.includes("CURRENT BODY"))).toBe(
    true,
  );
  expect(rows().some((row) => row.textContent?.includes("OLD BODY"))).toBe(
    false,
  );
});

it("keeps the top-level origin coordinate after a read covers its reply", async () => {
  // Read state does not regroup rows until the relay lists read rows, so the
  // row keeps its root representative and the visit its captured origin.
  const h = fixture();
  const root = message(h.alice, ROOM, "New root mention", 30, [
    ["p", h.viewer.pubkey],
  ]);
  const reply = message(h.alice, ROOM, "New reply mention", 31, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  h.addEvent(root);
  h.addEvent(reply);
  h.emit([root, reply]);
  render(h.view);
  await screen.findByText("New root mention");
  const row = rows().find((item) =>
    item.textContent?.includes("New root mention"),
  );
  if (!row) throw Error("Missing root mention");
  fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
  await waitFor(() => expect(h.through({ root: root.id })).toBe(31));
  const detail = screen.getByRole("region", { name: "Inbox detail" });
  const held = rows().filter((item) => item.textContent?.includes("New r"));
  expect(held).toHaveLength(1);
  const [kept] = held;
  if (!kept) throw Error("Missing read row");
  expect(kept).toHaveTextContent("New root mention");
  expect(within(kept).getByRole("button", { name: /^Open / })).toHaveAttribute(
    "aria-current",
    "page",
  );
  fireEvent.click(
    within(detail).getByRole("button", { name: "Open in channel" }),
  );
  await waitFor(() =>
    expect(h.open).toHaveBeenCalledWith({
      version: 1,
      kind: "conversation",
      scope: h.scope,
      channelId: ROOM,
      messageId: root.id,
    }),
  );
  // Back: the thread reader's own close does not render in this fixture, so
  // use the detail's Escape dismissal (InboxDetail.tsx:170-180).
  fireEvent.keyDown(screen.getByRole("region", { name: "Inbox detail" }), {
    key: "Escape",
  });
  expect(
    screen.queryByRole("region", { name: "Inbox detail" }),
  ).not.toBeInTheDocument();
  // Stated difference: no read-row listing yet, so a read keeps the row.
  expect(
    rows().filter((item) => item.textContent?.includes("New r")),
  ).toHaveLength(1);
});

it("retires a deleted selected row and restores focus to a still-visible fallback", async () => {
  const h = fixture({ withDm: true });
  render(h.view);
  await screen.findByText("A direct reply");
  const mention = rows().find((row) =>
    row.textContent?.includes("Please review this"),
  );
  if (!mention) throw Error("Missing mention row");
  fireEvent.click(within(mention).getByRole("button", { name: /^Open / }));
  const before = await screen.findByRole("region", { name: "Inbox detail" });
  // Control: the reader shows the message before its deletion.
  await waitFor(() => expect(before).toHaveTextContent("Please review this"));
  act(() =>
    h.emit([
      signed(h.alice, {
        kind: 5,
        content: "",
        created_at: 99,
        tags: [
          ["h", ROOM],
          ["e", h.mention.id],
        ],
      }),
    ]),
  );
  // Visit stays until Back (Eva's rule); the deleted row leaves the list.
  await waitFor(() =>
    expect(
      rows().some((row) => row.textContent?.includes("Please review this")),
    ).toBe(false),
  );
  const detail = screen.getByRole("region", { name: "Inbox detail" });
  // Observed: a top-level target opens in ThreadPanel, not ChannelPreview.
  expect(detail).toBe(before);
  await waitFor(() =>
    expect(detail).toHaveTextContent("Selected message unavailable"),
  );
  expect(detail).not.toHaveTextContent("Please review this");
  fireEvent.keyDown(
    within(detail).getByRole("button", { name: "Close thread" }),
    { key: "Escape" },
  );
  await waitFor(() => expect(detail).not.toBeInTheDocument());
  const fallback = rows()[0];
  if (!fallback) throw Error("Missing fallback row");
  await waitFor(() =>
    expect(
      within(fallback).getByRole("button", { name: /^Open / }),
    ).toHaveFocus(),
  );
  expect(
    rows().some((row) => row.textContent?.includes("Please review this")),
  ).toBe(false);
});

it("waits for a held read before restoring focus after a selected row is deleted", async () => {
  // Restated on the DM row (a top-level mention click writes nothing, so it
  // cannot hold a save). The visit stays until Back (Eva's rule).
  const h = fixture({ withDm: true });
  render(h.view);
  await screen.findByText("A direct reply");
  const dm = h.events.find((event) => event.content === "A direct reply");
  const dmRow = rows().find((row) =>
    row.textContent?.includes("A direct reply"),
  );
  if (!dm || !dmRow) throw Error("Missing DM row");
  const release = h.holdSave();
  try {
    fireEvent.click(within(dmRow).getByRole("button", { name: /^Open / }));
    await waitFor(() => expect(h.saveStarted()).toBe(true));
    const detail = screen.getByRole("region", { name: "Inbox detail" });
    act(() =>
      h.emit([
        signed(h.alice, {
          kind: 5,
          content: "",
          created_at: 99,
          tags: [
            ["h", DM_ROOM],
            ["e", dm.id],
          ],
        }),
      ]),
    );
    await waitFor(() =>
      expect(
        rows().some((row) => row.textContent?.includes("A direct reply")),
      ).toBe(false),
    );
    expect(detail).toBeInTheDocument();
    fireEvent.keyDown(
      within(detail).getByRole("button", { name: "Close detail" }),
      { key: "Escape" },
    );
    await waitFor(() => expect(detail).not.toBeInTheDocument());
    const fallback = rows()[0];
    if (!fallback) throw Error("Missing fallback row");
    // Focus restoration waits for the pending save (InboxPage.tsx:245).
    expect(
      within(fallback).getByRole("button", { name: /^Open / }),
    ).toBeDisabled();
  } finally {
    await act(async () => release());
  }
  const fallback = rows()[0];
  if (!fallback) throw Error("Missing fallback row after save");
  await waitFor(() =>
    expect(
      within(fallback).getByRole("button", { name: /^Open / }),
    ).toHaveFocus(),
  );
});

it("keeps the exact selected group visibly incomplete when a held reply's older root arrives", async () => {
  // An orphan reply is keyed under its e-tag root before the root is known
  // (unread.ts context()), so the root's arrival does not regroup it.
  const h = fixture();
  const root = message(h.alice, ROOM, "Older root", 29);
  const reply = message(h.alice, ROOM, "ORIGINAL REPLY", 30, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  const edit = signed(h.alice, {
    kind: 40003,
    content: "Edited reply",
    created_at: 31,
    tags: [
      ["h", ROOM],
      ["e", reply.id],
    ],
  });
  h.addEvent(reply);
  h.addEvent(edit);
  const release = h.holdAux();
  render(h.view);
  try {
    await waitFor(() =>
      expect(h.owner.session.inboxFeed.snapshot().incomplete).toContain(
        reply.id,
      ),
    );
    const original = rows().find((row) =>
      row.textContent?.includes("Preview updating…"),
    );
    if (!original) throw Error("No pending orphan reply");
    expect(
      h.owner.session.unread
        .inbox()
        .items.find((row) => row.messageIds.includes(reply.id))?.id,
    ).toBe(`${ROOM}:${root.id}`);
    // A landed read retires the row; fail it so the listed preview stays.
    h.failSave();
    fireEvent.click(within(original).getByRole("button", { name: /^Open / }));
    await findAlert("disk full");
    act(() => h.emit([root]));
    expect(
      screen.getByRole("region", { name: "Inbox detail" }),
    ).toHaveTextContent("Preview updating…");
    expect(
      screen.getByRole("region", { name: "Inbox detail" }),
    ).not.toHaveTextContent("ORIGINAL REPLY");
  } finally {
    await act(async () => release());
  }
  await waitFor(() =>
    expect(h.owner.session.inboxFeed.snapshot().incomplete).toEqual([]),
  );
  expect(rows().some((row) => row.textContent?.includes("Edited reply"))).toBe(
    true,
  );
});

it("a rejected thread read retries its frozen cutoff after a harmless later reply", async () => {
  // One thread step now (unread.ts:395-404); the intent boundary is unchanged.
  const h = fixture();
  const root = message(h.alice, ROOM, "Retry root", 30, [
    ["p", h.viewer.pubkey],
  ]);
  const child = message(h.alice, ROOM, "Retry reply", 31, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  const arriving = message(h.alice, ROOM, "Later reply", 32, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  h.addEvent(root);
  h.addEvent(child);
  h.emit([root, child]);
  render(h.view);
  await screen.findByText("Retry root");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  h.failThreadSave();
  const row = rows().find((item) => item.textContent?.includes("Retry root"));
  if (!row) throw Error("Missing retry row");
  fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
  await findAlert("thread disk full");
  expect(h.through({ root: root.id })).toBeUndefined();
  h.addEvent(arriving);
  act(() => h.emit([arriving]));
  fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
  await waitFor(() => expect(h.through({ root: root.id })).toBe(31));
  expect(h.readSteps.map((step) => step.id)).toEqual([child.id, child.id]);
  expect(
    h.owner.session.unread
      .inbox()
      .items.find((item) => item.id === `${ROOM}:${root.id}`)?.messageIds,
  ).toContain(arriving.id);
});

it("preserves a failed captured read across verified root regrouping", async () => {
  const h = fixture();
  const root = message(h.alice, ROOM, "Late regroup root", 29);
  const orphan = message(h.alice, ROOM, "Regrouped reply", 30, [
    ["p", h.viewer.pubkey],
    ["e", root.id, "", "reply"],
  ]);
  h.addEvent(orphan);
  h.emit([orphan]);
  render(h.view);
  await screen.findByText("Regrouped reply");
  h.failSave();
  const row = rows().find((candidate) =>
    candidate.textContent?.includes("Regrouped reply"),
  );
  if (!row) throw Error("Missing orphan");
  fireEvent.click(within(row).getByRole("button", { name: /^Open / }));
  await findAlert("disk full");
  expect(h.through({ root: root.id })).toBeUndefined();
  h.addEvent(root);
  act(() => h.emit([root]));
  expect(
    h.owner.session.unread
      .inbox()
      .items.some(
        (item) =>
          item.id === `${ROOM}:${root.id}` &&
          item.messageIds.includes(orphan.id),
      ),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
  await waitFor(() => expect(h.through({ root: root.id })).toBe(30));
  expect(h.readSteps.map((step) => step.id)).toEqual([orphan.id, orphan.id]);
});

it.each(["thread", "DM"] as const)(
  "a fresh %s unread row in the same visit keeps the old visit and re-click writes nothing",
  async (kind) => {
    // The fresh row shares the visit's key; the captured message is absent
    // from it, so the page keeps the captured item (InboxPage.tsx:232-241)
    // and the selected-row click guard (:715) prevents a second read.
    const h = fixture(kind === "DM" ? { withDm: true } : {});
    const channelId = kind === "DM" ? DM_ROOM : ROOM;
    render(h.view);
    let captured: string | undefined = h.reply.id;
    if (kind === "thread") await openThreadRow();
    else {
      await screen.findByText("A direct reply");
      captured = h.owner.session.unread
        .inbox()
        .items.find((row) => row.channelId === DM_ROOM)?.messageId;
      fireEvent.click(
        screen.getByRole("button", { name: "Open Alice in DM · Alice" }),
      );
    }
    if (!captured) throw Error("Missing captured message");
    // Positive arm: the first click writes exactly one read.
    if (kind === "thread")
      await waitFor(() =>
        expect(h.through({ root: h.threadRoot.id })).toBe(22),
      );
    else await waitFor(() => expect(h.through({ channel: DM_ROOM })).toBe(23));
    const writes = () =>
      kind === "thread" ? h.readSteps.length : h.channelReads.length;
    expect(writes()).toBe(1);
    const detail = screen.getByRole("region", { name: "Inbox detail" });
    const fresh = message(
      h.alice,
      channelId,
      `Fresh ${kind} message`,
      40,
      kind === "thread" ? [["e", h.threadRoot.id, "", "reply"]] : [],
    );
    h.addEvent(fresh);
    act(() => h.emit([fresh]));
    const row = await waitFor(() => {
      const found = rows().find((item) =>
        item.textContent?.includes(`Fresh ${kind} message`),
      );
      if (!found) throw Error("Missing fresh row");
      return found;
    });
    const item = h.owner.session.unread
      .inbox()
      .items.find((entry) => entry.messageIds.includes(fresh.id));
    expect(item?.messageIds).not.toContain(captured);
    const open = within(row).getByRole("button", { name: /^Open / });
    expect(open).toHaveAttribute("aria-current", "page");
    fireEvent.click(open);
    await act(async () => {});
    expect(writes()).toBe(1);
    expect(h.owner.session.unread.attention(channelId, fresh.id).unread).toBe(
      true,
    );
    // The old visit is retained: same detail, original target.
    expect(detail).toBeInTheDocument();
    fireEvent.click(
      within(detail).getAllByRole("button", { name: "Open in channel" })[0] ??
        detail,
    );
    await waitFor(() =>
      expect(h.open).toHaveBeenCalledWith(
        expect.objectContaining({ channelId, messageId: captured }),
      ),
    );
  },
);

it("DM read Retry retains the original cutoff and survives re-click of the selected row", async () => {
  const clickedAt = Math.floor(Date.now() / 1000);
  const now = vi.spyOn(Date, "now").mockReturnValue(clickedAt * 1000);
  const h = fixture({ withDm: true });
  const releaseHistory = h.holdHistory(DM_ROOM);
  try {
    render(h.view);
    await screen.findByText("A direct reply");
    await waitFor(() =>
      expect(
        screen.queryByText("Checking recent activity…"),
      ).not.toBeInTheDocument(),
    );
    const dmRow = rows().find((item) =>
      item.textContent?.includes("A direct reply"),
    );
    if (!dmRow) throw Error("Missing DM row");
    const row = within(dmRow).getByRole("button", { name: /^Open / });
    h.failSave();
    fireEvent.click(row);
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    fireEvent.click(row);
    now.mockReturnValue((clickedAt + 120) * 1000);
    const later = message(
      h.alice,
      DM_ROOM,
      "Arrived after failed read",
      clickedAt + 61,
    );
    h.addEvent(later);
    act(() => h.emit([later]));
    fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
    // The cutoff is the relay's latest message at click ("A direct reply", 23),
    // not the wall clock; a later arrival is a new intent and stays unread.
    await waitFor(() => expect(h.through({ channel: DM_ROOM })).toBe(23));
    expect(h.owner.session.unread.attention(DM_ROOM, later.id).unread).toBe(
      true,
    );
  } finally {
    await act(async () => releaseHistory());
    now.mockRestore();
  }
});

it("the Inbox owner dismisses an in-head DM with Escape but respects consumed child Escape", async () => {
  const h = fixture({ withDm: true });
  render(h.view);
  await screen.findByText("A direct reply");
  const row = screen.getByRole("button", { name: "Open Alice in DM · Alice" });
  fireEvent.click(row);
  const detail = await screen.findByRole("region", { name: "Inbox detail" });
  const close = await within(detail).findByRole("button", {
    name: "Close detail",
  });
  const consume = (event: KeyboardEvent) => event.preventDefault();
  close.addEventListener("keydown", consume);
  fireEvent.keyDown(close, { key: "Escape" });
  expect(detail).toBeInTheDocument();
  close.removeEventListener("keydown", consume);
  fireEvent.keyDown(close, { key: "Escape" });
  await waitFor(() => expect(detail).not.toBeInTheDocument());
  // The DM was read, so its row has left the unread-only list; Back's focus
  // chain lands on the first surviving row instead (InboxPage.tsx:244-256).
  expect(row).not.toBeInTheDocument();
  expect(
    rows().some((item) => item.textContent?.includes("A direct reply")),
  ).toBe(false);
  const first = rows()[0];
  if (!first) throw Error("Missing surviving row");
  await waitFor(() =>
    expect(within(first).getByRole("button", { name: /^Open / })).toHaveFocus(),
  );
});

it("Escape dismisses an incomplete detail without waiting for auxiliary history", async () => {
  const h = fixture();
  const release = h.holdAux();
  try {
    render(h.view);
    await screen.findByText("Preview updating…");
    await chooseFilter("Mentions");
    const user = userEvent.setup();
    screen.getByRole("button", { name: "Open Alice in #Design" }).focus();
    await user.keyboard("{Enter}");
    const detail = await screen.findByRole("region", { name: "Inbox detail" });
    expect(within(detail).getByRole("status")).toHaveTextContent(
      "Preview updating…",
    );
    expect(
      within(detail).getByRole("button", { name: "Close detail" }),
    ).toHaveFocus();
    // Status/profile updates in this same placeholder visit must not steal focus.
    const other = within(detail).getByRole("button", {
      name: "Open in channel",
    });
    other.focus();
    h.failAux();
    await act(async () => release());
    await waitFor(() =>
      expect(detail).toHaveTextContent("Preview unavailable. Retry inbox."),
    );
    expect(other).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(detail).not.toBeInTheDocument();
  } finally {
    await act(async () => release());
  }
});

it.each(["close", "delete", "delete-pending"])(
  "%s of the last filtered conversation restores a stable visible control",
  async (action) => {
    // Restated on the thread row (a top-level mention click writes nothing).
    // A read row leaves the unread-only list; the visit stays until Back.
    const h = fixture();
    render(h.view);
    await screen.findByText("A thread update");
    await chooseFilter("Threads");
    fireEvent.click(screen.getByRole("checkbox", { name: "Unread only" }));
    expect(rows()).toHaveLength(1);
    const release = action === "delete-pending" ? h.holdSave() : () => {};
    try {
      fireEvent.click(
        screen.getByRole("button", { name: "Open Alice in #Design" }),
      );
      const detail = await screen.findByRole("region", {
        name: "Inbox detail",
      });
      if (action === "delete-pending")
        await waitFor(() => expect(h.saveStarted()).toBe(true));
      else {
        await waitFor(() =>
          expect(h.through({ root: h.threadRoot.id })).toBe(h.reply.created_at),
        );
        await waitFor(() => expect(rows()).toHaveLength(0));
      }
      if (action !== "close")
        act(() =>
          h.emit([
            signed(h.alice, {
              kind: 5,
              content: "",
              created_at: 99,
              tags: [
                ["h", ROOM],
                ["e", h.reply.id],
              ],
            }),
          ]),
        );
      expect(detail).toBeInTheDocument();
      fireEvent.click(
        within(detail).getByRole("button", { name: "Close thread" }),
      );
      await waitFor(() => expect(detail).not.toBeInTheDocument());
    } finally {
      await act(async () => release());
    }
    await waitFor(() => expect(rows()).toHaveLength(0));
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Activity type" }),
      ).toHaveFocus(),
    );
  },
);

it("Retry with a ready roster waits for both evidence reads before retrying sync", async () => {
  const h = fixture();
  render(h.view);
  await screen.findByText("Please review this");
  await waitFor(() =>
    expect(h.owner.session.inboxFeed.snapshot().status).toBe("ready"),
  );
  h.failAux();
  await act(async () => h.owner.session.inboxFeed.refresh());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "auxiliary history unavailable",
  );
  h.failAux(false);
  const release = h.holdAux();
  try {
    fireEvent.click(screen.getByRole("button", { name: "Retry inbox" }));
    await waitFor(() =>
      expect(h.owner.session.inboxFeed.snapshot().incomplete).toContain(
        h.mention.id,
      ),
    );
    expect(h.retrySync).not.toHaveBeenCalled();
    expect(
      screen.getByRole("list", { name: "Inbox conversations" }),
    ).toHaveAttribute("aria-busy", "true");
  } finally {
    await act(async () => release());
  }
  await waitFor(() => expect(h.retrySync).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(
      screen.getByRole("list", { name: "Inbox conversations" }),
    ).toHaveAttribute("aria-busy", "false"),
  );
});
