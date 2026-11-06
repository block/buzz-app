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
import { DraftsSentBadge } from "./DraftsSentNavigation";
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
  roster,
  signed,
} from "../relay/testing";
import { composerDOMFixture } from "../messages/composer-testing";
import { readView, writeView } from "../../shared/view-state";

// jsdom has no measured viewport. Keep real rows/composer/services, replacing
// only virtualization geometry; browser acceptance covers actual layout.
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
        scrollToIndex() {},
        scrollTo() {},
      }));
      return <div>{children}</div>;
    }),
  };
});
composerDOMFixture();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture(upload?: () => Promise<UploadedAttachment>) {
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
    relayKey = keypair();
  const root = message(other, "room", "Discuss launch", 20);
  const events: RelayEvent[] = [
    metadata(relayKey, "room", "Design", 10, [["t", "stream"]]),
    roster(relayKey, "room", [viewer.pubkey, other.pubkey], 10),
    metadata(relayKey, "other", "Planning", 10, [["t", "stream"]]),
    roster(relayKey, "other", [viewer.pubkey, other.pubkey], 10),
    root,
  ];
  let emit: (events: readonly RelayEvent[]) => void = () => {};
  let fail = false;
  let gate: Promise<void> | undefined;
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
        filters.flatMap((filter) => {
          const found = events.filter((event) => matchesEvent(event, filter));
          return filter.top_level && filter["#h"]?.[0]
            ? [
                ...found,
                bounds(relayKey, filter["#h"][0], "head", {
                  has_more: false,
                  next_cursor: null,
                }),
              ]
            : found;
        }),
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
    { outboxStorage: { load: () => [], save: () => {} } },
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
    seedSent: (thread: boolean) => {
      const sent = message(
        viewer,
        "room",
        "Already sent",
        25,
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
    root,
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

it("edits and sends from the real channel composer, then focuses a surviving row without opening it", async () => {
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
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Draft for #Design" }),
    ).toBeNull(),
  );
  expect(
    h.published.some((event) => event.content === "Ready for launch"),
  ).toBe(true);
  expect(mentionDraft(readView(h.session.scope, "draft:room", "")).text).toBe(
    "",
  );
  expect(draftButton("Next draft")).toHaveFocus();
  expect(screen.getByRole("status")).toHaveTextContent("Sent to #Design");
});

it("opens a verified thread draft with the real reply composer and origin action", async () => {
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
  fireEvent.click(within(region).getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(h.published.some((event) => event.content === "Thread draft")).toBe(
      true,
    ),
  );
  expect(
    h.published.find((event) => event.content === "Thread draft")?.tags,
  ).toContainEqual(["e", h.root.id, "", "reply"]);
});

it.each([false, true])(
  "keeps a rejected send with Retry and closes after retry succeeds (thread=%s)",
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
    expect(
      within(region).getByRole("button", { name: "Close draft preview" }),
    ).toBeEnabled();
    expect(
      within(region).getByRole("button", { name: "Open conversation" }),
    ).toBeEnabled();
    h.accept();
    fireEvent.click(retry);
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Draft for #Design" }),
      ).toBeNull(),
    );
    expect(h.published).toHaveLength(1);
  },
);

it("does not let a late send close a newer selected draft", async () => {
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
  expect(
    screen.getByRole("region", { name: "Draft for #Planning" }),
  ).toBeInTheDocument();
  expect(await screen.findByRole("textbox")).toHaveTextContent("Second draft");
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

it("does not close on delivery if the person has started a new draft in the same composer", async () => {
  const h = fixture();
  const release = h.hold();
  writeView(h.session.scope, "draft:room", "First message");
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
  expect(
    screen.getByRole("region", { name: "Draft for #Design" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveTextContent("New unsent thought");
});

it("waits for a background attachment send whose draft cleanup happens before delivery", async () => {
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
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Draft for #Design" }),
    ).toBeNull(),
  );
  expect(h.published).toHaveLength(1);
  expect(h.published[0]?.tags.some(([tag]) => tag === "imeta")).toBe(true);
});

it("does not steal search focus when delayed delivery closes the preview", async () => {
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
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Draft for #Design" }),
    ).toBeNull(),
  );
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
      session: h.session,
      host: h.host,
      autoFocus: false,
      onClose: vi.fn(),
      onOpen: vi.fn(),
      onSaved: vi.fn(),
    };
    const view = render(
      <DraftPreview {...props} channel={channel} loading={!channel} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading conversation",
    );
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

it("clears the live announcement between two sends to the same conversation", async () => {
  const h = fixture();
  h.render();
  for (const text of ["First", "Second"]) {
    act(() => writeView(h.session.scope, "draft:room", text));
    fireEvent.click(
      await screen.findByRole("button", {
        name: new RegExp(`Continue draft.*${text}`),
      }),
    );
    expect(screen.queryByText("Sent to #Design.")).toBeNull();
    await screen.findByRole("textbox");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Sent to #Design.");
  }
  expect(h.published).toHaveLength(2);
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
    expect(h.open).not.toHaveBeenCalled();
    expect(screen.getByLabelText("1 draft")).toBeInTheDocument();
    fireEvent.click(
      within(region).getByRole("button", { name: "Open conversation" }),
    );
    expect(h.open).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: sent.id }),
    );
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
