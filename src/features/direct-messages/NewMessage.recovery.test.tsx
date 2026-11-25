import type { ConversationHostServices } from "../conversation/ConversationHost";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ComposerInputElement } from "../messages/composer-dom";
import { composerDOMFixture } from "../messages/composer-testing";

import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
import { useChannelList } from "../relay/react";
import type { ChannelSummary } from "../relay/contracts";
import { createRelaySession } from "../relay/session";
import {
  keypair,
  profile,
  roster,
  signed,
  message,
  bounds,
} from "../relay/testing";
import {
  PublishRejected,
  type OutboxStorage,
  type OutgoingEvent,
} from "../relay/outbox";
import type { ReadFilter, RelayEvent } from "../relay/events";
import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerTool,
  ComposerCompletion,
  ConversationExtensions,
} from "../conversation/contracts";
import { MentionPicker } from "../../bundled/mentions/MentionPicker";
import { MentionCompletion } from "../../bundled/mentions/MentionCompletion";
import { mentionQuery } from "../../bundled/mentions/mention-query";
import { attachmentDraft } from "../messages/attachment-draft";
import { UPLOAD_FAILURES, UploadError } from "../relay/attachments";
import { NewMessage } from "./NewMessage";
import type { PageNavigation } from "../navigation/service";
import { OutboxStatus } from "../../bundled/channels/OutboxStatus";
import { useHiddenDms } from "../../bundled/channels/useHiddenDms";
import { createRelayProfiler } from "../relay/profiling";
import { readView, writeView } from "../../shared/view-state";

composerDOMFixture();

/** New message opens with To closed; click into it, then find Avery. */
async function option(name: string) {
  const to = await screen.findByRole("combobox", {
    name: "Message recipients",
  });
  await waitFor(() => expect(to).not.toBeDisabled());
  if (!screen.queryByRole("listbox")) act(() => to.focus());
  return screen.findByRole("option", { name });
}

const viewer = keypair(),
  other = keypair(),
  another = keypair(),
  third = keypair(),
  relay = keypair();
const channel = "11111111-1111-4111-8111-111111111111";
const group = "33333333-3333-4333-8333-333333333333";

const emptyPanels: never[] = [];
const scope = `https://relay.example:${viewer.pubkey}`;
const owners: ReturnType<typeof createRelaySession>[] = [];
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.parentElement;
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        // Supply row and viewport sizes; real scrolling is covered in browsers.
        queueMicrotask(() =>
          this.callback(
            [
              {
                target,
                contentRect: {
                  width: 400,
                  height: target.getAttribute("role") === "listbox" ? 400 : 40,
                },
              } as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          ),
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "Audio",
    class {
      pause = vi.fn();
      play() {
        return Promise.resolve();
      }
    },
  );
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});
function setup(
  metadata: { name?: string; about?: string; picture?: string } = {},
) {
  let records: readonly OutgoingEvent[] = [];
  const storage: OutboxStorage = {
    load: () => structuredClone(records),
    save: (next) => {
      records = structuredClone(next);
    },
  };
  const publish = vi.fn<
    (event: RelayEvent, signal: AbortSignal) => Promise<void>
  >(async () => {});
  const events = [
    profile(other, { name: "Avery", ...metadata }),
    profile(another, { name: "Zoe" }),
    // Relay-signed DM metadata carries the NIP-29 `hidden` and `private` tags.
    signed(relay, {
      kind: 39000,
      tags: [
        ["d", channel],
        ["hidden", ""],
        ["t", "dm"],
        ["private", ""],
      ],
      content: JSON.stringify({ name: "Avery", channel_type: "dm" }),
    }),
    roster(relay, channel, [viewer.pubkey, other.pubkey]),
  ];
  const query = vi.fn(async (filters: readonly ReadFilter[]) => {
    const history = filters.find((filter) => filter.kinds?.includes(9));
    if (history) {
      const id = history["#h"]?.[0] ?? channel;
      return [
        ...events.filter(
          (event) =>
            event.kind === 9 &&
            event.tags.some(([name, value]) => name === "h" && value === id),
        ),
        bounds(relay, id, "head", { has_more: false, next_cursor: null }),
      ];
    }
    return events.filter((event) =>
      filters.some(
        (filter) =>
          (!filter.kinds || filter.kinds.includes(event.kind)) &&
          (!filter.ids || filter.ids.includes(event.id)) &&
          (!filter.authors || filter.authors.includes(event.pubkey)) &&
          (!filter["#d"] ||
            event.tags.some(
              ([tag, value]) =>
                tag === "d" &&
                value !== undefined &&
                filter["#d"]?.includes(value),
            )),
      ),
    );
  });
  let rosterTime = 1_700_000_000;
  const openDirectMessage = vi.fn(
    async (pubkeys: readonly string[], ..._options: unknown[]) => {
      events[events.length - 1] = roster(
        relay,
        channel,
        [viewer.pubkey, ...pubkeys],
        ++rosterTime,
      );
      return channel;
    },
  );
  /** The viewer's own agents, which New Message offers. */
  const agents: { pubkey: string; name: string }[] = [];
  // Creating a channel needs a writer for 9007 that this relay double lacks, so
  // a started conversation is recorded and listed as pending, the way the real
  // start lists it; messages to its id then publish as usual.
  const startConversation = vi.fn<
    (
      id: string,
      title: string,
      members: readonly string[],
      ...rest: unknown[]
    ) => { create: Promise<void>; ready: Promise<void> }
  >(() => ({ create: Promise.resolve(), ready: Promise.resolve() }));
  const create = () => {
    const local = {
      status: "ready" as const,
      agents: agents.map((agent) => ({
        ...agent,
        relayUrl: "https://relay.example",
        owner: viewer.pubkey,
      })),
    };
    const owner = createRelaySession(
      {
        scope: "https://relay.example",
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        media: () => undefined,
        query,
        openDirectMessage,
        writer: {
          kinds: [9],
          sign: async (event) => signed(viewer, event),
          publish,
        },
      },
      {
        outboxStorage: storage,
        agentChoices: {
          snapshot: () => local,
          subscribe: () => () => {},
          refresh: async () => {},
        },
      },
    );
    owners.push(owner);
    // The page starts conversations through this stand-in; everything else is
    // the real session.
    const session = {
      ...owner.session,
      channelWrites: {
        available: true,
        start: (
          id: string,
          title: string,
          members: readonly string[],
          ...rest: unknown[]
        ) => {
          // The relay knows its roster once it has made the conversation. The
          // DM's roster stays last, which openDirectMessage rewrites.
          events.unshift(roster(relay, id, [viewer.pubkey, ...members]));
          owner.session.channels.start?.({
            id,
            name: title,
            members,
            labels: [],
            channelType: "stream",
          });
          return startConversation(id, title, members, ...rest);
        },
      },
    } as unknown as typeof owner.session;
    return { ...owner, session };
  };
  const onStarted = vi.fn();
  const onOpenChat = vi.fn();
  function Draft({
    owner,
    extensions,
    visit,
    known,
  }: {
    owner: ReturnType<typeof create>;
    extensions?: ConversationExtensions | undefined;
    visit?: PageNavigation | undefined;
    /** The channels this page knows, instead of the session's list. */
    known?: readonly ChannelSummary[] | undefined;
  }) {
    const { channels } = useChannelList(owner.session.channels);
    return (
      <NewMessage
        session={owner.session}
        channels={known ?? channels}
        onOpenChat={onOpenChat}
        scope={scope}
        host={
          {
            panels: {
              snapshot: () => emptyPanels,
              subscribe: () => () => {},
              resolve: () => undefined,
            },
            relay: {
              snapshot: () => ({
                status: "ready",
                session: owner.session,
                scope,
              }),
            },
            navigation: { open: vi.fn() },
          } as unknown as ConversationHostServices
        }
        onOpenThread={vi.fn()}
        onStarted={onStarted}
        extensions={extensions}
        visit={visit}
      />
    );
  }
  const mount = (
    owner: ReturnType<typeof create>,
    extensions?: ConversationExtensions,
    visit?: PageNavigation,
    known?: readonly ChannelSummary[],
  ) =>
    render(
      <Draft
        owner={owner}
        extensions={extensions}
        visit={visit}
        known={known}
      />,
    );
  const user = userEvent.setup();
  const compose = async () => {
    await user.click(await option("Avery"));
    await user.type(composer(), "Durable first message");
  };
  return {
    agents,
    storage,
    query,
    events,
    openDirectMessage,
    startConversation,
    publish,
    create,
    mount,
    compose,
    user,
    onStarted,
    onOpenChat,
    records: () => records,
  };
}
const send = () => screen.getByRole("button", { name: "Send message" });
/** The message composer, not the optional Name field above To. */
const composer = () =>
  screen.getByRole("textbox", { name: (name) => name !== "Name" });

it("restores a bounded recipient and draft when unused profile metadata exceeds the view quota", async () => {
  const name = "A".repeat(600);
  const t = setup({
    name,
    about: "x".repeat(2 * 1024 * 1024),
    picture: `https://example.com/${"x".repeat(20000)}`,
  });
  const setItem = Storage.prototype.setItem;
  const rejected = vi.fn();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    if (value.length > 16000) {
      rejected();
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    }
    setItem.call(this, key, value);
  });
  const owner = t.create();
  const page = t.mount(owner);
  await t.user.click(await option(name));
  await t.user.type(composer(), "Saved before sending");
  expect(readView(scope, "direct-message:recipients", [])).toEqual([
    { pubkey: other.pubkey, name: name.slice(0, 500) },
  ]);
  expect(rejected).not.toHaveBeenCalled();
  page.unmount();
  t.mount(owner);
  await waitFor(() => expect(send()).toBeEnabled());
  expect(
    screen.getByRole("button", {
      name: `Remove ${name.slice(0, 500)}`,
    }),
  ).toBeEnabled();
  expect(composer()).toHaveTextContent("Saved before sending");
  expect(t.openDirectMessage).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
});

it("locks recipient edits until outbox hydration finishes, then accepts them", async () => {
  const t = setup();
  writeView(scope, "direct-message:recipients", [
    { pubkey: other.pubkey, name: "Avery" },
  ]);
  let release: (records: readonly OutgoingEvent[]) => void = () => {};
  const hydration = new Promise<readonly OutgoingEvent[]>((resolve) => {
    release = resolve;
  });
  t.storage.load = vi.fn(() => hydration);
  const play = vi.fn(async () => {});
  vi.stubGlobal(
    "Audio",
    class {
      pause = vi.fn();
      play = play;
    },
  );
  const owner = t.create();
  // Populate the actual directory before mounting so loading people cannot hide
  // a prematurely enabled picker while the outbox is held.
  await owner.session.directMessages.people(
    "",
    1,
    new AbortController().signal,
  );
  t.mount(owner);
  try {
    expect(t.storage.load).toHaveBeenCalledOnce();
    const input = screen.getByRole("combobox");
    const remove = screen.getByRole("button", { name: "Remove Avery" });
    expect(input).toBeDisabled();
    expect(remove).toBeDisabled();
    await t.user.click(remove);
    await t.user.type(input, "Zoe{Enter}");
    expect(remove).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove Zoe" }),
    ).not.toBeInTheDocument();
    expect(play).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      release([]);
      await owner.session.outbox?.ready();
    });
  }
  await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
  // To unlocks closed; the caret stays out of it.
  expect(screen.getByRole("combobox")).not.toHaveFocus();
  await t.user.click(screen.getByRole("button", { name: "Remove Avery" }));
  expect(
    screen.queryByRole("button", { name: "Remove Avery" }),
  ).not.toBeInTheDocument();
  expect(play).toHaveBeenCalledOnce();
  await t.user.click(await option("Zoe"));
  expect(screen.getByRole("button", { name: "Remove Zoe" })).toBeEnabled();
  expect(t.openDirectMessage).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
});

it("recovers an uncertain first send after localStorage failure and session restart without a new event", async () => {
  const t = setup();
  t.publish.mockRejectedValueOnce(new Error("Receipt lost"));
  const first = t.create();
  const page = t.mount(first);
  await t.compose();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Quota exceeded");
  });
  await t.user.click(send());
  await screen.findByRole("alert");
  await waitFor(() =>
    expect(t.records().find((item) => item.recovery)?.delivery).toBe("unknown"),
  );
  const original = t.publish.mock.calls[0]?.[0];
  assert.exists(original);
  page.unmount();
  first.dispose();
  const second = t.create();
  const resumed = t.mount(second);
  await waitFor(() => expect(send()).toBeEnabled());
  expect(composer()).toHaveTextContent("Durable first message");
  expect(screen.getByRole("button", { name: "Remove Avery" })).toBeDisabled();
  await t.user.click(screen.getByRole("button", { name: "Retry send" }));
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.publish).toHaveBeenCalledTimes(2);
  expect(t.publish.mock.calls[1]?.[0]).toEqual(original);
  expect(t.records().some((item) => item.recovery)).toBe(false);
  resumed.unmount();
  second.dispose();
  const restored = t.create();
  t.mount(restored);
  await act(async () => {
    await restored.session.outbox?.ready();
  });
  await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
  expect(composer()).toHaveProperty("value", "");
  expect(
    screen.queryByRole("button", { name: "Remove Avery" }),
  ).not.toBeInTheDocument();
  expect(send()).toBeDisabled();
});

it("removing a failed operation in Diagnostics unlocks the preserved draft on reopening", async () => {
  const t = setup();
  t.publish.mockRejectedValueOnce(new PublishRejected("Not sent"));
  const owner = t.create();
  const outbox = owner.session.outbox;
  assert.exists(outbox);
  const page = t.mount(owner);
  await t.compose();
  await t.user.click(send());
  await screen.findByRole("alert");
  await waitFor(() => expect(outbox.snapshot()[0]?.delivery).toBe("failed"));
  page.unmount();
  const diagnostics = render(
    <OutboxStatus
      outbox={outbox}
      profiling={createRelayProfiler()}
      memberAdditions={owner.session.memberAdditions}
    />,
  );
  await t.user.click(
    screen.getByRole("button", { name: "Remove from outbox" }),
  );
  await waitFor(() =>
    expect(t.records().some((item) => item.recovery)).toBe(false),
  );
  diagnostics.unmount();
  t.mount(owner);
  await waitFor(() => expect(send()).toBeEnabled());
  expect(composer()).toHaveTextContent("Durable first message");
  expect(screen.getByRole("button", { name: "Remove Avery" })).toBeEnabled();
  await t.user.click(send());
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.publish).toHaveBeenCalledTimes(2);
});

it("keeps a failed message in Back history when only the outbox holds it", async () => {
  const t = setup();
  t.publish.mockRejectedValueOnce(new PublishRejected("Not sent"));
  const owner = t.create();
  const outbox = owner.session.outbox;
  assert.exists(outbox);
  const page = t.mount(owner);
  await t.compose();
  await t.user.click(send());
  await screen.findByRole("alert");
  await waitFor(() => expect(outbox.snapshot()[0]?.delivery).toBe("failed"));
  page.unmount();
  // The disposable draft view is gone; the durable outbox entry remains.
  writeView(scope, "direct-message:new-draft", null);
  const passThrough = vi.fn<PageNavigation["passThrough"]>(() => () => {});
  t.mount(owner, undefined, { passThrough } as unknown as PageNavigation);
  await waitFor(() =>
    expect(composer()).toHaveTextContent("Durable first message"),
  );
  expect(passThrough.mock.lastCall?.[0]()).toBe(false);
});

it("never publishes if the durable recovery write fails", async () => {
  const t = setup();
  t.storage.save = async () => {
    throw new Error("Disk full");
  };
  const owner = t.create();
  t.mount(owner);
  await t.compose();
  await t.user.click(send());
  await screen.findByRole("alert");
  expect(t.publish).not.toHaveBeenCalled();
  expect(composer()).toHaveTextContent("Durable first message");
});

it.each([false, true])(
  "preserves post-failure edits across restart, empty=%s",
  async (empty) => {
    const t = setup();
    t.publish.mockRejectedValueOnce(new PublishRejected("Not sent"));
    const owner = t.create();
    const page = t.mount(owner);
    await t.compose();
    await t.user.click(send());
    await screen.findByRole("alert");
    await t.user.clear(composer());
    if (!empty) await t.user.type(composer(), "Corrected message");
    await t.user.click(screen.getByRole("button", { name: "Remove Avery" }));
    if (!empty) await t.user.click(await option("Zoe"));
    page.unmount();
    owner.dispose();
    const restored = t.create();
    t.mount(restored);
    await act(async () => {
      await restored.session.outbox?.ready();
    });
    await waitFor(() =>
      expect(composer()).toHaveProperty(
        "value",
        empty ? "" : "Corrected message",
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Remove Avery" }),
    ).not.toBeInTheDocument();
    if (empty) expect(send()).toBeDisabled();
    else {
      expect(screen.getByRole("button", { name: "Remove Zoe" })).toBeVisible();
      await t.user.click(send());
      await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
      expect(t.publish.mock.calls[1]?.[0].content).toBe("Corrected message");
    }
  },
);

it("retains recovery if saved-view cleanup fails, then retires without republishing", async () => {
  const t = setup();
  const owner = t.create();
  const page = t.mount(owner);
  await t.compose();
  const remove = vi
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
  await t.user.click(send());
  await screen.findByRole("alert");
  expect(t.records().some((item) => item.recovery)).toBe(true);
  page.unmount();
  const resumed = t.mount(owner);
  await screen.findByRole("button", { name: "Retry send" });
  remove.mockRestore();
  await t.user.click(screen.getByRole("button", { name: "Retry send" }));
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.publish).toHaveBeenCalledOnce();
  resumed.unmount();
  t.mount(owner);
  await waitFor(() => expect(composer()).toHaveProperty("value", ""));
  expect(send()).toBeDisabled();
});

it("reconciles a remount while acknowledgement is held without reviving the delivered draft", async () => {
  const t = setup();
  const save = t.storage.save;
  let release: () => void = () => {};
  let held = false;
  t.storage.save = async (records) => {
    if (
      !held &&
      records.some((item) => item.delivery === "accepted" && !item.recovery)
    ) {
      held = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    await save(records);
  };
  const owner = t.create();
  const page = t.mount(owner);
  await t.compose();
  await t.user.click(send());
  await waitFor(() => expect(held).toBe(true));
  page.unmount();
  const resumed = t.mount(owner);
  try {
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Remove Avery" }),
      ).toBeDisabled(),
    );
    expect(composer()).toHaveTextContent("Durable first message");
  } finally {
    release();
  }
  await waitFor(() =>
    expect(t.records().some((item) => item.recovery)).toBe(false),
  );
  await waitFor(() => expect(composer()).toHaveProperty("value", ""));
  expect(
    screen.queryByRole("button", { name: "Remove Avery" }),
  ).not.toBeInTheDocument();
  expect(send()).toBeDisabled();
  expect(t.onStarted).not.toHaveBeenCalled();
  expect(t.publish).toHaveBeenCalledOnce();
  resumed.unmount();
  owner.dispose();
  const restored = t.create();
  t.mount(restored);
  await act(async () => {
    await restored.session.outbox?.ready();
  });
  await waitFor(() => expect(composer()).toHaveProperty("value", ""));
  expect(send()).toBeDisabled();
});

const tools: readonly Contribution<ComposerTool>[] = [
  {
    id: "picker",
    key: "mentions/picker",
    pluginId: "mentions",
    revision: "1",
    title: "Mentions",
    component: ({ insertMention, ...props }) => (
      <MentionPicker {...props} select={insertMention} />
    ),
  },
];
const completions: readonly Contribution<ComposerCompletion>[] = [
  {
    id: "typeahead",
    key: "mentions/typeahead",
    pluginId: "mentions",
    revision: "1",
    title: "Mention",
    match: ({ text, start }) => mentionQuery(text, start),
    component: MentionCompletion,
  },
];
const noSubscribe = () => () => {};
const extensions: ConversationExtensions = {
  tools: { snapshot: () => tools, subscribe: noSubscribe },
  completions: { snapshot: () => completions, subscribe: noSubscribe },
  inline: { snapshot: () => [], subscribe: noSubscribe },
};

it.each(["picker", "completion"])(
  "offers selected recipients through %s and validates removed mentions on first send",
  async (path) => {
    const t = setup();
    const owner = t.create();
    t.mount(owner, extensions);
    await t.user.click(await option("Avery"));
    await t.user.type(
      screen.getByRole("combobox", { name: "Message recipients" }),
      "Zoe",
    );
    await t.user.click(await option("Zoe"));
    const composer = () =>
      screen.getByRole<ComposerInputElement>("textbox", {
        name: "Start a new conversation",
      });
    const choices = async () => {
      if (path === "picker") {
        await t.user.click(
          screen.getByRole("button", { name: "Mention a member" }),
        );
        return within(
          screen.getByRole("dialog", { name: "Mention a member or agent" }),
        );
      }
      // jsdom has no caret hit testing; append after the existing mention.
      act(() => {
        const input = composer();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
      await t.user.keyboard("@");
      return within(
        await screen.findByRole("listbox", { name: "Mention suggestions" }),
      );
    };
    const choiceRole = path === "picker" ? "button" : "option";
    const first = await choices();
    expect(
      first.getByRole(choiceRole, {
        name: /^Avery/,
      }),
    ).toBeVisible();
    await t.user.click(
      first.getByRole(choiceRole, {
        name: /^Zoe/,
      }),
    );
    expect(composer()).toHaveTextContent("@Zoe");
    expect(t.openDirectMessage).not.toHaveBeenCalled();
    expect(t.publish).not.toHaveBeenCalled();
    // The provisional names are sufficient without warming the global profile cache.
    expect(owner.session.profiles.snapshot().size).toBe(0);
    await t.user.click(screen.getByRole("button", { name: "Remove Zoe" }));
    const second = await choices();
    expect(
      second.getByRole(choiceRole, {
        name: /^Avery/,
      }),
    ).toBeVisible();
    expect(
      second.queryByRole(choiceRole, { name: /^Zoe/ }),
    ).not.toBeInTheDocument();
    // Dismiss the suggestions without replacing the existing mention in jsdom.
    await t.user.keyboard("{Escape}");
    expect(composer()).toHaveTextContent("@Zoe");
    expect(t.openDirectMessage).not.toHaveBeenCalled();
    await t.user.click(send());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "no longer a channel member",
    );
    expect(t.publish).not.toHaveBeenCalled();
    expect(composer()).toHaveTextContent("@Zoe");
    await t.user.clear(composer());
    const last = await choices();
    await t.user.click(
      last.getByRole(choiceRole, {
        name: /^Avery/,
      }),
    );
    await t.user.click(send());
    await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
    const sent = t.publish.mock.calls[0]?.[0];
    expect(sent?.content).toBe("@Avery");
    expect(sent?.tags.filter(([name]) => name === "p")).toEqual([
      ["p", other.pubkey],
    ]);
  },
);

it.each(["", "Please review these fixes"])(
  "sends a staged session with caption %j and restores its exact event after receipt loss",
  async (caption) => {
    const t = setup();
    const link = "[Session: Fix](buzz://channel/session-id)";
    writeView(scope, "direct-message:new-draft", {
      text: caption,
      recipients: [],
      chatCards: [link],
    });
    t.publish.mockRejectedValueOnce(new Error("Receipt lost"));
    const first = t.create();
    const page = t.mount(first);
    await t.user.click(await option("Avery"));
    await waitFor(() => expect(send()).toBeEnabled());
    await t.user.click(send());
    await waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
    const original = t.publish.mock.calls[0]?.[0];
    assert.exists(original);
    expect(original.content).toBe([link, caption].filter(Boolean).join("\n\n"));
    await waitFor(() =>
      expect(t.records().find((item) => item.recovery)?.delivery).toBe(
        "unknown",
      ),
    );
    page.unmount();
    first.dispose();
    const second = t.create();
    t.mount(second);
    const retry = await screen.findByRole("button", { name: "Retry send" });
    expect(
      screen.queryByRole("region", { name: "Chat attachments" }),
    ).toBeNull();
    expect(composer()).toHaveTextContent("Fix");
    if (caption) expect(composer()).toHaveTextContent(caption);
    await t.user.click(retry);
    await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
    expect(t.publish).toHaveBeenCalledTimes(2);
    expect(t.publish.mock.calls[1]?.[0]).toEqual(original);
    expect(t.records().some((item) => item.recovery)).toBe(false);
    expect(readView(scope, "direct-message:new-draft", null)).toBeNull();
  },
);

it("retries an unchanged failed DM saved with legacy chat attachments", async () => {
  const t = setup();
  const link = "[Session: Fix](buzz://channel/session-id)";
  const text = "Please review these fixes";
  const event = message(viewer, channel, `${link}\n\n${text}`, 1_700_000_001);
  await t.storage.save([
    {
      event,
      signed: event,
      delivery: "failed",
      error: "Not sent",
      recovery: {
        key: "direct-message:new",
        value: JSON.stringify({
          people: [{ pubkey: other.pubkey, name: "Avery" }],
          draft: { text, recipients: [], chatCards: [link] },
        }),
      },
    },
  ]);
  t.mount(t.create());
  await waitFor(() => expect(send()).toBeEnabled());
  expect(composer()).toHaveTextContent("Session: Fix");
  expect(composer()).toHaveTextContent(text);
  await t.user.click(send());
  await waitFor(() =>
    expect(t.onStarted).toHaveBeenCalledWith(channel, event.id),
  );
  expect(t.openDirectMessage).not.toHaveBeenCalled();
  expect(t.publish).toHaveBeenCalledOnce();
  expect(t.publish.mock.calls[0]?.[0]).toEqual(event);
});

/** The "Direct message" row under the picked people. */
const directRow = () => screen.getByRole("button", { name: /^Direct message/ });
/** The row has a DM to open once it stops being a toggle. */
const knowsDm = () =>
  waitFor(() => expect(directRow()).not.toHaveAttribute("aria-pressed"));
/** The row is a toggle: these people have no DM this page knows. */
const knowsNoDm = () =>
  waitFor(() => expect(directRow()).toHaveAttribute("aria-pressed"));
const sentTo = (t: ReturnType<typeof setup>) =>
  t.publish.mock.calls.map(
    ([event]) => event.tags.find(([name]) => name === "h")?.[1],
  );

it("lists the DM of these people as a row, without its history, and keeps the draft while recipients change", async () => {
  const t = setup();
  t.events.unshift(
    message(other, channel, "Earlier conversation", 1_700_000_001),
  );
  const owner = t.create();
  t.mount(owner);
  await t.user.click(await option("Avery"));
  await knowsDm();
  expect(
    screen.queryByRole("region", { name: "Channel message history" }),
  ).not.toBeInTheDocument();
  expect(t.openDirectMessage).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
  await t.user.type(composer(), "Keep this draft");
  await addRecipient(t, "Zoe");
  // Avery and Zoe have no DM together.
  await knowsNoDm();
  expect(composer()).toHaveTextContent("Keep this draft");
  await t.user.click(screen.getByRole("button", { name: "Remove Zoe" }));
  await knowsDm();
  expect(composer()).toHaveTextContent("Keep this draft");
  await t.user.click(directRow());
  expect(t.onOpenChat).toHaveBeenCalledExactlyOnceWith(channel);
  expect(t.openDirectMessage).not.toHaveBeenCalled();
  expect(t.startConversation).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
});

it("starts a conversation by default, even when these people have a DM, and never opens the DM", async () => {
  const t = setup();
  t.events.unshift(
    message(other, channel, "Earlier conversation", 1_700_000_001),
  );
  t.mount(t.create());
  await t.compose();
  await knowsDm();
  await t.user.click(send());
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.openDirectMessage).not.toHaveBeenCalled();
  expect(t.startConversation).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(/^[0-9a-f-]{36}$/),
    "Durable first message",
    [other.pubkey],
    undefined,
    false,
    undefined,
    { solo: false, visibility: "private" },
  );
  const id = t.startConversation.mock.calls[0]?.[0];
  expect(sentTo(t)).toEqual([id]);
  expect(t.onStarted).toHaveBeenCalledWith(id, expect.any(String));
  expect(t.onOpenChat).not.toHaveBeenCalled();
});

it("names the started conversation by the typed title", async () => {
  const t = setup();
  t.mount(t.create());
  await t.user.click(await option("Avery"));
  await t.user.type(screen.getByRole("textbox", { name: "Name" }), "Offsite");
  await t.user.type(composer(), "Where to?");
  await t.user.click(send());
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.startConversation.mock.calls[0]?.[1]).toBe("Offsite");
  expect(t.publish.mock.calls[0]?.[0].content).toBe("Where to?");
  expect(t.openDirectMessage).not.toHaveBeenCalled();
});

it("sends in the DM, which the relay opens by its people, once Direct message is chosen", async () => {
  const t = setup();
  t.mount(t.create());
  // Zoe has no DM with the viewer.
  await t.user.click(await option("Zoe"));
  await knowsNoDm();
  await t.user.click(directRow());
  expect(directRow()).toHaveAttribute("aria-pressed", "true");
  await t.user.type(composer(), "Hello Zoe");
  await t.user.click(send());
  await waitFor(() => expect(t.openDirectMessage).toHaveBeenCalledOnce());
  // The relay picks the DM by its people, and restores it if it is hidden.
  expect(t.openDirectMessage.mock.calls[0]?.[2]).toEqual({
    includeHistory: true,
  });
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.startConversation).not.toHaveBeenCalled();
  expect(sentTo(t)).toEqual([channel]);
});

describe("the relay picks the DM, and the list is only a hint", () => {
  /** Mallory is a person to the relay, but her own profile says agent, so the
   * page counts the group as Avery's DM and, sorting first, offers it. */
  const mallorys = "00000000-0000-4000-8000-000000000000";
  function withMallory(t: ReturnType<typeof setup>) {
    t.events.unshift(
      profile(third, { name: "Mallory", is_agent: true }),
      signed(relay, {
        kind: 39000,
        tags: [
          ["d", mallorys],
          ["hidden", ""],
          ["t", "dm"],
          ["private", ""],
        ],
        content: JSON.stringify({ name: "Avery, Mallory", channel_type: "dm" }),
      }),
      roster(relay, mallorys, [viewer.pubkey, other.pubkey, third.pubkey]),
      message(other, mallorys, "Mallory is here", 1_700_000_002),
    );
  }

  it("opens the group DM whose other member claims to be an agent, as the people's DM", async () => {
    const t = setup();
    withMallory(t);
    const owner = t.create();
    t.mount(owner);
    await owner.session.profiles.ensure([third.pubkey]);
    await t.user.click(await option("Avery"));
    await knowsDm();
    await t.user.click(directRow());
    expect(t.onOpenChat).toHaveBeenCalledExactlyOnceWith(mallorys);
    expect(t.openDirectMessage).not.toHaveBeenCalled();
    expect(t.publish).not.toHaveBeenCalled();
  });

  it("sends a 1:1 to the people's DM when this page knows no DM, whatever the relay has", async () => {
    const t = setup();
    withMallory(t);
    const owner = t.create();
    t.mount(owner, undefined, undefined, []);
    await t.user.click(await option("Avery"));
    await knowsNoDm();
    await t.user.click(directRow());
    await t.user.type(composer(), "Just us");
    await t.user.click(send());
    await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
    // The relay returns Avery's 1:1, and the message and page go there.
    expect(t.openDirectMessage.mock.calls).toEqual([
      [[other.pubkey], expect.any(AbortSignal), { includeHistory: true }],
    ]);
    expect(sentTo(t)).toEqual([channel]);
    expect(t.onStarted).toHaveBeenCalledWith(channel, expect.any(String));
  });

  /** Avery's DM, which the viewer's agent Zoe joined later: the relay still
   * knows it by its people, not by all its members. */
  function withAgentJoined(t: ReturnType<typeof setup>) {
    const at = t.events.findIndex(
      (event) => event.kind === 0 && event.pubkey === another.pubkey,
    );
    t.events[at] = signed(another, {
      kind: 0,
      content: JSON.stringify({ name: "Zoe", is_agent: true }),
      tags: [],
    });
    t.agents.push({ pubkey: another.pubkey, name: "Zoe" });
    t.events[t.events.length - 1] = roster(relay, channel, [
      viewer.pubkey,
      other.pubkey,
      another.pubkey,
    ]);
    t.events.unshift(message(other, channel, "Zoe joined", 1_700_000_001));
  }

  it("opens a DM an agent joined as the DM of the people it still has", async () => {
    const t = setup();
    withAgentJoined(t);
    t.mount(t.create());
    await t.user.click(await option("Avery"));
    await addRecipient(t, "Zoe, Agent");
    await knowsDm();
    await t.user.click(directRow());
    expect(t.onOpenChat).toHaveBeenCalledExactlyOnceWith(channel);
    expect(t.openDirectMessage).not.toHaveBeenCalled();
    expect(t.publish).not.toHaveBeenCalled();
  });

  it("sends to a DM an agent joined in place, by the people it still has", async () => {
    const t = setup();
    withAgentJoined(t);
    t.mount(t.create(), undefined, undefined, []);
    await t.user.click(await option("Avery"));
    await addRecipient(t, "Zoe, Agent");
    await knowsNoDm();
    await t.user.click(directRow());
    await t.user.type(composer(), "Hello");
    await t.user.click(send());
    await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
    // Tagged, the relay finds this DM by its people instead of making an
    // empty one of exactly these members.
    expect(t.openDirectMessage.mock.calls).toEqual([
      [
        [other.pubkey, another.pubkey],
        expect.any(AbortSignal),
        { includeHistory: true },
      ],
    ]);
    expect(sentTo(t)).toEqual([channel]);
  });
});

/** A group DM with Avery and Zoe, plus one earlier message in each DM. */
function groupHistory(t: ReturnType<typeof setup>) {
  t.events.unshift(
    profile(third, { name: "Kai" }),
    signed(relay, {
      kind: 39000,
      tags: [
        ["d", group],
        ["hidden", ""],
        ["t", "dm"],
        ["private", ""],
      ],
      content: JSON.stringify({ name: "Avery, Zoe", channel_type: "dm" }),
    }),
    roster(relay, group, [viewer.pubkey, other.pubkey, another.pubkey]),
    message(other, channel, "Earlier conversation", 1_700_000_001),
    message(another, group, "Group history", 1_700_000_002),
  );
}
async function addRecipient(t: ReturnType<typeof setup>, name: string) {
  const field = screen.getByRole("combobox", { name: "Message recipients" });
  await t.user.click(field);
  // With people already picked the list closes; typing brings it back.
  await t.user.type(field, name.split(",")[0] ?? name);
  await t.user.click(await option(name));
}

it("offers locally and relay-hidden DMs as rows without restoring them, and a default send leaves them hidden", async () => {
  const t = setup();
  groupHistory(t);
  t.events.unshift(
    signed(relay, {
      kind: 30622,
      tags: [
        ["d", viewer.pubkey],
        ["p", viewer.pubkey],
        ["h", group],
      ],
      content: "",
    }),
  );
  const owner = t.create();
  // The sidebar's owner of local hides, mounted beside the page as in Messages.
  let sidebar: ReturnType<typeof useHiddenDms> | undefined;
  function Sidebar() {
    sidebar = useHiddenDms(
      scope,
      owner.session,
      useChannelList(owner.session.channels),
    );
    return null;
  }
  render(<Sidebar />);
  await owner.session.channelLifecycle.refreshVisibility();
  expect(owner.session.channelLifecycle.snapshot().hidden).toEqual([group]);
  await waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  act(() => sidebar?.hide(channel));
  // Settle the hide's own history baseline before anything offers the DM.
  await waitFor(() =>
    expect(readView(scope, "hidden-dms", [])).toEqual([
      expect.objectContaining({ id: channel, knownIds: expect.any(Array) }),
    ]),
  );
  t.mount(owner);
  await t.user.click(await option("Avery"));
  await knowsDm();
  await t.user.click(directRow());
  expect(t.onOpenChat).toHaveBeenLastCalledWith(channel);
  await addRecipient(t, "Zoe");
  await waitFor(async () => {
    await t.user.click(directRow());
    expect(t.onOpenChat).toHaveBeenLastCalledWith(group);
  });
  await t.user.click(screen.getByRole("button", { name: "Remove Zoe" }));
  await knowsDm();
  // Offering them neither restored a row nor opened a DM.
  expect(sidebar?.hiddenIds).toEqual(new Set([channel]));
  expect(owner.session.channelLifecycle.snapshot().hidden).toEqual([group]);
  expect(t.openDirectMessage).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
  // Send starts a conversation, so the hidden DM stays hidden.
  await t.user.type(composer(), "Back again");
  await t.user.click(send());
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.openDirectMessage).not.toHaveBeenCalled();
  expect(t.startConversation).toHaveBeenCalledOnce();
  expect(sidebar?.hiddenIds).toEqual(new Set([channel]));
});

it("offers only the DM whose participants exactly match, in any order", async () => {
  const t = setup();
  groupHistory(t);
  const owner = t.create();
  t.mount(owner);
  /** The DM the row opens for the people now picked, once it has one. */
  const opens = async () => {
    await knowsDm();
    t.onOpenChat.mockClear();
    await t.user.click(directRow());
    return t.onOpenChat.mock.lastCall?.[0];
  };
  // Zoe alone is a subset of the group and has no 1:1 DM.
  await t.user.click(await option("Zoe"));
  await waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  await knowsNoDm();
  await addRecipient(t, "Avery");
  expect(await opens()).toBe(group);
  // A superset leaves the group as soon as it is chosen.
  await addRecipient(t, "Kai");
  await knowsNoDm();
  await t.user.click(screen.getByRole("button", { name: "Remove Kai" }));
  expect(await opens()).toBe(group);
  // Avery alone, also a subset of the group, matches the separate 1:1 DM.
  await t.user.click(screen.getByRole("button", { name: "Remove Zoe" }));
  await waitFor(async () => expect(await opens()).toBe(channel));
  expect(t.openDirectMessage).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
});

it("offers a group DM of the same people even when it also holds an agent", async () => {
  const t = setup();
  groupHistory(t);
  const bot = keypair();
  t.events.unshift(
    signed(bot, {
      kind: 0,
      content: JSON.stringify({ name: "Bot" }),
      tags: [["auth", viewer.pubkey, "", "a".repeat(128)]],
    }),
  );
  const at = t.events.findIndex(
    (event) =>
      event.kind === 39002 &&
      event.tags.some(([name, value]) => name === "d" && value === group),
  );
  t.events[at] = roster(relay, group, [
    viewer.pubkey,
    other.pubkey,
    another.pubkey,
    bot.pubkey,
  ]);
  const owner = t.create();
  t.mount(owner);
  await owner.session.profiles.ensure([bot.pubkey]);
  await t.user.click(await option("Zoe"));
  await addRecipient(t, "Avery");
  await knowsDm();
  await t.user.click(directRow());
  expect(t.onOpenChat).toHaveBeenCalledExactlyOnceWith(group);
  expect(t.openDirectMessage).not.toHaveBeenCalled();
});

it("matches the recipients chosen by the time the DM roster loads", async () => {
  const t = setup();
  groupHistory(t);
  const read = t.query.getMockImplementation();
  assert.exists(read);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  t.query.mockImplementation(async (filters) => {
    if (
      filters.some(
        (filter) =>
          filter.kinds?.includes(39002) && filter["#p"] && !filter["#d"],
      )
    ) {
      started = true;
      await held;
    }
    return read(filters);
  });
  const owner = t.create();
  t.mount(owner);
  try {
    await t.user.click(await option("Avery"));
    await addRecipient(t, "Zoe");
    await waitFor(() => expect(started).toBe(true));
    expect(owner.session.channels.list().status).not.toBe("ready");
    // No DM is known yet, so Direct message only toggles.
    expect(directRow()).toHaveAttribute("aria-pressed", "false");
    await t.user.click(screen.getByRole("button", { name: "Remove Zoe" }));
  } finally {
    release();
  }
  await knowsDm();
  await t.user.click(directRow());
  expect(t.onOpenChat).toHaveBeenLastCalledWith(channel);
  await addRecipient(t, "Zoe");
  await waitFor(async () => {
    await t.user.click(directRow());
    expect(t.onOpenChat).toHaveBeenLastCalledWith(group);
  });
  expect(t.openDirectMessage).not.toHaveBeenCalled();
});

it("still opens an existing DM, and starts conversations, when this connection cannot start DMs", async () => {
  const t = setup();
  t.events.unshift(
    message(other, channel, "Earlier conversation", 1_700_000_001),
  );
  const live = t.create();
  const owner = {
    ...live,
    session: {
      ...live.session,
      directMessages: { ...live.session.directMessages, available: false },
    },
  };
  t.mount(owner);
  await t.user.click(await option("Avery"));
  await knowsDm();
  await t.user.click(directRow());
  expect(t.onOpenChat).toHaveBeenCalledExactlyOnceWith(channel);
  // New conversations never need a DM.
  expect(
    screen.queryByText(
      "Starting direct messages is unavailable on this connection.",
    ),
  ).not.toBeInTheDocument();
  await t.user.type(composer(), "Hello");
  expect(send()).toBeEnabled();
  // Choosing a DM that must be started is what this connection cannot do.
  await t.user.click(screen.getByRole("button", { name: "Remove Avery" }));
  await addRecipient(t, "Zoe");
  await knowsNoDm();
  await t.user.click(directRow());
  expect(
    screen.getByText(
      "Starting direct messages is unavailable on this connection.",
    ),
  ).toBeVisible();
  expect(send()).toBeDisabled();
  expect(t.openDirectMessage).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
});

const photo = {
  name: "photo.png",
  url: `https://relay.example/media/${"f".repeat(64)}.png`,
  type: "image/png",
  size: 5,
  sha256: "f".repeat(64),
};
function attachable(t: ReturnType<typeof setup>) {
  const live = t.create();
  const uploadForNewChat = vi.fn(async () => photo);
  const owner = {
    ...live,
    session: {
      ...live.session,
      attachments: {
        prepare: async (file: File) => file,
        upload: vi.fn(),
        uploadForNewChat,
      },
    },
  };
  const view = t.mount(owner);
  const attach = () =>
    t.user.upload(
      screen.getByLabelText("Choose attachments"),
      new File(["photo"], "photo.png", { type: "image/png" }),
    );
  return {
    owner,
    get files() {
      return attachmentDraft(
        owner.session,
        `${scope}:direct-message:new-draft`,
        channel,
        true,
      );
    },
    view,
    uploadForNewChat,
    attach,
  };
}

it.each(["", "See attached"])(
  "sends a photo with caption %j and clears files on delivery",
  async (caption) => {
    const t = setup();
    const f = attachable(t);
    await t.user.click(await option("Avery"));
    if (caption) await t.user.type(composer(), caption);
    await f.attach();
    await waitFor(() => expect(f.files.snapshot()[0]?.status).toBe("ready"));
    expect(t.openDirectMessage).not.toHaveBeenCalled();
    expect(send()).toBeEnabled();
    await t.user.click(send());
    await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
    const event = t.publish.mock.calls[0]?.[0];
    expect(event?.content).toContain(`![photo.png](<${photo.url}>)`);
    if (caption) expect(event?.content).toContain(caption);
    expect(event?.tags).toContainEqual(
      expect.arrayContaining(["imeta", `x ${photo.sha256}`]),
    );
    expect(f.files.snapshot()).toEqual([]);
    f.view.unmount();
    t.mount(f.owner);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
    expect(
      screen.queryByRole("button", { name: "Remove photo.png" }),
    ).not.toBeInTheDocument();
    expect(send()).toBeDisabled();
  },
);

it("waits for uploads before opening a DM and reports failure only on the chip", async () => {
  const t = setup();
  const f = attachable(t);
  let rejectUpload = (_reason: Error) => {};
  f.uploadForNewChat.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectUpload = reject;
      }),
  );
  await t.user.click(await option("Avery"));
  await f.attach();
  await waitFor(() => expect(f.uploadForNewChat).toHaveBeenCalledOnce());
  try {
    await t.user.click(send());
    expect(await screen.findByText("Uploading files…")).toBeVisible();
    expect(t.openDirectMessage).not.toHaveBeenCalled();
  } finally {
    await act(async () =>
      rejectUpload(new Error("Upload failed. Retry or remove this file.")),
    );
  }
  expect(
    await screen.findByRole("button", { name: "Retry photo.png" }),
  ).toBeEnabled();
  expect(
    await screen.findByText(
      "A file couldn’t upload. Follow the guidance on each file that shows an error, then send again.",
    ),
  ).toHaveAttribute("role", "status");
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(send()).toBeDisabled();
  expect(t.openDirectMessage).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
  await t.user.click(screen.getByRole("button", { name: "Retry photo.png" }));
  await waitFor(() => expect(f.files.snapshot()[0]?.status).toBe("ready"));
  await t.user.click(send());
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
});

it("offers only removal for a file whose type the relay refuses while a DM waits for it", async () => {
  const t = setup();
  const f = attachable(t);
  let rejectUpload = (_reason: Error) => {};
  f.uploadForNewChat.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectUpload = reject;
      }),
  );
  await t.user.click(await screen.findByRole("option", { name: "Avery" }));
  await f.attach();
  await waitFor(() => expect(f.uploadForNewChat).toHaveBeenCalledOnce());
  try {
    await t.user.click(send());
    expect(await screen.findByText("Uploading files…")).toBeVisible();
  } finally {
    await act(async () => rejectUpload(new UploadError("type")));
  }
  // The relay would refuse the same bytes again, so the chip offers no Retry
  // and the page points at each chip rather than naming an action.
  expect(
    await screen.findByText(
      "A file couldn’t upload. Follow the guidance on each file that shows an error, then send again.",
    ),
  ).toHaveAttribute("role", "status");
  expect(screen.getByRole("alert")).toHaveTextContent(
    `photo.png: ${UPLOAD_FAILURES.type}`,
  );
  expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  expect(send()).toBeDisabled();
  expect(t.openDirectMessage).not.toHaveBeenCalled();
  await t.user.click(screen.getByRole("button", { name: "Remove photo.png" }));
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["remove", "replace", "rename", "unchanged"])(
  "uses the visible files after a failed send: %s",
  async (change) => {
    const t = setup();
    t.publish.mockRejectedValueOnce(new PublishRejected("Not sent"));
    const f = attachable(t);
    await t.compose();
    await f.attach();
    await t.user.click(send());
    await screen.findByRole("alert");
    expect(f.files.snapshot()).toHaveLength(1);
    const original = t.publish.mock.calls[0]?.[0];
    if (change !== "unchanged") {
      await t.user.click(
        screen.getByRole("button", { name: "Remove photo.png" }),
      );
      if (change === "replace") {
        f.uploadForNewChat.mockResolvedValue({
          ...photo,
          sha256: "e".repeat(64),
          url: `https://relay.example/media/${"e".repeat(64)}.png`,
        });
        await f.attach();
      } else if (change === "rename") {
        f.uploadForNewChat.mockResolvedValue({ ...photo, name: "renamed.png" });
        await t.user.upload(
          screen.getByLabelText("Choose attachments"),
          new File(["photo"], "renamed.png", { type: "image/png" }),
        );
      }
    }
    await t.user.click(send());
    await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
    const retried = t.publish.mock.calls[1]?.[0];
    if (change === "unchanged") expect(retried).toEqual(original);
    else {
      expect(retried?.id).not.toBe(original?.id);
      if (change === "rename") {
        expect(retried?.content).toContain(`![renamed.png](<${photo.url}>)`);
        expect(retried?.tags).toContainEqual(
          expect.arrayContaining(["imeta", "filename renamed.png"]),
        );
      } else expect(retried?.content).not.toContain(photo.url);
      expect(retried?.tags.filter(([name]) => name === "imeta")).toHaveLength(
        change === "remove" ? 0 : 1,
      );
    }
  },
);

it("confirms a photo-only uncertain send after session restart without files or a replacement event", async () => {
  const t = setup();
  t.publish.mockRejectedValueOnce(new Error("Receipt lost"));
  const f = attachable(t);
  await t.user.click(await option("Avery"));
  await f.attach();
  await t.user.click(send());
  await screen.findByRole("alert");
  const original = t.publish.mock.calls[0]?.[0];
  f.view.unmount();
  f.owner.dispose();
  const passThrough = vi.fn<PageNavigation["passThrough"]>(() => () => {});
  t.mount(t.create(), undefined, { passThrough } as unknown as PageNavigation);
  const retry = await screen.findByRole("button", { name: "Retry send" });
  // The held photo keeps the retry page in Back history.
  expect(passThrough.mock.lastCall?.[0]()).toBe(false);
  await t.user.click(retry);
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.publish.mock.calls[1]?.[0]).toEqual(original);
});

it("drops files on the recipient header into the new DM composer", async () => {
  const t = setup();
  const f = attachable(t);
  await t.user.click(await option("Avery"));
  const header = screen.getByRole("combobox");
  const dataTransfer = {
    types: ["Files"],
    files: [new File(["photo"], "photo.png", { type: "image/png" })],
    dropEffect: "uninitialized",
  };
  fireEvent.dragEnter(header, { dataTransfer });
  const overlay = await screen.findByText("Drop files into this conversation");
  expect(overlay.parentElement?.parentElement).toBe(
    screen.getByRole("region", { name: "New message" }),
  );
  fireEvent.drop(header, { dataTransfer });
  await waitFor(() => expect(f.files.snapshot()[0]?.status).toBe("ready"));
  expect(t.openDirectMessage).not.toHaveBeenCalled();
});
