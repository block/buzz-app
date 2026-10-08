// @vitest-environment jsdom
import { readView, writeView } from "../../shared/view-state";
import { useAttachmentDraft } from "../../features/messages/attachment-draft";
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { InboxPage } from "./InboxPage";
import { ChannelPreview } from "./ChannelPreview";
import { ThreadPanel } from "../../features/messages/ThreadPanel";

import { composerDOMFixture } from "../../features/messages/composer-testing";
import { createRelaySession } from "../../features/relay/session";
import type { RelaySnapshot, RelayData } from "../../features/relay/service";
import type { Navigation } from "../../features/navigation/controller";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import { matchesEvent } from "../../features/relay/projection";
import { threadBinding } from "../../features/relay/thread-window";
import {
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

vi.mock("./ChannelPreview", { spy: true });
vi.mock("../../features/messages/ThreadPanel", { spy: true });

// The sidebar API validates channel ids as UUIDs before any write.
const ROOM = "00000000-0000-4000-8000-000000000001";
const DM_ROOM = "00000000-0000-4000-8000-000000000002";
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
    withDm?: boolean;
    holdProfiles?: boolean;
    withWriter?: boolean;
    connected?: boolean;
    upload?: (
      file: File,
      signal: AbortSignal,
    ) => Promise<import("../../features/relay/attachments").UploadedAttachment>;
  } = {},
) {
  const viewer = keypair(),
    alice = keypair(),
    relayKey = keypair();
  let releaseProfiles = () => {};
  const profilesGate = options.holdProfiles
    ? new Promise<void>((resolve) => {
        releaseProfiles = resolve;
      })
    : undefined;
  const historyRequests: string[] = [];
  const threadRequests: string[] = [];
  const exactRequests: string[] = [];
  const published: RelayEvent[] = [];
  const historyGates = new Map<string, Promise<void>>();
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
  const bff = sidebarFixture();
  const origin = "https://relay.test";
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
    roster(relayKey, ROOM, [viewer.pubkey, alice.pubkey], 10),
    metadata(relayKey, ROOM, "Design", 10, [["t", "stream"]]),
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
        if (profilesGate && filters.some((filter) => filter.kinds?.includes(0)))
          await profilesGate;
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
        // UUID channels take the strict thread window (thread-window.ts:14),
        // which needs one relay-signed 39007 bound per filter.
        const windows = await Promise.all(
          filters
            .filter((filter) => filter.thread_window)
            .map(async (filter) =>
              signed(relayKey, {
                kind: 39007,
                tags: [
                  ["d", await threadBinding(filter, origin, viewer.pubkey)],
                  ["h", filter["#h"]?.[0] ?? ""],
                  ["e", filter["#e"]?.[0] ?? ""],
                ],
                content: JSON.stringify({
                  version: 1,
                  direction: "older",
                  has_more: false,
                  next_cursor: null,
                }),
              }),
            ),
        );
        return [...filters.flatMap(answer), ...windows];
      },
      scope: origin,
      media: () => undefined,
      ...(options.upload ? { uploadAttachment: options.upload } : {}),
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
      subscribe(callbacks) {
        if (options.connected)
          callbacks.state({ status: "connected", routes: [] });
        emit = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
      sidebarApi: bff.api,
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
  emit(events);
  const scope = {
    viewer: viewer.pubkey,
    communityOrigin: origin,
  };
  const observedSession = owner.session;
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
    observedSession,
    historyRequests,
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
    releaseProfiles,
    alice,
    viewer,
    emit,
    events,
    scope,
    mention,
    reply,
    open,
    /** Every read intent sent to the relay or queued for it. */
    readIntents: () => [
      ...bff.api.write.mock.calls.flatMap(([intents]) => intents),
      ...bff.journal().pending.map(({ intent }) => intent),
    ],
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
it("Drafts shares the composer storage, gates origin navigation on current membership, and deletes only after consent", async () => {
  const h = fixture({ withWriter: true });
  const root = h.mention.id;
  const key = `draft:${ROOM}:thread:${root}`;
  const saved = {
    text: "Draft reply @Alice",
    recipients: [
      { pubkey: h.mention.pubkey, name: "Alice", start: 12, end: 18 },
    ],
  };
  writeView(h.owner.session.scope, key, saved);
  writeView("other-scope", `draft:${ROOM}`, "Private other viewer draft");
  render(h.view);
  await screen.findByText("Please review this");
  await chooseFilter("Threads");
  await chooseFilter("Humans", "Sender");
  fireEvent.click(screen.getByRole("checkbox", { name: "Unread only" }));
  fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
  expect(
    screen.queryByRole("combobox", { name: "Activity type" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("combobox", { name: "Sender" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("checkbox", { name: "Unread only" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Back to Inbox" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Refresh" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("list", { name: "Drafts" })).toHaveTextContent(
    "Draft reply @Alice",
  );
  expect(
    screen.queryByText(/Private other viewer draft/),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(/Saved drafts on this device/),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Back to drafts" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Continue in conversation" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  expect(
    screen.getByRole("heading", { name: "Draft · Reply in #Design" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Delete draft…" })).toHaveAttribute(
    "data-variant",
    "destructive",
  );
  expect(screen.getByRole("button", { name: "Delete draft…" })).toHaveAttribute(
    "data-size",
    "sm",
  );
  fireEvent.click(screen.getByRole("button", { name: "Open in origin" }));
  await waitFor(() =>
    expect(h.open).toHaveBeenCalledWith({
      version: 1,
      kind: "conversation",
      scope: h.scope,
      channelId: ROOM,
      messageId: root,
      threadRootId: root,
    }),
  );
  expect(readView(h.owner.session.scope, key, "")).toEqual(saved);
  fireEvent.click(screen.getByRole("button", { name: "Delete draft…" }));
  expect(readView(h.owner.session.scope, key, "")).toEqual(saved);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(readView(h.owner.session.scope, key, "")).toEqual(saved);
  fireEvent.click(screen.getByRole("button", { name: "Delete draft…" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete draft" }));
  expect(readView(h.owner.session.scope, key, "")).toBe("");
  expect(screen.getByText("No drafts")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Back to Inbox" }));
  expect(
    screen.getByRole("combobox", { name: "Activity type" }),
  ).toHaveTextContent("Threads");
  expect(screen.getByRole("combobox", { name: "Sender" })).toHaveTextContent(
    "Humans",
  );
  expect(screen.getByRole("checkbox", { name: "Unread only" })).toBeChecked();
  expect(h.readIntents()).toEqual([]);
});

it("Drafts responds to same-window editor changes and disables composition if membership disappears", async () => {
  const h = fixture({ withWriter: true });
  render(h.view);
  await screen.findByText("Please review this");
  fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
  expect(screen.getByText("No drafts")).toBeVisible();
  act(() =>
    writeView(h.owner.session.scope, `draft:${ROOM}`, {
      text: "Unsent message",
      recipients: [],
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  expect(screen.getByRole("button", { name: "Open in origin" })).toBeEnabled();
  expect(screen.getByRole("textbox", { name: "Message #Design" })).toHaveValue(
    "Unsent message",
  );
  act(() => h.revokeRoom());
  expect(
    screen.queryByRole("button", { name: "Open in origin" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("textbox", { name: "Message #Design" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Delete draft…" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.getByRole("heading", { name: "Draft · Unavailable conversation" }),
  ).toBeInTheDocument();
  expect(readView(h.owner.session.scope, `draft:${ROOM}`, "")).toMatchObject({
    text: "Unsent message",
  });
  expect(h.open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close detail" }));
  expect(
    screen.queryByRole("region", { name: "Draft detail" }),
  ).not.toBeInTheDocument();
  expect(readView(h.owner.session.scope, `draft:${ROOM}`, "")).toMatchObject({
    text: "Unsent message",
  });
});

it("a failed confirmed draft deletion keeps the original saved text and remains retryable", async () => {
  const h = fixture();
  const key = `draft:${ROOM}`;
  writeView(h.owner.session.scope, key, "Do not discard me");
  render(h.view);
  await screen.findByText("Please review this");
  fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete draft…" }));
  const failure = vi
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementation(() => {
      throw new Error("disk full");
    });
  try {
    fireEvent.click(screen.getByRole("button", { name: "Delete draft" }));
    expect(screen.getByRole("alert")).toHaveTextContent("disk full");
    expect(readView(h.owner.session.scope, key, "")).toBe("Do not discard me");
  } finally {
    failure.mockRestore();
  }
  fireEvent.click(screen.getByRole("button", { name: "Delete draft" }));
  expect(readView(h.owner.session.scope, key, "")).toBe("");
  expect(screen.getByText("No drafts")).toBeInTheDocument();
});

it("a selected DM draft reads only its real window and preserves its scoped composer", async () => {
  const h = fixture({ withDm: true, withWriter: true });
  writeView(h.owner.session.scope, `draft:${DM_ROOM}`, "DM draft body");
  writeView(h.owner.session.scope, `draft:${ROOM}`, "Channel draft body");
  render(h.view);
  await screen.findByText("A direct reply");
  fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
  expect(h.owner.session.channels.window(ROOM).status).toBe("idle");
  expect(h.owner.session.channels.window(DM_ROOM).status).toBe("idle");
  fireEvent.click(screen.getByRole("button", { name: "Open draft for Alice" }));
  const preview = () =>
    screen.getByRole("region", { name: "Conversation preview" });
  await waitFor(() =>
    expect(h.owner.session.channels.window(DM_ROOM).status).toBe("ready"),
  );
  expect(
    h.owner.session.channels
      .window(DM_ROOM)
      .rows.some((row) => row.content === "A direct reply"),
  ).toBe(true);
  expect(h.owner.session.channels.window(ROOM).status).toBe("idle");
  expect(
    within(preview()).getByRole("textbox", { name: "Message DM with Alice" }),
  ).toHaveValue("DM draft body");
  expect(within(preview()).getAllByRole("form")).toHaveLength(1);
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  await waitFor(() =>
    expect(h.owner.session.channels.window(ROOM).status).toBe("ready"),
  );
  expect(
    within(preview()).getByRole("textbox", { name: "Message #Design" }),
  ).toHaveValue("Channel draft body");
  expect(
    screen.queryByRole("textbox", { name: "Message DM with Alice" }),
  ).not.toBeInTheDocument();
  expect(readView(h.owner.session.scope, `draft:${DM_ROOM}`, "")).toBe(
    "DM draft body",
  );
});

it("a selected draft edits through the shared scoped composer without navigating or sending", async () => {
  const h = fixture({ withWriter: true });
  const key = `draft:${ROOM}`;
  writeView(h.owner.session.scope, key, "First draft");
  render(h.view);
  await screen.findByText("Please review this");
  fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  const input = screen.getByRole("textbox", { name: "Message #Design" });
  expect(input).toHaveValue("First draft");
  fireEvent.input(input, { target: { value: "Revised draft" } });
  await waitFor(() =>
    expect(readView(h.owner.session.scope, key, "")).toMatchObject({
      text: "Revised draft",
    }),
  );
  expect(h.open).not.toHaveBeenCalled();
  expect(h.readIntents()).toEqual([]);
});

it("DM draft headings use exact roster participants and recover as profile evidence arrives", async () => {
  const h = fixture({ withDm: true, holdProfiles: true, withWriter: true });
  const key = `draft:${DM_ROOM}`;
  writeView(h.owner.session.scope, key, {
    text: "  hi\n  again ",
    recipients: [],
  });
  render(h.view);
  await screen.findByText("A direct reply");
  fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
  const detail = () => screen.getByRole("region", { name: "Draft detail" });
  const row = screen.getByRole("list", { name: "Drafts" });
  expect(row).toHaveTextContent("DM");
  fireEvent.click(
    within(row).getByRole("button", { name: /^Open draft for / }),
  );
  expect(
    within(detail()).getByRole("heading", { name: /Draft · DM to npub/ }),
  ).toBeInTheDocument();
  expect(
    within(detail()).getByRole("textbox", { name: /Message DM with npub/ }),
  ).toHaveValue("  hi\n  again ");
  try {
    await act(async () => h.releaseProfiles());
    await waitFor(() =>
      expect(
        within(detail()).getByRole("heading", { name: "Draft · DM to Alice" }),
      ).toBeInTheDocument(),
    );
    expect(h.readIntents()).toEqual([]);
  } finally {
    h.releaseProfiles();
  }
});

it("holds selected history, surfaces failure, and retries to a genuinely empty channel without losing the draft", async () => {
  const h = fixture({ withDm: true, withWriter: true });
  writeView(
    h.owner.session.scope,
    `draft:${DM_ROOM}`,
    "Keep while history recovers",
  );
  render(h.view);
  await screen.findByText("A direct reply");
  await waitFor(() =>
    expect(
      screen.queryByText("Checking recent activity…"),
    ).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
  const release = h.holdHistory(DM_ROOM);
  h.failHistory(DM_ROOM);
  try {
    fireEvent.click(
      screen.getByRole("button", { name: "Open draft for Alice" }),
    );
    await waitFor(() => expect(h.historyRequests).toContain(DM_ROOM));
    expect(screen.queryByText("No messages yet.")).not.toBeInTheDocument();
    expect(h.owner.session.channels.window(DM_ROOM).status).toBe("loading");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  } finally {
    await act(async () => release());
  }
  expect(
    await screen.findByRole("button", { name: "Retry conversation" }),
  ).toBeInTheDocument();
  expect(
    screen
      .getAllByRole("alert")
      .some((node) => node.textContent?.includes("history offline")),
  ).toBe(true);
  expect(screen.queryByText("Loading conversation…")).not.toBeInTheDocument();
  act(() => h.deleteHistory(DM_ROOM));
  h.recoverHistory(DM_ROOM);
  fireEvent.click(screen.getByRole("button", { name: "Retry conversation" }));
  await screen.findByText("No messages yet.");
  expect(
    screen.queryByRole("button", { name: "Retry conversation" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("textbox", { name: "Message DM with Alice" }),
  ).toHaveValue("Keep while history recovers");
});

it("retargets a held DM history without leaking the old context or draft and sends only to the selected channel", async () => {
  const h = fixture({ withDm: true, withWriter: true });
  writeView(h.owner.session.scope, `draft:${DM_ROOM}`, "Keep DM draft");
  writeView(h.owner.session.scope, `draft:${ROOM}`, "Send this channel draft");
  render(h.view);
  await screen.findByText("A direct reply");
  fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
  const release = h.holdHistory(DM_ROOM);
  try {
    fireEvent.click(
      screen.getByRole("button", { name: "Open draft for Alice" }),
    );
    await waitFor(() => expect(h.historyRequests).toContain(DM_ROOM));
    fireEvent.click(
      screen.getByRole("button", { name: "Open draft for #Design" }),
    );
    await waitFor(() =>
      expect(h.owner.session.channels.window(ROOM).status).toBe("ready"),
    );
    expect(
      screen.getByRole("textbox", { name: "Message #Design" }),
    ).toHaveValue("Send this channel draft");
    expect(
      screen.queryByRole("textbox", { name: /Message DM/ }),
    ).not.toBeInTheDocument();
  } finally {
    await act(async () => release());
  }
  await waitFor(() =>
    expect(h.owner.session.channels.window(DM_ROOM).status).toBe("ready"),
  );
  expect(screen.getAllByRole("textbox")).toHaveLength(1);
  const detail = screen.getByRole("region", { name: "Draft detail" });
  expect(
    within(detail).getByRole("region", { name: "Channel message history" }),
  ).toHaveAttribute("data-channel-timeline", ROOM);
  fireEvent.click(within(detail).getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(h.published).toHaveLength(1));
  expect(h.published[0]).toMatchObject({
    kind: 9,
    content: "Send this channel draft",
  });
  expect(h.published[0]?.tags).toContainEqual(["h", ROOM]);
  expect(h.published[0]?.tags.some(([tag]) => tag === "e")).toBe(false);
  expect(readView(h.owner.session.scope, `draft:${DM_ROOM}`, "")).toBe(
    "Keep DM draft",
  );
});

it("renders an exact draft thread's real root and replies with one composer and sends to that root", async () => {
  const h = fixture({ withWriter: true });
  if (!h.root) throw new Error("Missing root");
  const key = `draft:${ROOM}:thread:${h.root.id}`;
  writeView(h.owner.session.scope, key, "Thread draft to send");
  render(h.view);
  await screen.findByText("Please review this");
  fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
  const release = h.holdHistory(ROOM);
  try {
    fireEvent.click(
      screen.getByRole("button", { name: "Open draft for #Design" }),
    );
    await waitFor(() => expect(h.exactRequests).toContain(h.root?.id));
    expect(
      screen.queryByRole("textbox", { name: "Reply to thread" }),
    ).not.toBeInTheDocument();
  } finally {
    await act(async () => release());
  }
  const history = await screen.findByRole("region", {
    name: "Thread messages",
  });
  await within(history).findByText("Our discussion");
  await within(history).findByText("A thread update");
  const input = await screen.findByRole("textbox", { name: "Reply to thread" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled(),
  );
  expect(input).toHaveValue("Thread draft to send");
  expect(screen.getAllByRole("textbox")).toHaveLength(1);
  expect(h.historyRequests).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(h.published).toHaveLength(1));
  expect(h.published[0]?.tags).toContainEqual(["h", ROOM]);
  expect(h.published[0]?.tags).toContainEqual(["e", h.root.id, "", "reply"]);
  expect(readView(h.owner.session.scope, key, "")).toMatchObject({ text: "" });
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Draft detail" }),
    ).not.toBeInTheDocument(),
  );
});

it("keeps the scoped draft but removes its thread composer and history when the root is deleted", async () => {
  const h = fixture({ withWriter: true });
  if (!h.root) throw new Error("Missing root");
  const key = `draft:${ROOM}:thread:${h.root.id}`;
  writeView(h.owner.session.scope, key, "Do not retarget this reply");
  render(h.view);
  await screen.findByText("Please review this");
  fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  await screen.findByRole("textbox", { name: "Reply to thread" });
  act(() => h.retireThreadRoot());
  await waitFor(() =>
    expect(
      screen.queryByRole("textbox", { name: "Reply to thread" }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.queryByText("Our discussion")).not.toBeInTheDocument();
  expect(readView(h.owner.session.scope, key, "")).toBe(
    "Do not retarget this reply",
  );
  expect(h.published).toHaveLength(0);
});

it("retries thread history failure without another composer and never rebinds a malformed saved thread coordinate", async () => {
  const h = fixture({ withWriter: true });
  if (!h.root) throw new Error("Missing root");
  const key = `draft:${ROOM}:thread:${h.root.id}`;
  writeView(h.owner.session.scope, key, "Retry this thread draft");
  render(h.view);
  await screen.findByText("Please review this");
  fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
  h.failHistory(ROOM);
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  const retry = await screen.findByRole("button", { name: "Retry thread" });
  expect(
    screen.queryByRole("textbox", { name: "Reply to thread" }),
  ).not.toBeInTheDocument();
  h.recoverHistory(ROOM);
  fireEvent.click(retry);
  const composer = await screen.findByRole("textbox", {
    name: "Reply to thread",
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled(),
  );
  expect(composer).toHaveValue("Retry this thread draft");
  fireEvent.click(screen.getByRole("button", { name: "Close thread" }));
  // A saved reply ID cannot silently resolve to another root-keyed draft.
  act(() => {
    writeView(h.owner.session.scope, key, "");
    writeView(
      h.owner.session.scope,
      `draft:${ROOM}:thread:${h.reply.id}`,
      "Invalid coordinate draft",
    );
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  await screen.findByText(/This saved draft does not identify a thread root/);
  expect(
    screen.queryByRole("textbox", { name: "Reply to thread" }),
  ).not.toBeInTheDocument();
  expect(
    readView(h.owner.session.scope, `draft:${ROOM}:thread:${h.reply.id}`, ""),
  ).toBe("Invalid coordinate draft");
  expect(h.published).toHaveLength(0);
});

it("sends a DM draft only to its restored destination through the session outbox", async () => {
  const h = fixture({ withDm: true, withWriter: true });
  writeView(h.owner.session.scope, `draft:${DM_ROOM}`, "Only this DM");
  render(h.view);
  await screen.findByText("A direct reply");
  fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
  fireEvent.click(screen.getByRole("button", { name: "Open draft for Alice" }));
  const detail = screen.getByRole("region", { name: "Draft detail" });
  expect(
    within(detail).getByRole("textbox", { name: "Message DM with Alice" }),
  ).toHaveValue("Only this DM");
  fireEvent.click(within(detail).getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(h.published).toHaveLength(1));
  expect(h.published[0]).toMatchObject({ kind: 9, content: "Only this DM" });
  expect(h.published[0]?.tags).toContainEqual(["h", DM_ROOM]);
  expect(h.published[0]?.tags.some(([tag]) => tag === "e")).toBe(false);
});

it("meaningful Drafts survive 500 empty records and keep an emptied selected editor until close", async () => {
  const h = fixture({ withWriter: true });
  for (let i = 0; i < 510; i++)
    writeView(h.owner.session.scope, `draft:empty-${i}`, { text: "  " });
  writeView(h.owner.session.scope, `draft:${ROOM}`, {
    text: "Keep editing",
    recipients: [],
  });
  render(h.view);
  await screen.findByText("Please review this");
  fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  const editor = await screen.findByRole("textbox", {
    name: "Message #Design",
  });
  fireEvent.change(editor, { target: { value: "" } });
  await waitFor(() =>
    expect(
      readView(h.owner.session.scope, `draft:${ROOM}`, "missing"),
    ).toMatchObject({ text: "" }),
  );
  expect(screen.getByRole("textbox", { name: "Message #Design" })).toBe(editor);
  expect(
    screen.getByRole("region", { name: "Draft detail" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close detail" }));
  expect(
    screen.queryByRole("region", { name: "Draft detail" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("No drafts")).toBeInTheDocument();
});
it("hands keyboard focus into draft deletion and back on cancel without changing the saved draft", async () => {
  const h = fixture({ withWriter: true });
  writeView(h.owner.session.scope, `draft:${ROOM}`, "Keep this draft");
  render(h.view);
  await screen.findByText("Please review this");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Drafts" }));
  await user.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  const trigger = screen.getByRole("button", { name: "Delete draft…" });
  trigger.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("button", { name: "Delete draft" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("button", { name: "Delete draft…" })).toHaveFocus();
  expect(readView(h.owner.session.scope, `draft:${ROOM}`, "")).toBe(
    "Keep this draft",
  );
});

it("Delete draft clears exact ready attachments but preserves sibling channel and thread files", async () => {
  const h = fixture({
    withWriter: true,
    upload: async () => ({
      name: "note.txt",
      url: "https://relay.test/media/note.txt",
      type: "text/plain",
      size: 4,
      sha256: "a".repeat(64),
    }),
  });
  const key = `draft:${ROOM}`;
  const root = h.root;
  if (!root) throw Error("Missing fixture root");
  writeView(h.owner.session.scope, key, "Discard this text");
  writeView(h.owner.session.scope, `draft:${DM_ROOM}`, "Another draft");
  const exact = renderHook(() =>
    useAttachmentDraft(
      h.observedSession,
      `${h.owner.session.scope}:${key}`,
      ROOM,
    ),
  );
  const sibling = renderHook(() =>
    useAttachmentDraft(
      h.observedSession,
      `${h.owner.session.scope}:draft:${ROOM}:thread:${root.id}`,
      ROOM,
    ),
  );
  const file = new File(["note"], "note.txt", { type: "text/plain" });
  act(() => {
    exact.result.current.store.add([file]);
    sibling.result.current.store.add([file]);
  });
  render(h.view);
  await screen.findByText("Please review this");
  fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete draft…" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete draft" }));
  expect(readView(h.owner.session.scope, key, "")).toBe("");
  expect(exact.result.current.items).toEqual([]);
  expect(sibling.result.current.items).toHaveLength(1);
  expect(readView(h.owner.session.scope, `draft:${DM_ROOM}`, "")).toBe(
    "Another draft",
  );
});

it("a failed saved-text cleanup keeps its exact attachment draft for retry", async () => {
  const h = fixture({
    withWriter: true,
    upload: async () => ({
      name: "keep.txt",
      url: "https://relay.test/media/keep.txt",
      type: "text/plain",
      size: 4,
      sha256: "b".repeat(64),
    }),
  });
  const key = `draft:${ROOM}`;
  writeView(h.owner.session.scope, key, "Keep this body");
  const files = renderHook(() =>
    useAttachmentDraft(
      h.observedSession,
      `${h.owner.session.scope}:${key}`,
      ROOM,
    ),
  );
  act(() => files.result.current.store.add([new File(["keep"], "keep.txt")]));
  render(h.view);
  await screen.findByText("Please review this");
  fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete draft…" }));
  const denied = vi
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementation(() => {
      throw Error("disk full");
    });
  try {
    fireEvent.click(screen.getByRole("button", { name: "Delete draft" }));
    expect(
      screen.getByRole("region", { name: "Draft detail" }),
    ).toHaveTextContent("disk full");
    expect(readView(h.owner.session.scope, key, "")).toBe("Keep this body");
    expect(files.result.current.items).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Delete draft" })).toHaveFocus();
  } finally {
    denied.mockRestore();
  }
  fireEvent.click(screen.getByRole("button", { name: "Delete draft" }));
  expect(readView(h.owner.session.scope, key, "")).toBe("");
  expect(files.result.current.items).toEqual([]);
});

it.each([false, true])(
  "retains accepted %s draft cleanup recovery without publishing twice, including reopen",
  async (thread) => {
    const h = fixture({ withWriter: true });
    const key = thread
      ? `draft:${ROOM}:thread:${h.mention.id}`
      : `draft:${ROOM}`;
    const storageKey = `buzz-view.v1:${JSON.stringify([h.owner.session.scope, key])}`;
    writeView(h.owner.session.scope, key, "Accepted body");
    render(h.view);
    await screen.findByText("Please review this");
    fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Open draft for #Design" }),
    );
    await screen.findByRole("textbox");
    // A thread composer sends only once its strict window has settled.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled(),
    );
    const original = Storage.prototype.setItem;
    const fail = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === storageKey) throw Error("Storage full");
        return original.call(this, key, value);
      });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(h.published).toHaveLength(1));
      expect(
        screen.getByRole("region", { name: "Draft detail" }),
      ).toBeVisible();
      expect(screen.getByRole("alert")).toHaveTextContent(/accepted.*draft/i);
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeDisabled();
      fireEvent.click(
        screen.getByRole("button", {
          name: thread ? "Close thread" : "Close detail",
        }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Open draft for #Design" }),
      );
      await screen.findByRole("button", { name: "Retry draft cleanup" });
      expect(screen.getByRole("textbox")).toHaveValue("");
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeDisabled();
    } finally {
      fail.mockRestore();
    }
    fireEvent.click(
      screen.getByRole("button", { name: "Retry draft cleanup" }),
    );
    expect(
      screen.queryByRole("region", { name: "Draft detail" }),
    ).not.toBeInTheDocument();
    expect(readView(h.owner.session.scope, key, "")).toMatchObject({
      text: "",
    });
    expect(h.published).toHaveLength(1);
  },
);

function replaceStoredDraft(scope: string, key: string, text: string) {
  const storageKey = `buzz-view.v1:${JSON.stringify([scope, key])}`;
  act(() => {
    localStorage.setItem(storageKey, JSON.stringify({ text, recipients: [] }));
    window.dispatchEvent(
      new StorageEvent("storage", {
        storageArea: localStorage,
        key: storageKey,
      }),
    );
  });
}

it("reloads a clean selected editor with the row and requires a dirty conflict choice without remounting", async () => {
  const h = fixture({ withWriter: true });
  const scope = h.owner.session.scope,
    key = `draft:${ROOM}`;
  writeView(scope, key, "Original body");
  render(h.view);
  await screen.findByText("Please review this");
  fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
  const row = screen.getByRole("button", { name: "Open draft for #Design" });
  fireEvent.click(row);
  const input = screen.getByRole(
    "textbox",
  ) as import("../../features/messages/composer-dom").ComposerInputElement;
  replaceStoredDraft(scope, key, "Other window revision");
  expect(row).toHaveTextContent("Other window revision");
  fireEvent.click(row);
  expect(screen.getByRole("textbox")).toBe(input);
  expect(input).toHaveValue("Other window revision");
  fireEvent.change(input, { target: { value: "My local edits" } });
  replaceStoredDraft(scope, key, "Newer saved work");
  fireEvent.click(row);
  expect(input).toHaveValue("My local edits");
  expect(screen.getByRole("alert")).toHaveTextContent(/changed elsewhere/i);
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  fireEvent.change(input, { target: { value: "More local edits" } });
  expect(readView(scope, key, "")).toMatchObject({ text: "Newer saved work" });
  fireEvent.click(screen.getByRole("button", { name: "Keep my draft" }));
  expect(readView(scope, key, "")).toMatchObject({ text: "More local edits" });
  replaceStoredDraft(scope, key, "Last saved work");
  fireEvent.click(screen.getByRole("button", { name: "Load saved draft" }));
  expect(input).toHaveValue("Last saved work");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(h.published).toHaveLength(0);
});

it("keeps a valid rich editor mounted across 128 KiB and reopens the saved document", async () => {
  const h = fixture({ withWriter: true });
  const { mentionDraft } = await import(
    "../../features/messages/mention-draft"
  );
  const { readComposerSnapshot } = await import(
    "../../features/messages/composer-document"
  );
  const document = {
    version: 1,
    content: {
      type: "doc",
      content: Array.from({ length: 1898 }, () => ({
        type: "paragraph",
        content: [{ type: "text", text: "note" }],
      })),
    },
  };
  expect(readComposerSnapshot(document)).toBeDefined();
  const rich = mentionDraft({ document });
  expect(JSON.stringify(rich).length).toBeLessThan(128 * 1024);
  writeView(h.owner.session.scope, `draft:${ROOM}`, rich);
  render(h.view);
  await screen.findByText("Please review this");
  fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  const input = screen.getByRole(
    "textbox",
  ) as import("../../features/messages/composer-dom").ComposerInputElement;
  act(() => {
    input.setSelectionRange(input.value.length, input.value.length);
    input.insertText(" plus twelve new letters");
  });
  expect(screen.getByRole("textbox")).toBe(input);
  const saved = readView(h.owner.session.scope, `draft:${ROOM}`, rich);
  expect(JSON.stringify(saved).length).toBeGreaterThan(128 * 1024);
  expect(readComposerSnapshot(saved.document)).toBeDefined();
  expect(mentionDraft(saved).text).toBe(`${rich.text} plus twelve new letters`);
  fireEvent.click(screen.getByRole("button", { name: "Close detail" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  expect(screen.getByRole("textbox")).toHaveValue(mentionDraft(saved).text);
});

it("discloses records beyond the bounded preview without retiring a selected editor", async () => {
  const h = fixture({ withWriter: true });
  const key = `buzz-view.v1:${JSON.stringify([h.owner.session.scope, `draft:${ROOM}`])}`;
  writeView(
    h.owner.session.scope,
    `draft:${ROOM}`,
    "Kept in the selected editor",
  );
  render(h.view);
  await screen.findByText("Please review this");
  fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Open draft for #Design" }),
  );
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "My retained edits" } });
  const getItem = Storage.prototype.getItem;
  const oversized = JSON.stringify({ text: "x".repeat(8 * 1024 * 1024) });
  const read = vi
    .spyOn(Storage.prototype, "getItem")
    .mockImplementation(function (this: Storage, storageKey) {
      return storageKey === key ? oversized : getItem.call(this, storageKey);
    });
  try {
    act(() =>
      window.dispatchEvent(
        new StorageEvent("storage", { storageArea: localStorage, key }),
      ),
    );
    expect(
      screen.getByText(/saved drafts exceed the preview size limit/),
    ).toBeVisible();
    expect(screen.queryByText("No drafts")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBe(input);
    expect(input).toHaveValue("My retained edits");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  } finally {
    read.mockRestore();
  }
});

it.each(["channel", "thread", "unavailable"])(
  "returns focus to the invoking %s draft after Close",
  async (kind) => {
    const h = fixture({ withWriter: true });
    const key =
      kind === "thread"
        ? `draft:${ROOM}:thread:${h.mention.id}`
        : kind === "unavailable"
          ? "draft:missing"
          : `draft:${ROOM}`;
    writeView(h.owner.session.scope, key, "Keep my place");
    render(h.view);
    await screen.findByText("Please review this");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Drafts" }));
    const row = screen.getByRole("button", { name: /^Open draft for/ });
    await user.click(row);
    const close = await screen.findByRole("button", {
      name: kind === "thread" ? "Close thread" : "Close detail",
    });
    close.focus();
    await user.keyboard("{Enter}");
    expect(row).toHaveFocus();
    expect(
      screen.queryByRole("region", { name: "Draft detail" }),
    ).not.toBeInTheDocument();
  },
);

it.each(["delete", "send", "empty-close"])(
  "restores focus to a remaining row then Back to Inbox on %s",
  async (exit) => {
    const h = fixture({ withWriter: true, withDm: true });
    writeView(h.owner.session.scope, `draft:${ROOM}`, "First draft");
    writeView(h.owner.session.scope, `draft:${DM_ROOM}`, "Second draft");
    render(h.view);
    await screen.findByText("Please review this");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Drafts" }));
    const remaining = screen.getByRole("button", {
      name: "Open draft for Alice",
    });
    for (const name of ["Open draft for #Design", "Open draft for Alice"]) {
      await user.click(screen.getByRole("button", { name }));
      const editor = await screen.findByRole("textbox");
      if (exit === "empty-close")
        fireEvent.change(editor, { target: { value: "" } });
      if (exit === "delete")
        await user.click(screen.getByRole("button", { name: "Delete draft…" }));
      const control = screen.getByRole("button", {
        name:
          exit === "delete"
            ? "Delete draft"
            : exit === "send"
              ? "Send message"
              : "Close detail",
      });
      control.focus();
      await user.keyboard("{Enter}");
      expect(
        screen.queryByRole("region", { name: "Draft detail" }),
      ).not.toBeInTheDocument();
      expect(
        name === "Open draft for #Design"
          ? remaining
          : screen.getByRole("button", { name: "Back to Inbox" }),
      ).toHaveFocus();
    }
  },
);

it.each([false, true])(
  "ignores a retired visit's saved-send callback after retargeting (thread: %s)",
  async (thread) => {
    const h = fixture({ withWriter: true, withDm: true });
    writeView(
      h.owner.session.scope,
      thread ? `draft:${ROOM}:thread:${h.mention.id}` : `draft:${ROOM}`,
      "First draft",
    );
    writeView(h.owner.session.scope, `draft:${DM_ROOM}`, "Second draft");
    render(h.view);
    await screen.findByText("Please review this");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Drafts" }));
    const firstRow = screen.getByRole("button", {
      name: "Open draft for #Design",
    });
    await user.click(firstRow);
    await screen.findByRole("textbox");
    // Spy calls still execute the real components/hooks. Retain just the old
    // callback to control its delivery after the visit has been replaced.
    const retired = thread
      ? vi.mocked(ThreadPanel).mock.calls.at(-1)?.[0].onDraftSaved
      : vi.mocked(ChannelPreview).mock.calls.at(-1)?.[0].onDraftSaved;
    expect(retired).toBeTypeOf("function");
    await user.click(
      screen.getByRole("button", { name: "Open draft for Alice" }),
    );
    await screen.findByRole("textbox", { name: "Message DM with Alice" });
    // Even returning to the same draft key is a new visit, not the old callback's target.
    await user.click(firstRow);
    const current = await screen.findByRole("textbox");
    current.focus();
    act(() => retired?.());
    expect(
      screen.getByRole("region", { name: "Draft detail" }),
    ).toBeInTheDocument();
    expect(current).toHaveFocus();
  },
);

it("returns to the invoking row when Send saves a remembered-agent follow-up", async () => {
  const h = fixture({ withWriter: true, withDm: true, connected: true });
  writeView(
    h.owner.session.scope,
    `draft:${ROOM}`,
    "First row, not the invoker",
  );
  writeView(h.owner.session.scope, `draft:${DM_ROOM}`, {
    text: "@Alice Hello",
    recipients: [{ pubkey: h.alice.pubkey, name: "Alice", start: 0, end: 6 }],
  });
  const agent = profile(
    h.alice,
    { name: "Alice", isAgent: true },
    1_700_000_001,
  );
  h.addEvent(agent);
  h.emit([agent]);
  await h.observedSession.profiles.ensure([h.alice.pubkey], "background");
  expect(
    h.observedSession.profiles.snapshot().get(h.alice.pubkey)?.isAgent,
  ).toBe(true);
  render(h.view);
  await screen.findByText("Please review this");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Drafts" }));
  const row = screen.getByRole("button", { name: "Open draft for Alice" });
  await user.click(row);
  await screen.findByRole("textbox");
  const send = screen.getByRole("button", { name: "Send message" });
  send.focus();
  await user.keyboard("{Enter}");
  expect(
    screen.queryByRole("region", { name: "Draft detail" }),
  ).not.toBeInTheDocument();
  expect(row).toHaveFocus();
  expect(row).toHaveTextContent("@Alice");
  expect(readView(h.owner.session.scope, `draft:${DM_ROOM}`, "")).toMatchObject(
    {
      text: "@Alice ",
    },
  );
});
