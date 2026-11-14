import { threadBinding } from "../relay/thread-window";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { DraftsSentBadge } from "./DraftsSentBadge";
import { DraftPreview } from "./DraftPreview";
import { MentionCompletion } from "../../bundled/mentions/MentionCompletion";
import { mentionQuery } from "../../bundled/mentions/mention-query";
import type { ConversationExtensions } from "../conversation/contracts";
import { DraftsSentPage } from "./DraftsSentPage";
import { PublishRejected } from "../relay/outbox";
import type { ComposerInputElement } from "../messages/composer-dom";
import { attachmentDraft } from "../messages/attachment-draft";
import type { UploadedAttachment } from "../relay/attachments";
import { mentionDraft } from "../messages/mention-draft";
import { createRelaySession } from "../relay/session";
import type { RelayData, RelaySnapshot } from "../relay/service";
import type { Navigation } from "../navigation/controller";
import type { Panels } from "../panels/service";
import type { RelayEvent } from "../relay/events";
import { matchesEvent } from "../relay/projection";
import {
  bounds,
  keypair,
  message,
  metadata,
  profile,
  roster,
  signed,
} from "../relay/testing";
import { composerDOMFixture, typedDraft } from "../messages/composer-testing";
import { readView, writeView } from "../../shared/view-state";
import { relayPartition } from "../relay/partition";
import { SOLO_LABEL } from "../solo/labels";
import type { LocalWork, LocalWorkState } from "../agents/local-activity";

// jsdom has no measured viewport. Keep real rows/composer/services, replacing
// only virtualization geometry; browser acceptance covers actual layout.
const virtua = vi.hoisted(() => ({ scrollToIndex: vi.fn() }));
vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    Virtualizer: forwardRef(function Virtualizer(
      { children }: { children: import("react").ReactNode },
      ref,
    ) {
      useImperativeHandle(ref, () => ({
        cache: undefined,
        scrollSize: 600,
        findItemIndex: () => 0,
        getItemOffset: () => 0,
        scrollToIndex: virtua.scrollToIndex,
        scrollTo() {},
      }));
      return <div data-virtual-list="">{children}</div>;
    }),
  };
});
// A Solo chat's saved model choices live in IndexedDB, which jsdom lacks.
vi.mock(
  "../messages/solo-model-picks-storage",
  () => import("../messages/solo-model-picks-storage-testing"),
);
composerDOMFixture();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "locks");
});
function fixture(
  upload?: () => Promise<UploadedAttachment>,
  {
    privateRoom = false,
    dm = [],
    solo = false,
  }: { privateRoom?: boolean; dm?: readonly string[]; solo?: boolean } = {},
) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const viewer = keypair(),
    other = keypair(),
    relayKey = keypair(),
    agent = keypair();
  const root = message(other, "room", "Discuss launch", 20);
  // The viewer's own Solo chat with one agent, whose local runs the test
  // reports; the follow-up queue's window lock needs `navigator.locks`.
  let work: readonly LocalWork[] = [];
  const workListeners = new Set<() => void>();
  const inventory = {
    status: "ready" as const,
    agents: [
      {
        pubkey: agent.pubkey,
        name: "Honey",
        relayUrl: "https://relay.test",
        owner: viewer.pubkey,
      },
    ],
  };
  if (solo)
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async (
          _name: string,
          options: unknown,
          callback?: (lock: unknown) => unknown,
        ) => (callback ? callback({}) : (options as () => unknown)()),
      },
    });
  // A DM with these people and a thread to reply in. Discovery orders
  // participants by key, so names follow key order: the page lists them so.
  const people = dm
    .map(() => keypair())
    .sort((a, b) => (a.pubkey < b.pubkey ? -1 : 1))
    .map((key, index) => ({ key, name: dm[index] }));
  const dmRoot = message(people[0]?.key ?? other, "dm", "Lunch plans?", 20);
  const events: RelayEvent[] = [
    ...(solo
      ? [
          metadata(relayKey, "solo", "Launch chat", 10, [
            ["t", "stream"],
            ["t", SOLO_LABEL],
            ["P", viewer.pubkey],
          ]),
          roster(relayKey, "solo", [viewer.pubkey, agent.pubkey], 10),
          profile(agent, { name: "Honey", is_agent: true }),
        ]
      : []),
    ...(people.length
      ? [
          metadata(relayKey, "dm", "dm", 10, [["t", "dm"]]),
          roster(
            relayKey,
            "dm",
            [viewer.pubkey, ...people.map((person) => person.key.pubkey)],
            10,
          ),
          ...people.map((person) => profile(person.key, { name: person.name })),
          dmRoot,
        ]
      : []),
    metadata(relayKey, "room", "Design", 10, [
      ["t", "stream"],
      ...(privateRoom ? [["private"]] : []),
    ]),
    roster(relayKey, "room", [viewer.pubkey, other.pubkey], 10),
    metadata(relayKey, "other", "Planning", 10, [["t", "stream"]]),
    roster(relayKey, "other", [viewer.pubkey, other.pubkey], 10),
    root,
  ];
  let emit: (events: readonly RelayEvent[]) => void = () => {};
  let fail = false;
  let gate: Promise<void> | undefined;
  let historyGate: Promise<void> | undefined;
  let historyStarted = () => {};
  const published: RelayEvent[] = [];
  const publish = vi.fn(async (event: RelayEvent) => {
    if (gate) await gate;
    if (fail) throw new PublishRejected("Send rejected");
    published.push(event);
    events.push(event);
    emit([event]);
  });
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relayKey.pubkey,
      scope: "https://relay.test",
      query: async (filters) =>
        (
          await Promise.all(
            filters.map(async (filter) => {
              if (
                historyGate &&
                (filter.top_level ||
                  filter.thread_window ||
                  filter["#e"]?.includes(root.id))
              ) {
                historyStarted();
                await historyGate;
              }
              const found = events.filter(
                (event) =>
                  matchesEvent(event, filter) &&
                  (filter.thread_cursor === undefined ||
                    event.created_at > filter.thread_cursor ||
                    (event.created_at === filter.thread_cursor &&
                      event.id > (filter.thread_cursor_id ?? ""))),
              );
              const channelId = filter["#h"]?.[0];
              const rootId = filter["#e"]?.[0];
              if (filter.thread_window && channelId && rootId)
                return [
                  ...found,
                  signed(relayKey, {
                    kind: 39007,
                    created_at: 30,
                    tags: [
                      [
                        "d",
                        await threadBinding(
                          filter,
                          "https://relay.test",
                          viewer.pubkey,
                        ),
                      ],
                      ["h", channelId],
                      ["e", rootId],
                    ],
                    content: JSON.stringify({
                      version: 1,
                      direction: "older",
                      has_more: false,
                      next_cursor: null,
                    }),
                  }),
                ];
              if (filter.top_level && channelId) {
                const ordered = found.sort(
                  (a, b) =>
                    b.created_at - a.created_at || a.id.localeCompare(b.id),
                );
                const rows = ordered.slice(0, filter.limit);
                const more = ordered.length > rows.length;
                const last = rows.at(-1);
                return [
                  ...rows,
                  bounds(
                    relayKey,
                    channelId,
                    filter.until !== undefined && filter.before_id
                      ? `${filter.until}:${filter.before_id}`
                      : "head",
                    {
                      has_more: more,
                      next_cursor:
                        more && last
                          ? { created_at: last.created_at, id: last.id }
                          : null,
                    },
                  ),
                ];
              }
              return found;
            }),
          )
        ).flat(),
      media: () => undefined,
      ...(upload ? { uploadAttachment: upload } : {}),
      writer: {
        kinds: [9, 9007, 40003, 5],
        sign: async (template) => signed(viewer, template),
        publish,
      },
      subscribe(callbacks) {
        callbacks.state({ status: "connected", routes: [] });
        emit = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      outboxStorage: { load: () => [], save: () => {} },
      ...(solo
        ? {
            agentChoices: {
              snapshot: () => inventory,
              subscribe: () => () => {},
              refresh: async () => {},
            },
            localAgents: {
              work: () => work,
              subscribeWork(listener: () => void) {
                workListeners.add(listener);
                return () => workListeners.delete(listener);
              },
            },
          }
        : {}),
    },
  );
  owners.push(owner);
  emit(events);
  const session = owner.session;
  const connection: RelaySnapshot = {
    status: "ready",
    generation: 1,
    scope: session.scope,
    viewer: viewer.pubkey,
    session,
  };
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
    retry() {},
    tryAgain() {},
    disconnect() {},
    clearCache: owner.clearCache,
  } as RelayData;
  const open = vi.fn<Navigation["open"]>(async () => ({ status: "opened" }));
  const empty: never[] = [];
  const panels = {
    snapshot: () => empty,
    subscribe: () => () => {},
    resolve: () => undefined,
  } as unknown as Panels;
  return {
    session,
    relay,
    holdHistory: () => {
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        historyStarted = resolve;
      });
      historyGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        started,
        release: () => {
          historyGate = undefined;
          release();
        },
      };
    },
    liveMessage: () => {
      const next = message(other, "room", "New live message", 1000000);
      events.push(next);
      emit([next]);
      return next;
    },
    seedHistory: (thread: boolean) => {
      const history = Array.from({ length: 150 }, (_, i) =>
        message(
          other,
          "room",
          `Later message ${i}`,
          100 + i * 3600,
          thread
            ? [
                ["e", root.id, "", "root"],
                ["e", root.id, "", "reply"],
              ]
            : [],
        ),
      );
      events.push(...history);
    },
    makeReadOnly: () => {
      const update = signed(relayKey, {
        kind: 39002,
        content: "",
        created_at: 200,
        tags: [
          ["d", "room"],
          ["p", viewer.pubkey, "", "guest"],
          ["p", other.pubkey],
        ],
      });
      events.push(update);
      emit([update]);
    },
    archive: () => {
      const update = metadata(relayKey, "room", "Design", 200, [
        ["t", "stream"],
        ["archived", "true"],
      ]);
      events.push(update);
      emit([update]);
    },
    seedSent: (
      thread: boolean,
      channelId = "room",
      text = "Already sent",
      createdAt = 25,
    ) => {
      const sent = message(
        viewer,
        channelId,
        text,
        createdAt,
        thread
          ? [
              ["e", root.id, "", "root"],
              ["e", root.id, "", "reply"],
            ]
          : [],
      );
      events.push(sent);
      emit([sent]);
      return sent;
    },
    panels,
    host: { panels, relay, navigation: { open } as unknown as Navigation },
    agent,
    /** Honey's run on an earlier Solo message, as the app's local agents report it. */
    agentWork: (state: LocalWorkState) => {
      work = [
        {
          scope: relayPartition("https://relay.test", viewer.pubkey),
          agent: agent.pubkey,
          channelId: "solo",
          messageId: "previous",
          threadRootId: "",
          soloChat: true,
          state,
          startedAt: 1,
        },
      ];
      for (const listener of workListeners) listener();
    },
    root,
    dmRoot,
    published,
    publish,
    open,
    render: (extensions?: ConversationExtensions) =>
      render(
        <DraftsSentPage
          relay={relay}
          navigator={{ open } as unknown as Navigation}
          panels={panels}
          extensions={extensions}
        />,
      ),
    reject: () => {
      fail = true;
    },
    accept: () => {
      fail = false;
    },
    hold: () => {
      let release = () => {};
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    revoke: () => {
      const update = roster(relayKey, "room", [other.pubkey], 100);
      events.push(update);
      emit([update]);
    },
  };
}
const draftButton = (text: string) =>
  screen.getByRole("button", { name: new RegExp(`Continue draft.*${text}`) });

it("sends from the real channel composer and stays on the conversation, then closes to a surviving row", async () => {
  const h = fixture();
  writeView(h.session.scope, "draft:room", "Ready for launch");
  writeView(h.session.scope, "draft:other", "Next draft");
  h.render();
  fireEvent.click(
    await screen.findByRole("button", {
      name: /Continue draft.*Ready for launch/,
    }),
  );
  const preview = screen.getByRole("region", { name: "Draft for #Design" });
  const editor = await within(preview).findByRole("textbox", {
    name: "Message #Design",
  });
  expect(editor).toHaveTextContent("Ready for launch");
  expect(h.open).not.toHaveBeenCalled();
  fireEvent.click(
    within(preview).getByRole("button", { name: "Send message" }),
  );
  await within(preview).findByText("Sent to #Design.");
  const sent = h.published.find(
    (event) => event.content === "Ready for launch",
  );
  await waitFor(() =>
    expect(
      preview.querySelector(`[data-message-id="${sent?.id}"]`),
    ).toBeInTheDocument(),
  );
  expect(mentionDraft(readView(h.session.scope, "draft:room", "")).text).toBe(
    "",
  );
  expect(editor).toHaveTextContent("");
  expect(editor).toHaveFocus();
  // The sent draft leaves the list; it does not linger as an empty one.
  expect(
    screen.queryByRole("button", { name: /Continue draft in #Design/ }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: /Continue draft.*Next draft/ }),
  ).not.toHaveAttribute("aria-current");
  expect(h.open).not.toHaveBeenCalled();
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(
    screen.queryByRole("region", { name: "Draft for #Design" }),
  ).toBeNull();
  expect(draftButton("Next draft")).toHaveFocus();
});

it("opens a verified thread draft with the real reply composer, its channel link and origin action, and shows the sent reply", async () => {
  const h = fixture();
  const key = `draft:room:thread:${h.root.id}`;
  writeView(h.session.scope, key, "Thread draft");
  h.render();
  fireEvent.click(
    await screen.findByRole("button", { name: /Continue draft.*Thread draft/ }),
  );
  const region = screen.getByRole("region", { name: "Draft for #Design" });
  const editor = await within(region).findByRole("textbox");
  await waitFor(() => expect(editor).toHaveTextContent("Thread draft"));
  fireEvent.click(
    within(region).getByRole("button", { name: "Open conversation" }),
  );
  expect(h.open).toHaveBeenCalledWith(
    expect.objectContaining({
      channelId: "room",
      threadRootId: h.root.id,
      messageId: h.root.id,
    }),
  );
  expect(h.open.mock.lastCall?.[0]).not.toHaveProperty("context");
  // Like other threads, it names its conversation; the name opens it there.
  const thread = within(region).getByRole("complementary", { name: "Thread" });
  const channel = within(thread).getByRole("button", { name: "#Design" });
  expect(channel.closest("p")).toHaveTextContent("In #Design");
  fireEvent.click(within(region).getByRole("button", { name: "Send message" }));
  await within(region).findByText("Sent to #Design.");
  const reply = h.published.find((event) => event.content === "Thread draft");
  expect(reply?.tags).toContainEqual(["e", h.root.id, "", "reply"]);
  await waitFor(() =>
    expect(
      thread.querySelector(`[data-message-id="${reply?.id}"]`),
    ).toBeInTheDocument(),
  );
  expect(editor).toHaveTextContent("");
  expect(editor).toHaveFocus();
  h.open.mockClear();
  fireEvent.click(within(thread).getByRole("button", { name: "#Design" }));
  expect(h.open).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "conversation",
      channelId: "room",
      threadRootId: h.root.id,
      messageId: h.root.id,
      context: "channel",
    }),
  );
  expect(region).toBeInTheDocument();
  // No row is left to return to.
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(
    screen.queryByRole("region", { name: "Draft for #Design" }),
  ).toBeNull();
  expect(screen.getByRole("searchbox")).toHaveFocus();
});

it("names a private channel's thread as thread tabs do", async () => {
  const h = fixture(undefined, { privateRoom: true });
  writeView(h.session.scope, `draft:room:thread:${h.root.id}`, "Quiet reply");
  h.render();
  fireEvent.click(
    await screen.findByRole("button", { name: /Continue draft.*Quiet reply/ }),
  );
  const region = screen.getByRole("region", { name: "Draft for Design" });
  const thread = await within(region).findByRole("complementary", {
    name: "Thread",
  });
  expect(
    within(thread).getByRole("button", { name: "#Design" }).closest("p"),
  ).toHaveTextContent("In #Design");
});

it("names a DM thread's people in its header and link as thread tabs do, while its row keeps the page's names", async () => {
  const h = fixture(undefined, { dm: ["Zed", "Amy", "Mia", "Bob"] });
  writeView(h.session.scope, `draft:dm:thread:${h.dmRoot.id}`, "Noon works");
  h.render();
  const row = await screen.findByRole("button", {
    name: "Continue draft in Zed, Amy, Mia +1, thread: Noon works",
  });
  fireEvent.click(row);
  const region = await screen.findByRole("region", {
    name: "Draft for Amy, Bob, Mia +1",
  });
  expect(within(region).getByText("Amy, Bob, Mia +1 · Thread")).toBeVisible();
  const thread = await within(region).findByRole("complementary", {
    name: "Thread",
  });
  const link = await within(thread).findByRole("button", {
    name: "DM · Amy, Bob, Mia +1",
  });
  expect(link.closest("p")).toHaveTextContent("In DM · Amy, Bob, Mia +1");
  expect(row).toHaveAccessibleName(
    "Continue draft in Zed, Amy, Mia +1, thread: Noon works",
  );
  fireEvent.click(link);
  expect(h.open).toHaveBeenLastCalledWith(
    expect.objectContaining({
      channelId: "dm",
      threadRootId: h.dmRoot.id,
      context: "channel",
    }),
  );
});

it.each([false, true])(
  "keeps a rejected send with Retry and stays open once retry succeeds (thread=%s)",
  async (thread) => {
    const h = fixture();
    h.reject();
    writeView(
      h.session.scope,
      thread ? `draft:room:thread:${h.root.id}` : "draft:room",
      "Keep this draft",
    );
    h.render();
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Continue draft.*Keep this draft/,
      }),
    );
    const region = screen.getByRole("region", { name: "Draft for #Design" });
    await within(region).findByRole("textbox");
    vi.useFakeTimers();
    fireEvent.click(
      within(region).getByRole("button", { name: "Send message" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_001);
    });
    vi.useRealTimers();
    expect(h.publish).toHaveBeenCalled();
    expect(
      screen.queryByRole("region", { name: "Draft for #Design" }),
    ).not.toBeNull();
    const retry = await within(region).findByRole("button", { name: "Retry" });
    expect(region).toBeInTheDocument();
    expect(region).toHaveTextContent("Keep this draft");
    expect(within(region).queryByText("Sent to #Design.")).toBeNull();
    expect(
      within(region).getByRole("button", { name: "Close draft preview" }),
    ).toBeEnabled();
    expect(
      within(region).getByRole("button", { name: "Open conversation" }),
    ).toBeEnabled();
    h.accept();
    fireEvent.click(retry);
    await within(region).findByText("Sent to #Design.");
    expect(region).toBeInTheDocument();
    expect(h.published).toHaveLength(1);
  },
);

it.each([false, true])(
  "retires a delivered draft once its failed cleanup is retried (thread=%s)",
  async (thread) => {
    const h = fixture();
    const key = thread ? `draft:room:thread:${h.root.id}` : "draft:room";
    writeView(h.session.scope, key, "Cleanup later");
    writeView(h.session.scope, "draft:other", "Other draft");
    h.render();
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Continue draft.*Cleanup later/,
      }),
    );
    const region = screen.getByRole("region", { name: "Draft for #Design" });
    const editor = await within(region).findByRole("textbox");
    await waitFor(() => expect(editor).toHaveTextContent("Cleanup later"));
    const stored = `buzz-view.v1:${JSON.stringify([h.session.scope, key])}`;
    const setItem = Storage.prototype.setItem;
    const fail = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, name, value) {
        if (name === stored) throw Error("no space");
        setItem.call(this, name, value);
      });
    try {
      fireEvent.click(
        within(region).getByRole("button", { name: "Send message" }),
      );
      await within(region).findByText("Sent to #Design.");
      // Delivered, but still saved: the draft keeps its row until cleanup.
      await within(region).findByRole("button", {
        name: "Retry draft cleanup",
      });
      expect(draftButton("Cleanup later")).toHaveAttribute(
        "aria-current",
        "true",
      );
    } finally {
      fail.mockRestore();
    }
    fireEvent.click(
      within(region).getByRole("button", { name: "Retry draft cleanup" }),
    );
    expect(mentionDraft(readView(h.session.scope, key, "")).text).toBe("");
    expect(
      screen.queryByRole("button", { name: /Continue draft.*Cleanup later/ }),
    ).toBeNull();
    expect(screen.queryByText("Empty draft")).toBeNull();
    expect(region).toBeInTheDocument();
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(draftButton("Other draft")).toHaveFocus();
  },
);

it("keeps the row of a draft written again whose background send is cleaned up before it lands", async () => {
  let release!: (value: UploadedAttachment) => void;
  const gate = new Promise<UploadedAttachment>((resolve) => {
    release = resolve;
  });
  const upload = vi.fn(() => gate);
  const h = fixture(upload);
  writeView(h.session.scope, "draft:room", "First");
  writeView(h.session.scope, "draft:other", "Other draft");
  h.render();
  fireEvent.click(
    await screen.findByRole("button", { name: /Continue draft.*First/ }),
  );
  const region = screen.getByRole("region", { name: "Draft for #Design" });
  const editor = (await within(region).findByRole(
    "textbox",
  )) as ComposerInputElement;
  fireEvent.click(within(region).getByRole("button", { name: "Send message" }));
  await within(region).findByText("Sent to #Design.");
  expect(mentionDraft(readView(h.session.scope, "draft:room", "")).text).toBe(
    "",
  );
  expect(
    screen.queryByRole("button", { name: /Continue draft in #Design/ }),
  ).toBeNull();
  await act(async () => h.session.channels.refreshList?.());
  act(() => {
    editor.value = "Again, with a file";
    fireEvent.input(editor);
  });
  expect(draftButton("Again, with a file")).toHaveAttribute(
    "aria-current",
    "true",
  );
  const store = attachmentDraft(
    h.session,
    `${h.session.scope}:draft:room`,
    "room",
  );
  act(() => {
    store.add([new File(["checklist"], "notes.txt", { type: "text/plain" })]);
  });
  await waitFor(() => expect(upload).toHaveBeenCalled());
  try {
    fireEvent.click(
      within(region).getByRole("button", { name: "Send message" }),
    );
    await waitFor(() =>
      expect(
        mentionDraft(readView(h.session.scope, "draft:room", "")).text,
      ).toBe(""),
    );
    // Cleaned up before its own receipt, the new draft still holds its place:
    // the earlier receipt does not retire it.
    expect(draftButton("Empty draft")).toHaveAttribute("aria-current", "true");
  } finally {
    await act(async () =>
      release({
        name: "notes.txt",
        url: `https://relay.test/media/${"a".repeat(64)}.txt`,
        type: "text/plain",
        size: 9,
        sha256: "a".repeat(64),
      }),
    );
  }
  await waitFor(() => expect(h.published).toHaveLength(2));
  await waitFor(() => expect(screen.queryByText("Empty draft")).toBeNull());
  expect(
    screen.queryByRole("button", { name: /Continue draft in #Design/ }),
  ).toBeNull();
});

it("keeps the row of a draft written before the last receipt whose background send is cleaned up before it lands", async () => {
  let release!: (value: UploadedAttachment) => void;
  const gate = new Promise<UploadedAttachment>((resolve) => {
    release = resolve;
  });
  const upload = vi.fn(() => gate);
  const h = fixture(upload);
  const deliver = h.hold();
  writeView(h.session.scope, "draft:room", "First");
  writeView(h.session.scope, "draft:other", "Other draft");
  h.render();
  fireEvent.click(
    await screen.findByRole("button", { name: /Continue draft.*First/ }),
  );
  const region = screen.getByRole("region", { name: "Draft for #Design" });
  const editor = (await within(region).findByRole(
    "textbox",
  )) as ComposerInputElement;
  try {
    fireEvent.click(
      within(region).getByRole("button", { name: "Send message" }),
    );
    await waitFor(() => expect(h.publish).toHaveBeenCalled());
    // Written while the first send is still out, the new draft owns the row
    // when that send's receipt lands.
    act(() => {
      editor.value = "Again, with a file";
      fireEvent.input(editor);
    });
  } finally {
    await act(async () => deliver());
  }
  await within(region).findByText("Sent to #Design.");
  expect(draftButton("Again, with a file")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await act(async () => h.session.channels.refreshList?.());
  const store = attachmentDraft(
    h.session,
    `${h.session.scope}:draft:room`,
    "room",
  );
  act(() => {
    store.add([new File(["checklist"], "notes.txt", { type: "text/plain" })]);
  });
  await waitFor(() => expect(upload).toHaveBeenCalled());
  try {
    fireEvent.click(
      within(region).getByRole("button", { name: "Send message" }),
    );
    await waitFor(() =>
      expect(
        mentionDraft(readView(h.session.scope, "draft:room", "")).text,
      ).toBe(""),
    );
    // Its cleanup precedes its own publication. The earlier receipt, never
    // recorded while this draft was listed, does not retire it now.
    expect(draftButton("Empty draft")).toHaveAttribute("aria-current", "true");
    expect(h.published).toHaveLength(1);
  } finally {
    await act(async () =>
      release({
        name: "notes.txt",
        url: `https://relay.test/media/${"a".repeat(64)}.txt`,
        type: "text/plain",
        size: 9,
        sha256: "a".repeat(64),
      }),
    );
  }
  await waitFor(() => expect(h.published).toHaveLength(2));
  await waitFor(() => expect(screen.queryByText("Empty draft")).toBeNull());
  expect(
    screen.queryByRole("button", { name: /Continue draft in #Design/ }),
  ).toBeNull();
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(draftButton("Other draft")).toHaveFocus();
});

it("retires a background attachment send whose failed cleanup is retried after it lands", async () => {
  let release!: (value: UploadedAttachment) => void;
  const gate = new Promise<UploadedAttachment>((resolve) => {
    release = resolve;
  });
  const upload = vi.fn(() => gate);
  const h = fixture(upload);
  writeView(h.session.scope, "draft:room", "Attached later");
  writeView(h.session.scope, "draft:other", "Other draft");
  h.render();
  fireEvent.click(
    await screen.findByRole("button", {
      name: /Continue draft.*Attached later/,
    }),
  );
  const region = screen.getByRole("region", { name: "Draft for #Design" });
  const editor = await within(region).findByRole("textbox");
  await act(async () => h.session.channels.refreshList?.());
  const store = attachmentDraft(
    h.session,
    `${h.session.scope}:draft:room`,
    "room",
  );
  act(() => {
    store.add([new File(["checklist"], "notes.txt", { type: "text/plain" })]);
  });
  await waitFor(() => expect(upload).toHaveBeenCalled());
  const stored = `buzz-view.v1:${JSON.stringify([h.session.scope, "draft:room"])}`;
  const setItem = Storage.prototype.setItem;
  const fail = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, name, value) {
      if (name === stored) throw Error("no space");
      setItem.call(this, name, value);
    });
  try {
    fireEvent.click(
      within(region).getByRole("button", { name: "Send message" }),
    );
    // Cleaned up before publication, and that cleanup failed.
    await within(region).findByRole("button", { name: "Retry draft cleanup" });
    expect(h.published).toHaveLength(0);
    await act(async () =>
      release({
        name: "notes.txt",
        url: `https://relay.test/media/${"a".repeat(64)}.txt`,
        type: "text/plain",
        size: 9,
        sha256: "a".repeat(64),
      }),
    );
    await within(region).findByText("Sent to #Design.");
    // Delivered, but still saved: the draft keeps its row until cleanup.
    expect(draftButton("Attached later")).toHaveAttribute(
      "aria-current",
      "true",
    );
  } finally {
    fail.mockRestore();
  }
  fireEvent.click(
    within(region).getByRole("button", { name: "Retry draft cleanup" }),
  );
  expect(mentionDraft(readView(h.session.scope, "draft:room", "")).text).toBe(
    "",
  );
  expect(
    screen.queryByRole("button", { name: /Continue draft.*Attached later/ }),
  ).toBeNull();
  expect(screen.queryByText("Empty draft")).toBeNull();
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(draftButton("Other draft")).toHaveFocus();
});

it("retires a queued Solo send whose failed cleanup is retried after the queue publishes it", async () => {
  localStorage.setItem("buzz-follow-up-behavior.v1", "queue");
  const h = fixture(undefined, { solo: true });
  h.agentWork("working");
  writeView(
    h.session.scope,
    "draft:solo",
    typedDraft(
      mentionDraft({
        text: "@Honey Follow up",
        recipients: [
          { pubkey: h.agent.pubkey, name: "Honey", start: 0, end: 6 },
        ],
      }),
    ),
  );
  writeView(h.session.scope, "draft:other", "Other draft");
  h.render();
  fireEvent.click(
    await screen.findByRole("button", { name: /Continue draft.*Follow up/ }),
  );
  const region = screen.getByRole("region", { name: "Draft for Launch chat" });
  const editor = await within(region).findByRole("textbox");
  await waitFor(() => expect(editor).toHaveTextContent("Follow up"));
  const stored = `buzz-view.v1:${JSON.stringify([h.session.scope, "draft:solo"])}`;
  const setItem = Storage.prototype.setItem;
  const fail = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, name, value) {
      if (name === stored) throw Error("no space");
      setItem.call(this, name, value);
    });
  try {
    fireEvent.click(
      within(region).getByRole("button", { name: "Send message" }),
    );
    // Queued behind Honey's current run, with its cleared draft unsaved.
    await within(region).findByRole("region", { name: "Queued follow-ups" });
    await within(region).findByRole("button", { name: "Retry draft cleanup" });
    expect(h.published).toHaveLength(0);
    // The queue reports the send it published once its delivery record is
    // written; the relay answers after that, as a real one does.
    const release = h.hold();
    act(() => h.agentWork("done"));
    await waitFor(() =>
      expect(
        within(region).queryByRole("region", { name: "Queued follow-ups" }),
      ).toBeNull(),
    );
    await act(async () => release());
    await within(region).findByText("Sent to Launch chat.");
    expect(h.published).toHaveLength(1);
    // Delivered, but still saved: the draft keeps its row until cleanup.
    expect(draftButton("Follow up")).toHaveAttribute("aria-current", "true");
  } finally {
    fail.mockRestore();
  }
  fireEvent.click(
    within(region).getByRole("button", { name: "Retry draft cleanup" }),
  );
  expect(mentionDraft(readView(h.session.scope, "draft:solo", "")).text).toBe(
    "",
  );
  expect(
    screen.queryByRole("button", { name: /Continue draft.*Follow up/ }),
  ).toBeNull();
  expect(screen.queryByText("Empty draft")).toBeNull();
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(draftButton("Other draft")).toHaveFocus();
});

it("does not let a late send report into a newer selected draft", async () => {
  const h = fixture();
  const release = h.hold();
  writeView(h.session.scope, "draft:room", "First draft");
  writeView(h.session.scope, "draft:other", "Second draft");
  h.render();
  try {
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Continue draft.*First draft/,
      }),
    );
    await screen.findByRole("textbox");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(h.publish).toHaveBeenCalled());
    fireEvent.click(draftButton("Second draft"));
  } finally {
    await act(async () => release());
  }
  await waitFor(() => expect(h.published).toHaveLength(1));
  const region = screen.getByRole("region", { name: "Draft for #Planning" });
  const editor = await within(region).findByRole("textbox");
  expect(editor).toHaveTextContent("Second draft");
  expect(screen.queryByText(/Sent to/)).toBeNull();
  expect(draftButton("Second draft")).toHaveAttribute("aria-current", "true");
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(draftButton("Second draft")).toHaveFocus();
});

it("keeps an emptied editor and filtered selection open, then closes on Escape with focus restored", async () => {
  const h = fixture();
  writeView(h.session.scope, "draft:room", "Erase me");
  h.render();
  const row = await screen.findByRole("button", {
    name: /Continue draft.*Erase me/,
  });
  fireEvent.click(row);
  const editor = await screen.findByRole("textbox");
  const user = userEvent.setup();
  await user.click(editor);
  act(() => {
    const input = editor as ComposerInputElement;
    input.value = "";
    fireEvent.input(input);
  });
  await waitFor(() =>
    expect(mentionDraft(readView(h.session.scope, "draft:room", "")).text).toBe(
      "",
    ),
  );
  expect(
    screen.getByRole("region", { name: "Draft for #Design" }),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "missing" },
  });
  expect(
    screen.getByRole("region", { name: "Draft for #Design" }),
  ).toBeInTheDocument();
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(
    screen.queryByRole("region", { name: "Draft for #Design" }),
  ).toBeNull();
  expect(screen.getByRole("searchbox")).toHaveFocus();
});

it("rechecks posting access, preserves the draft, and offers a text copy", async () => {
  const h = fixture();
  const copy = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: copy },
  });
  writeView(h.session.scope, "draft:room", "Saved after access changes");
  h.render();
  fireEvent.click(
    await screen.findByRole("button", { name: /Continue draft.*Saved after/ }),
  );
  await screen.findByRole("textbox");
  act(() => h.revoke());
  await screen.findByText(/Your draft is still saved/);
  expect(draftButton("Saved after access changes")).not.toHaveAttribute(
    "title",
  );
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Copy text" }));
  await waitFor(() =>
    expect(copy).toHaveBeenCalledWith("Saved after access changes"),
  );
});

it("clears an open draft once, retires its preview, and does not recreate it on unmount", async () => {
  const h = fixture();
  writeView(h.session.scope, "draft:room", "Clear the open draft");
  writeView(h.session.scope, "draft:other", "Keep this one");
  const mounted = h.render();
  fireEvent.click(
    await screen.findByRole("button", {
      name: /Continue draft.*Clear the open/,
    }),
  );
  await screen.findByRole("textbox");
  fireEvent.click(
    screen.getByRole("button", { name: /Clear draft.*Clear the open/ }),
  );
  expect(
    screen.queryByRole("region", { name: "Draft for #Design" }),
  ).toBeNull();
  expect(readView(h.session.scope, "draft:room", null)).toBeNull();
  expect(
    screen.getByRole("button", { name: /Clear draft.*Keep this one/ }),
  ).toHaveFocus();
  mounted.unmount();
  expect(readView(h.session.scope, "draft:room", null)).toBeNull();
});

it("respects a consumed Escape and closes the preview when switching to Sent", async () => {
  const h = fixture();
  writeView(h.session.scope, "draft:room", "Keyboard draft");
  h.render();
  fireEvent.click(
    await screen.findByRole("button", {
      name: /Continue draft.*Keyboard draft/,
    }),
  );
  const editor = await screen.findByRole("textbox");
  const consume = (event: KeyboardEvent) => event.preventDefault();
  editor.addEventListener("keydown", consume);
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(
    screen.getByRole("region", { name: "Draft for #Design" }),
  ).toBeInTheDocument();
  editor.removeEventListener("keydown", consume);
  fireEvent.click(screen.getByRole("tab", { name: "Sent" }));
  expect(
    screen.queryByRole("region", { name: "Draft for #Design" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: /^Drafts/ }));
  expect(
    screen.queryByRole("region", { name: "Draft for #Design" }),
  ).toBeNull();
  expect(draftButton("Keyboard draft")).toBeInTheDocument();
});

it("keeps the row of a new draft written before the last send is delivered", async () => {
  const h = fixture();
  const release = h.hold();
  writeView(h.session.scope, "draft:room", "First message");
  writeView(h.session.scope, "draft:other", "Other draft");
  h.render();
  try {
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Continue draft.*First message/,
      }),
    );
    const editor = (await screen.findByRole("textbox")) as ComposerInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(h.publish).toHaveBeenCalled());
    act(() => {
      editor.value = "New unsent thought";
      fireEvent.input(editor);
    });
    expect(mentionDraft(readView(h.session.scope, "draft:room", "")).text).toBe(
      "New unsent thought",
    );
  } finally {
    await act(async () => release());
  }
  await waitFor(() => expect(h.published).toHaveLength(1));
  const region = screen.getByRole("region", { name: "Draft for #Design" });
  await within(region).findByText("Sent to #Design.");
  const editor = within(region).getByRole("textbox");
  expect(editor).toHaveTextContent("New unsent thought");
  expect(draftButton("New unsent thought")).toHaveAttribute(
    "aria-current",
    "true",
  );
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(draftButton("New unsent thought")).toHaveFocus();
});

it("confirms a background attachment send whose draft cleanup happens before delivery only once it lands", async () => {
  let release!: (value: UploadedAttachment) => void;
  const gate = new Promise<UploadedAttachment>((resolve) => {
    release = resolve;
  });
  const upload = vi.fn(() => gate);
  const h = fixture(upload);
  writeView(h.session.scope, "draft:room", "Attached checklist");
  h.render();
  try {
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Continue draft.*Attached checklist/,
      }),
    );
    await screen.findByRole("textbox");
    await act(async () => h.session.channels.refreshList?.());
    const store = attachmentDraft(
      h.session,
      `${h.session.scope}:draft:room`,
      "room",
    );
    act(() => {
      store.add([new File(["checklist"], "notes.txt", { type: "text/plain" })]);
    });
    await waitFor(() => expect(upload).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(
        mentionDraft(readView(h.session.scope, "draft:room", "")).text,
      ).toBe(""),
    );
    expect(
      screen.getByRole("region", { name: "Draft for #Design" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Sent to #Design.")).toBeNull();
  } finally {
    await act(async () =>
      release({
        name: "notes.txt",
        url: `https://relay.test/media/${"a".repeat(64)}.txt`,
        type: "text/plain",
        size: 9,
        sha256: "a".repeat(64),
      }),
    );
  }
  await screen.findByText("Sent to #Design.");
  expect(
    screen.getByRole("region", { name: "Draft for #Design" }),
  ).toBeInTheDocument();
  expect(h.published).toHaveLength(1);
  expect(h.published[0]?.tags.some(([tag]) => tag === "imeta")).toBe(true);
});

it("does not steal search focus when a delayed delivery lands", async () => {
  const h = fixture();
  const release = h.hold();
  writeView(h.session.scope, "draft:room", "Delayed");
  h.render();
  const search = screen.getByRole("searchbox");
  try {
    fireEvent.click(
      await screen.findByRole("button", { name: /Continue draft.*Delayed/ }),
    );
    await screen.findByRole("textbox");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(h.publish).toHaveBeenCalled());
    search.focus();
  } finally {
    await act(async () => release());
  }
  await screen.findByText("Sent to #Design.");
  expect(
    screen.getByRole("region", { name: "Draft for #Design" }),
  ).toBeInTheDocument();
  expect(search).toHaveFocus();
});

it.each([{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }])(
  "keeps the preview open for modified/composing Escape %j",
  async (modifiers) => {
    const h = fixture();
    writeView(h.session.scope, "draft:room", "Keep typing");
    h.render();
    const row = await screen.findByRole("button", {
      name: /Continue draft.*Keep typing/,
    });
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-current", "true");
    const editor = await screen.findByRole("textbox");
    fireEvent.keyDown(editor, { key: "Escape", ...modifiers });
    expect(
      screen.getByRole("region", { name: "Draft for #Design" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(
      screen.queryByRole("region", { name: "Draft for #Design" }),
    ).toBeNull();
  },
);

it("dismisses mention suggestions without closing the draft preview", async () => {
  const h = fixture();
  const empty: never[] = [];
  const none = { snapshot: () => empty, subscribe: () => () => {} };
  const completions = [
    {
      id: "mentions",
      key: "buzz.mentions/mentions",
      pluginId: "buzz.mentions",
      revision: "1",
      title: "Mention",
      match: ({ text, start }: { text: string; start: number }) =>
        mentionQuery(text, start),
      component: MentionCompletion,
    },
  ];
  writeView(h.session.scope, "draft:room", "Hello");
  h.render({
    tools: none,
    inline: none,
    completions: { snapshot: () => completions, subscribe: () => () => {} },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: /Continue draft.*Hello/ }),
  );
  const editor = (await screen.findByRole("textbox")) as ComposerInputElement;
  act(() => {
    editor.focus();
    editor.value = "@";
    editor.setSelectionRange(1, 1);
    fireEvent.input(editor);
    fireEvent(document, new Event("selectionchange"));
  });
  await screen.findByRole("listbox");
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(
    screen.getByRole("region", { name: "Draft for #Design" }),
  ).toBeInTheDocument();
});

it.each([
  { id: "room", name: "Design", cached: true as const },
  { id: "room", name: "Design", pending: true as const },
  { id: "room", name: "Design" },
  undefined,
])(
  "shows loading instead of lost-access copy for unresolved channel %j",
  (channel) => {
    const h = fixture();
    const props = {
      entry: { id: "draft:room", channelId: "room", text: "Keep this" },
      title: "#Design",
      parentLabel: "#Design",
      session: h.session,
      host: h.host,
      autoFocus: false,
      onClose: vi.fn(),
      onOpen: vi.fn(),
      onOpenChannel: vi.fn(),
      onSent: vi.fn(),
    };
    const view = render(
      <DraftPreview {...props} channel={channel} loading={!channel} />,
    );
    expect(
      view.container.querySelector("[aria-busy=true]"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/can’t post/)).toBeNull();
    view.rerender(
      <DraftPreview
        {...props}
        channel={{ id: "room", name: "Design", members: [] }}
      />,
    );
    expect(screen.getByText(/can’t post/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy text" })).toBeEnabled();
  },
);

it("clears the live announcement between two sends from the same open preview", async () => {
  const h = fixture();
  writeView(h.session.scope, "draft:room", "First");
  h.render();
  fireEvent.click(
    await screen.findByRole("button", { name: /Continue draft.*First/ }),
  );
  const region = screen.getByRole("region", { name: "Draft for #Design" });
  const editor = (await within(region).findByRole(
    "textbox",
  )) as ComposerInputElement;
  expect(within(region).queryByText("Sent to #Design.")).toBeNull();
  fireEvent.click(within(region).getByRole("button", { name: "Send message" }));
  await within(region).findByText("Sent to #Design.");
  // Writing again brings the conversation's row back, still selected.
  act(() => {
    editor.value = "Second";
    fireEvent.input(editor);
  });
  expect(draftButton("Second")).toHaveAttribute("aria-current", "true");
  const release = h.hold();
  try {
    fireEvent.click(
      within(region).getByRole("button", { name: "Send message" }),
    );
    await waitFor(() => expect(h.publish).toHaveBeenCalledTimes(2));
    expect(within(region).queryByText("Sent to #Design.")).toBeNull();
  } finally {
    await act(async () => release());
  }
  await within(region).findByText("Sent to #Design.");
  expect(h.published.map((event) => event.content)).toEqual([
    "First",
    "Second",
  ]);
});

it.each([
  { control: "row", neighbor: true },
  { control: "clear button", neighbor: false },
])(
  "moves focus off the sent draft's $control as its row leaves (neighbor=$neighbor)",
  async ({ control, neighbor }) => {
    const h = fixture();
    const release = h.hold();
    writeView(h.session.scope, "draft:room", "Slow send");
    if (neighbor) writeView(h.session.scope, "draft:other", "Other draft");
    h.render();
    try {
      fireEvent.click(
        await screen.findByRole("button", {
          name: /Continue draft.*Slow send/,
        }),
      );
      const region = screen.getByRole("region", { name: "Draft for #Design" });
      await within(region).findByRole("textbox");
      fireEvent.click(
        within(region).getByRole("button", { name: "Send message" }),
      );
      await waitFor(() => expect(h.publish).toHaveBeenCalled());
      // Back in the list while the send is still on its way.
      (control === "row"
        ? draftButton("Empty draft")
        : screen.getByRole("button", {
            name: /Clear draft in #Design: Empty draft/,
          })
      ).focus();
    } finally {
      await act(async () => release());
    }
    await screen.findByText("Sent to #Design.");
    expect(
      screen.queryByRole("button", { name: /Continue draft in #Design/ }),
    ).toBeNull();
    expect(
      neighbor ? draftButton("Other draft") : screen.getByRole("searchbox"),
    ).toHaveFocus();
  },
);

it("closes to a draft written again after a send", async () => {
  const h = fixture();
  writeView(h.session.scope, "draft:room", "First");
  writeView(h.session.scope, "draft:other", "Other draft");
  h.render();
  fireEvent.click(
    await screen.findByRole("button", { name: /Continue draft.*First/ }),
  );
  const region = screen.getByRole("region", { name: "Draft for #Design" });
  const editor = (await within(region).findByRole(
    "textbox",
  )) as ComposerInputElement;
  fireEvent.click(within(region).getByRole("button", { name: "Send message" }));
  await within(region).findByText("Sent to #Design.");
  act(() => {
    editor.value = "Again";
    fireEvent.input(editor);
  });
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(draftButton("Again")).toHaveFocus();
});

it("holds a draft written after a send in place when emptied or its send is rejected", async () => {
  const h = fixture();
  writeView(h.session.scope, "draft:room", "First");
  writeView(h.session.scope, "draft:other", "Other draft");
  h.render();
  fireEvent.click(
    await screen.findByRole("button", { name: /Continue draft.*First/ }),
  );
  const region = screen.getByRole("region", { name: "Draft for #Design" });
  const editor = (await within(region).findByRole(
    "textbox",
  )) as ComposerInputElement;
  fireEvent.click(within(region).getByRole("button", { name: "Send message" }));
  await within(region).findByText("Sent to #Design.");
  expect(
    screen.queryByRole("button", { name: /Continue draft in #Design/ }),
  ).toBeNull();
  act(() => {
    editor.value = "Second";
    fireEvent.input(editor);
  });
  expect(draftButton("Second")).toHaveAttribute("aria-current", "true");
  act(() => {
    editor.value = "";
    fireEvent.input(editor);
  });
  // Emptied, it is any draft being edited: its row stays put.
  expect(draftButton("Empty draft")).toHaveAttribute("aria-current", "true");
  act(() => {
    editor.value = "Third";
    fireEvent.input(editor);
  });
  h.reject();
  vi.useFakeTimers();
  fireEvent.click(within(region).getByRole("button", { name: "Send message" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_001);
  });
  vi.useRealTimers();
  await within(region).findByRole("button", { name: "Retry" });
  expect(within(region).queryByText("Sent to #Design.")).toBeNull();
  expect(draftButton("Empty draft")).toHaveAttribute("aria-current", "true");
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(
    screen.queryByRole("region", { name: "Draft for #Design" }),
  ).toBeNull();
  expect(draftButton("Other draft")).toHaveFocus();
});

it.each([false, true])(
  "previews sent messages and shares one saved draft across tabs (thread=%s)",
  async (thread) => {
    const h = fixture();
    const sent = h.seedSent(thread);
    const key = thread ? `draft:room:thread:${h.root.id}` : "draft:room";
    writeView(h.session.scope, key, "Saved reply");
    h.render();
    render(<DraftsSentBadge relay={h.relay} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Continue draft.*Saved reply/,
      }),
    );
    let editor = (await screen.findByRole("textbox")) as ComposerInputElement;
    act(() => {
      editor.value = "Edited reply";
      fireEvent.input(editor);
    });
    fireEvent.click(screen.getByRole("tab", { name: "Sent" }));
    expect(
      screen.queryByRole("region", { name: "Draft for #Design" }),
    ).toBeNull();
    const row = await screen.findByRole("button", {
      name: /View message.*Already sent/,
    });
    fireEvent.click(row);
    const region = screen.getByRole("region", {
      name: "Sent message in #Design",
    });
    editor = (await within(region).findByRole(
      "textbox",
    )) as ComposerInputElement;
    await waitFor(() => expect(editor).toHaveTextContent("Edited reply"));
    await waitFor(() =>
      expect(
        region.querySelector(`[data-message-id="${sent.id}"]`),
      ).toBeInTheDocument(),
    );
    expect(within(region).queryByText("This thread didn’t load.")).toBeNull();
    expect(h.open).not.toHaveBeenCalled();
    expect(screen.getByLabelText("1 draft")).toBeInTheDocument();
    fireEvent.click(
      within(region).getByRole("button", { name: "Open conversation" }),
    );
    expect(h.open).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: sent.id }),
    );
    // A thread names its conversation; the name opens it there at the reply.
    const link = within(region).queryByRole("button", { name: "#Design" });
    expect(!!link).toBe(thread);
    if (link) {
      fireEvent.click(link);
      expect(h.open).toHaveBeenLastCalledWith(
        expect.objectContaining({
          channelId: "room",
          threadRootId: h.root.id,
          messageId: sent.id,
          context: "channel",
        }),
      );
    }
    fireEvent.click(
      within(region).getByRole("button", { name: "Send message" }),
    );
    await waitFor(() =>
      expect(
        h.published.some((event) => event.content === "Edited reply"),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.queryByLabelText("1 draft")).toBeNull());
    expect(region).toBeInTheDocument();
    // A reply from Sent was never a listed draft: nothing to announce.
    expect(within(region).queryByText(/Sent to/)).toBeNull();
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(
      screen.queryByRole("region", { name: "Sent message in #Design" }),
    ).toBeNull();
    expect(row).toHaveFocus();
    fireEvent.click(screen.getByRole("tab", { name: /^Drafts/ }));
    expect(screen.getByText("No drafts")).toBeInTheDocument();
  },
);

it("opens a cold sent channel preview with an empty composer and locates the message", async () => {
  const h = fixture();
  const sent = h.seedSent(false);
  h.render();
  fireEvent.click(screen.getByRole("tab", { name: "Sent" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /View message.*Already sent/ }),
  );
  const region = screen.getByRole("region", {
    name: "Sent message in #Design",
  });
  const editor = await within(region).findByRole("textbox");
  expect(editor).toHaveTextContent("");
  await waitFor(() =>
    expect(
      region.querySelector(`[data-message-id="${sent.id}"]`),
    ).toBeInTheDocument(),
  );
  expect(within(region).queryByText(/could not be found/)).toBeNull();
});

it("reveals a draft's send to a reader scrolled above the latest message", async () => {
  const h = fixture();
  h.seedHistory(false);
  writeView(h.session.scope, "draft:room", "Sent from above");
  h.render();
  fireEvent.click(
    await screen.findByRole("button", {
      name: /Continue draft.*Sent from above/,
    }),
  );
  const region = screen.getByRole("region", { name: "Draft for #Design" });
  const history = await within(region).findByRole("region", {
    name: "Channel message history",
  });
  await waitFor(() =>
    expect(history.querySelector("[data-message-id]")).not.toBeNull(),
  );
  // Read from the bottom, then scroll up, away from the latest message.
  let offset = 4400;
  Object.defineProperty(history, "scrollHeight", { get: () => 5000 });
  Object.defineProperty(history, "scrollTop", {
    get: () => offset,
    set: (next: number) => {
      offset = next;
    },
  });
  fireEvent.scroll(history);
  fireEvent.wheel(history, { deltaY: -600 });
  offset = 1000;
  fireEvent.scroll(history);
  virtua.scrollToIndex.mockClear();
  fireEvent.click(within(region).getByRole("button", { name: "Send message" }));
  await within(region).findByText("Sent to #Design.");
  const sent = h.published.find((event) => event.content === "Sent from above");
  const row = await waitFor(() => {
    const found = history.querySelector(`[data-message-id="${sent?.id}"]`);
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  const items = [
    ...(history.querySelector("[data-virtual-list]")?.children ?? []),
  ];
  const index = items.findIndex((item) => item.contains(row));
  expect(index).toBeGreaterThan(0);
  await waitFor(() =>
    expect(virtua.scrollToIndex).toHaveBeenCalledWith(
      index,
      expect.objectContaining({ align: "end" }),
    ),
  );
});

it("reveals and highlights an off-screen Sent reply in its visible preview", async () => {
  const h = fixture();
  const sent = h.seedSent(true);
  h.seedHistory(true);
  let scrolled = false;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const isTarget = this.dataset.messageId === sent.id;
      return new DOMRect(
        0,
        isTarget && !scrolled ? 2000 : 0,
        800,
        isTarget ? 100 : 600,
      );
    },
  );
  vi.mocked(HTMLElement.prototype.scrollIntoView).mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.dataset.messageId === sent.id) scrolled = true;
  });
  h.render();
  fireEvent.click(screen.getByRole("tab", { name: "Sent" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /View message.*Already sent/ }),
  );
  const region = screen.getByRole("region", {
    name: "Sent message in #Design",
  });
  await waitFor(() => expect(scrolled).toBe(true));
  await waitFor(() =>
    expect(
      region.querySelector(
        `[data-message-id="${sent.id}"] [class*="messageHighlight"], [data-message-id="${sent.id}"][class*="messageHighlight"]`,
      ),
    ).not.toBeNull(),
  );
});

it("returns an older Sent channel window to the head after replying", async () => {
  const h = fixture();
  const sent = h.seedSent(false);
  h.seedHistory(false);
  writeView(h.session.scope, "draft:room", "Reply from old history");
  h.render();
  fireEvent.click(screen.getByRole("tab", { name: "Sent" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /View message.*Already sent/ }),
  );
  const region = screen.getByRole("region", {
    name: "Sent message in #Design",
  });
  await waitFor(() => {
    expect(h.session.channels.window("room").hasNewer).toBe(true);
    expect(
      region.querySelector(`[data-message-id="${sent.id}"]`),
    ).not.toBeNull();
  });
  fireEvent.click(
    await within(region).findByRole("button", { name: "Send message" }),
  );
  await waitFor(() => expect(h.published).toHaveLength(1));
  const outgoing = h.published[0];
  if (!outgoing) throw new Error("Expected a published reply");
  await waitFor(() => {
    expect(h.session.channels.window("room").hasNewer).toBeFalsy();
    expect(
      region.querySelector(`[data-message-id="${outgoing.id}"]`),
    ).not.toBeNull();
  });
  await waitFor(() =>
    expect(
      vi
        .mocked(HTMLElement.prototype.scrollIntoView)
        .mock.contexts.some(
          (context) =>
            (context as HTMLElement).dataset.messageId === outgoing.id,
        ),
    ).toBe(true),
  );
});

it.each([false, true])(
  "keeps archived Sent context readable without a composer (thread=%s)",
  async (thread) => {
    const h = fixture();
    const sent = h.seedSent(thread);
    h.archive();
    h.render();
    fireEvent.click(screen.getByRole("tab", { name: "Sent" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /View message.*Already sent/ }),
    );
    const region = screen.getByRole("region", {
      name: "Sent message in #Design",
    });
    await waitFor(() =>
      expect(
        region.querySelector(`[data-message-id="${sent.id}"]`),
      ).not.toBeNull(),
    );
    expect(within(region).queryByRole("textbox")).toBeNull();
    expect(within(region).queryByText(/not available for replying/)).toBeNull();
    expect(
      within(region).getByText("This channel is archived"),
    ).toBeInTheDocument();
  },
);

it.each([false, true])(
  "keeps read-only Sent context readable (thread=%s)",
  async (thread) => {
    const h = fixture();
    const sent = h.seedSent(thread);
    h.makeReadOnly();
    h.render();
    fireEvent.click(screen.getByRole("tab", { name: "Sent" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /View message.*Already sent/ }),
    );
    const region = screen.getByRole("region", {
      name: "Sent message in #Design",
    });
    await waitFor(() =>
      expect(
        region.querySelector(`[data-message-id="${sent.id}"]`),
      ).not.toBeNull(),
    );
    expect(within(region).queryByRole("textbox")).toBeNull();
    expect(within(region).getByText("Read-only access")).toBeInTheDocument();
  },
);

it.each(["close", "selection", "tab"])(
  "restores live channel history when an old Sent preview exits via %s",
  async (exit) => {
    const h = fixture();
    h.seedSent(false);
    h.seedSent(false, "other", "Other sent message");
    h.seedHistory(false);
    h.render();
    fireEvent.click(screen.getByRole("tab", { name: "Sent" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /View message.*Already sent/ }),
    );
    await waitFor(() =>
      expect(h.session.channels.window("room").hasNewer).toBe(true),
    );
    if (exit === "close")
      fireEvent.click(
        screen.getByRole("button", { name: "Close sent preview" }),
      );
    else if (exit === "tab")
      fireEvent.click(screen.getByRole("tab", { name: /^Drafts/ }));
    else {
      fireEvent.click(
        await screen.findByRole("button", {
          name: /View message.*Other sent message/,
        }),
      );
    }
    await waitFor(() =>
      expect(h.session.channels.window("room").hasNewer).toBeFalsy(),
    );
    let next!: RelayEvent;
    act(() => {
      next = h.liveMessage();
    });
    await waitFor(() =>
      expect(
        h.session.channels
          .window("room")
          .rows.some((row) => row.id === next.id),
      ).toBe(true),
    );
  },
);

it.each([false, true])(
  "does not let an aborted seek detach history after unmount (thread=%s)",
  async (thread) => {
    const h = fixture();
    const sent = h.seedSent(thread);
    h.seedHistory(thread);
    await act(async () => h.session.channels.ensure("room"));
    const hold = h.holdHistory();
    const mounted = render(
      <DraftPreview
        entry={{
          id: sent.id,
          channelId: "room",
          text: sent.content,
          createdAt: sent.created_at,
          ...(thread ? { threadRootId: h.root.id } : {}),
        }}
        mode="sent"
        title="#Design"
        parentLabel="#Design"
        channel={h.session.channels.get?.("room")}
        session={h.session}
        host={h.host}
        autoFocus={false}
        onClose={() => {}}
        onOpen={() => {}}
        onOpenChannel={() => {}}
        onSent={() => {}}
      />,
    );
    try {
      await hold.started;
      mounted.unmount();
    } finally {
      await act(async () => hold.release());
    }
    expect(h.session.channels.window("room").hasNewer).toBeFalsy();
    let next!: RelayEvent;
    act(() => {
      next = h.liveMessage();
    });
    await waitFor(() =>
      expect(
        h.session.channels
          .window("room")
          .rows.some((row) => row.id === next.id),
      ).toBe(true),
    );
  },
);

it.each([
  { thread: false, touch: false, control: "search" },
  { thread: true, touch: false, control: "search" },
  { thread: false, touch: true, control: "search" },
  { thread: true, touch: true, control: "search" },
  { thread: false, touch: false, control: "composer" },
])(
  "preserves the chosen control focus during delayed Sent reveal %j",
  async ({ thread, touch, control }) => {
    const h = fixture();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 800, 600),
    );
    const sent = h.seedSent(thread);
    h.seedHistory(thread);
    await act(async () => h.session.channels.ensure("room"));
    h.render();
    fireEvent.click(screen.getByRole("tab", { name: "Sent" }));
    const row = await screen.findByRole("button", {
      name: /View message.*Already sent/,
    });
    const hold = h.holdHistory();
    try {
      const click = new MouseEvent("click", { bubbles: true });
      if (touch)
        Object.defineProperty(click, "pointerType", { value: "touch" });
      fireEvent(row, click);
      await hold.started;
      const focus =
        control === "search"
          ? screen.getByRole("searchbox")
          : await screen.findByRole("textbox");
      focus.focus();
    } finally {
      await act(async () => hold.release());
    }
    const region = screen.getByRole("region", {
      name: "Sent message in #Design",
    });
    await waitFor(() =>
      expect(
        region.querySelector(
          `[data-message-id="${sent.id}"] [class*="messageHighlight"], [data-message-id="${sent.id}"][class*="messageHighlight"]`,
        ),
      ).not.toBeNull(),
    );
    expect(
      screen.getByRole(control === "search" ? "searchbox" : "textbox"),
    ).toHaveFocus();
  },
);

it.each([
  { narrow: false, thread: false },
  { narrow: true, thread: false },
  { narrow: true, thread: true },
])(
  "hands Sent keyboard selection to a visible control %j",
  async ({ narrow, thread }) => {
    const h = fixture();
    const rects = HTMLElement.prototype.getClientRects;
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
      function (this: HTMLElement) {
        return narrow && this.getAttribute("aria-label") === "Back to sent"
          ? ([new DOMRect(0, 0, 32, 32)] as unknown as DOMRectList)
          : rects.call(this);
      },
    );
    h.seedSent(thread);
    h.seedHistory(thread);
    await act(async () => h.session.channels.ensure("room"));
    h.render();
    fireEvent.click(screen.getByRole("tab", { name: "Sent" }));
    const row = await screen.findByRole("button", {
      name: /View message.*Already sent/,
    });
    row.focus();
    fireEvent.click(row);
    const region = screen.getByRole("region", {
      name: "Sent message in #Design",
    });
    // Role queries are slow over a seeded thread; the labels are exact.
    const back = region.querySelector('[aria-label="Back to sent"]');
    await waitFor(() =>
      expect(region.querySelector('[role="textbox"]')).not.toBeNull(),
    );
    expect(narrow ? back : row).toHaveFocus();
  },
);

it("keeps a new upload in the composer when the previous text send is delivered", async () => {
  let finishUpload!: (value: UploadedAttachment) => void;
  const upload = vi.fn(
    () =>
      new Promise<UploadedAttachment>((resolve) => {
        finishUpload = resolve;
      }),
  );
  const h = fixture(upload);
  const deliver = h.hold();
  writeView(h.session.scope, "draft:room", "First text send");
  h.render();
  try {
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Continue draft.*First text send/,
      }),
    );
    await screen.findByRole("textbox");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(h.publish).toHaveBeenCalled());
    const store = attachmentDraft(
      h.session,
      `${h.session.scope}:draft:room`,
      "room",
    );
    act(() => {
      store.add([new File(["next"], "next.txt", { type: "text/plain" })]);
    });
    await waitFor(() => expect(upload).toHaveBeenCalled());
    await act(async () => deliver());
    await waitFor(() => expect(h.published).toHaveLength(1));
    const region = screen.getByRole("region", { name: "Draft for #Design" });
    await within(region).findByText("Sent to #Design.");
    expect(within(region).getByText("next.txt")).toBeInTheDocument();
    expect(store.snapshot()[0]?.status).toBe("uploading");
    expect(screen.getByRole("textbox")).toHaveTextContent("");
  } finally {
    await act(async () => {
      deliver();
      finishUpload?.({
        name: "next.txt",
        url: `https://relay.test/media/${"a".repeat(64)}.txt`,
        type: "text/plain",
        size: 4,
        sha256: "a".repeat(64),
      });
    });
  }
  expect(
    screen.getByRole("region", { name: "Draft for #Design" }),
  ).toBeInTheDocument();
});

it("can select another older Sent message in the same channel after restoring its reader", async () => {
  const h = fixture();
  h.seedSent(false);
  const second = h.seedSent(false, "room", "Second older message", 60);
  h.seedHistory(false);
  h.render();
  fireEvent.click(screen.getByRole("tab", { name: "Sent" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /View message.*Already sent/ }),
  );
  await waitFor(() =>
    expect(h.session.channels.window("room").hasNewer).toBe(true),
  );
  const hold = h.holdHistory();
  try {
    fireEvent.click(
      screen.getByRole("button", {
        name: /View message.*Second older message/,
      }),
    );
    expect(h.session.channels.window("room").refreshing).toBe(true);
    await hold.started;
  } finally {
    await act(async () => hold.release());
  }
  await waitFor(() =>
    expect(h.session.channels.window("room").refreshing).toBeFalsy(),
  );
  const region = screen.getByRole("region", {
    name: "Sent message in #Design",
  });
  await waitFor(() => {
    expect(
      region.querySelector(`[data-message-id="${second.id}"]`),
    ).not.toBeNull();
    expect(h.session.channels.window("room").hasNewer).toBe(true);
  });
});
