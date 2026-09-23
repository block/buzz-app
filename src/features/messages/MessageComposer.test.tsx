// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { bindNames } from "../identity-names/service";
import { createAgentDirectory } from "../../bundled/agents/directory";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect } from "react";
import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerCompletion,
  ComposerCompletionProps,
  ComposerTool,
  ComposerToolProps,
  CompletionResult,
  InlineRenderer,
} from "../conversation/contracts";
import type { AgentLibrarySnapshot } from "../agents/library";
import { createAgentChoices } from "../agents/choices";
import { createAgentControl, type AgentControl } from "../agents/control";
import { controlFixture } from "../agents/control-testing";
import type { OutgoingEvent } from "../relay/outbox";
import { MessageComposer, type MessageComposerProps } from "./MessageComposer";
import { createRelaySession, type RelaySession } from "../relay/session";
import { keypair, metadata, roster, signed } from "../relay/testing";
import type { EventTemplate } from "nostr-tools";
import type { Profile } from "../relay/contracts";
import { emojiMatches, type CustomEmoji } from "../relay/emoji";
import { CustomEmoji as CustomEmojiImage } from "../../bundled/emoji/CustomEmoji";
import type { ComposerInputElement } from "./composer-dom";
import { setRememberAgentsPreference } from "./mention-preferences";

const first = { pubkey: "a".repeat(64), name: "Honey" };
const second = { pubkey: "b".repeat(64), name: "Honey" };

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

function mount(
  options: Partial<MessageComposerProps> = {},
  control?: AgentControl,
) {
  let commands: ComposerToolProps;
  const completionRequests: ComposerCompletionProps["publish"][] = [];
  function Completion({ publish }: ComposerCompletionProps) {
    useLayoutEffect(() => {
      completionRequests.push(publish);
    }, [publish]);
    return null;
  }
  const completionListeners = new Set<() => void>();
  const completion = (revision: string): Contribution<ComposerCompletion> => ({
    id: "delayed",
    key: "test/delayed",
    pluginId: "test",
    revision,
    title: "Delayed",
    match: ({ text, start }) =>
      text.startsWith("!") && start > 0
        ? { start: 0, end: start, query: text.slice(1, start) }
        : null,
    component: Completion,
  });
  let completions: readonly Contribution<ComposerCompletion>[] = [
    completion("1"),
  ];
  function Tool(props: ComposerToolProps) {
    useLayoutEffect(() => {
      commands = props;
    });
    return (
      <>
        <button type="button" onClick={() => props.insertMention(first)}>
          First Honey
        </button>
        <button type="button" onClick={() => props.insertMention(second)}>
          Second Honey
        </button>
      </>
    );
  }
  const tools: readonly Contribution<ComposerTool>[] = [
    {
      id: "fixture",
      key: "test/fixture",
      pluginId: "test",
      revision: "1",
      title: "Fixture tools",
      component: Tool,
    },
  ];
  const emojiListeners = new Set<() => void>();
  let emoji = {
    status: "ready" as const,
    entries: [] as readonly CustomEmoji[],
  };
  const messages = {
    send: vi.fn<RelaySession["messages"]["send"]>(() => "channel-id"),
    reply: vi.fn<RelaySession["messages"]["reply"]>(() => "reply-id"),
  };
  const typing: ReturnType<RelaySession["typing"]["snapshot"]> = [];
  let profiles: ReadonlyMap<string, Profile> = new Map();
  const profileListeners = new Set<() => void>();
  const libraryListeners = new Set<() => void>();
  let library: AgentLibrarySnapshot = {
    status: "ready",
    identities: [],
    definitions: [],
  };
  const channelList = {
    status: "ready" as const,
    channels: [{ id: "channel", members: [first.pubkey, second.pubkey] }],
  };
  const session = {
    messages,
    typing: { snapshot: () => typing, subscribe: () => () => {} },
    profiles: {
      snapshot: () => profiles,
      subscribe(listener: () => void) {
        profileListeners.add(listener);
        return () => {
          profileListeners.delete(listener);
        };
      },
      ensure: vi.fn(async () => {}),
    },
    agentLibrary: {
      snapshot: () => library,
      subscribe(listener: () => void) {
        libraryListeners.add(listener);
        return () => libraryListeners.delete(listener);
      },
      refresh: vi.fn(async () => {}),
    },
    emoji: {
      snapshot: () => emoji,
      subscribe(listener: () => void) {
        emojiListeners.add(listener);
        return () => {
          emojiListeners.delete(listener);
        };
      },
      ensure: vi.fn(() => Promise.resolve()),
      refresh: vi.fn(() => Promise.resolve()),
    },
    media: (url: string) => url,
    outbox: { supports: () => true },
    channels: {
      list: () => channelList,
      subscribeList: () => () => {},
    },
  } as unknown as RelaySession;
  const onSend = vi.fn();
  const inline: readonly Contribution<InlineRenderer>[] = [
    {
      id: "emoji",
      key: "test/emoji",
      pluginId: "test",
      revision: "1",
      title: "Emoji",
      matches: ({ text, message }) => [
        ...emojiMatches(text, message.emoji ?? []),
      ],
      component: ({ text, content, media }) => {
        const entry = content.message.emoji?.find(
          (entry) => `:${entry.shortcode}:` === text.toLowerCase(),
        );
        return entry ? <CustomEmojiImage emoji={entry} media={media} /> : text;
      },
    },
  ];
  let props: MessageComposerProps = {
    session,
    onSend,
    scope: "scope",
    channelId: "channel",
    channelName: "General",
    extensions: {
      tools: { snapshot: () => tools, subscribe: () => () => {} },
      inline: { snapshot: () => inline, subscribe: () => () => {} },
      completions: {
        snapshot: () => completions,
        subscribe(listener) {
          completionListeners.add(listener);
          return () => completionListeners.delete(listener);
        },
      },
    },
    ...options,
  };
  const bindChoices = () => {
    const library = props.session.agentLibrary;
    props = {
      ...props,
      session: {
        ...props.session,
        scope: props.scope,
        agentChoices: createAgentChoices({
          scope: props.scope,
          library: { ...library, retain: () => () => {} },
          native: control,
          signal: new AbortController().signal,
        }),
      },
    };
  };
  bindChoices();
  const tree = () => <MessageComposer {...props} />;
  const view = render(tree(), {
    reactStrictMode: true,
  });
  const input = () =>
    within(view.container).getByRole<ComposerInputElement>("textbox");
  return {
    ...view,
    input,
    messages,
    onSend,
    session: props.session,
    emojiListeners,
    user: userEvent.setup(),
    commands: () => commands,
    completionRequests,
    publish(index: number, text = "chosen") {
      const request = completionRequests[index];
      if (!request) throw new Error("No observed completion request");
      const result: CompletionResult = {
        items: [{ id: text, label: text, edit: { text } }],
      };
      let published: ReturnType<ComposerCompletionProps["publish"]> = false;
      act(() => {
        published = request(result);
      });
      return published;
    },
    replaceCompletionProvider() {
      act(() => {
        completions = [completion("2")];
        for (const listener of completionListeners) listener();
      });
    },
    retarget(next: Partial<MessageComposerProps>) {
      const changedSession =
        (next.session !== undefined && next.session !== props.session) ||
        (next.scope !== undefined && next.scope !== props.scope);
      props = { ...props, ...next };
      if (changedSession) bindChoices();
      view.rerender(tree());
    },
    setProfiles(next: ReadonlyMap<string, Profile>) {
      act(() => {
        profiles = next;
        for (const listener of profileListeners) listener();
      });
    },
    setLibrary(identities: AgentLibrarySnapshot["identities"]) {
      act(() => {
        library = { ...library, identities };
        for (const listener of libraryListeners) listener();
      });
    },
    setEmoji(entries: readonly CustomEmoji[]) {
      act(() => {
        emoji = { status: "ready", entries };
        for (const listener of emojiListeners) listener();
      });
    },
    fill(text: string) {
      const field = input();
      act(() => field.focus());
      field.value = text;
      field.setSelectionRange(text.length, text.length);
      fireEvent.input(field);
      // Browsers queue selectionchange after the editor restores its native
      // selection. Deliver that boundary explicitly in this synchronous fixture.
      fireEvent(document, new Event("selectionchange"));
    },
    submit() {
      fireEvent.submit(within(view.container).getByRole("form"));
    },
  };
}

it("keeps unpublished completions invisible but lets Escape revoke pending work", () => {
  const h = mount();
  const input = h.input();
  input.focus();
  h.fill("!pending");
  const pending = h.completionRequests.length - 1;
  expect(pending).toBeGreaterThanOrEqual(0);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(input).not.toHaveAttribute("aria-controls");
  expect(input).not.toHaveAttribute("aria-haspopup");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(h.publish(pending, "late result")).toBe(false);
  expect(h.messages.send).not.toHaveBeenCalled();
  expect(input).toHaveValue("!pending");

  h.fill("!fresh");
  expect(h.publish(h.completionRequests.length - 1)).not.toBe(false);
  expect(screen.getByRole("option", { name: "chosen" })).toBeVisible();
  expect(input).toHaveAttribute("aria-controls");
});

it("shows provider-owned pending and retry states and hides an empty publication", () => {
  const h = mount();
  const input = h.input();
  input.focus();
  h.fill("!search");
  const publish = h.completionRequests.at(-1);
  if (!publish) throw new Error("No observed completion request");
  act(() => {
    publish({ items: [], status: "Searching fixture…" });
  });
  expect(screen.getByRole("status")).toHaveTextContent("Searching fixture…");
  const retry = vi.fn(() =>
    publish({
      items: [
        { id: "recovered", label: "Recovered", edit: { text: "recovered" } },
      ],
    }),
  );
  act(() => {
    publish({ items: [], status: "Unavailable", retry });
  });
  expect(
    screen.getByRole("option", { name: "Retry suggestions" }),
  ).toBeVisible();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(retry).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("option", { name: "Recovered" })).toBeVisible();
  expect(h.messages.send).not.toHaveBeenCalled();
  act(() => {
    publish({ items: [] });
  });
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(input).not.toHaveAttribute("aria-controls");
});

it("revokes stale completion publications across editor and ownership lifecycles and recovers freshly", () => {
  const h = mount();
  const input = h.input();
  input.focus();
  h.fill("!a");
  const edit = h.completionRequests.length - 1;
  h.fill("!b");
  h.fill("!a");
  expect(h.publish(edit, "stale ABA")).toBe(false);
  const afterAba = h.completionRequests.length - 1;
  expect(h.publish(afterAba)).not.toBe(false);
  expect(screen.getByRole("option", { name: "chosen" })).toBeVisible();

  fireEvent.keyDown(input, { key: "Escape" });
  expect(h.publish(afterAba, "stale dismissal")).toBe(false);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

  h.fill("!provider");
  const oldProvider = h.completionRequests.length - 1;
  h.replaceCompletionProvider();
  expect(h.publish(oldProvider, "stale provider")).toBe(false);
  const replacement = h.completionRequests.length - 1;
  expect(h.publish(replacement, "replacement fresh")).not.toBe(false);
  expect(
    screen.getByRole("option", { name: "replacement fresh" }),
  ).toBeVisible();

  h.fill("!destination");
  const oldDestination = h.completionRequests.length - 1;
  h.retarget({ threadRootId: "root" });
  expect(h.input()).toHaveValue("");
  expect(h.publish(oldDestination, "stale destination")).toBe(false);
  h.input().focus();
  h.fill("!fresh");
  const fresh = h.completionRequests.length - 1;
  expect(h.publish(fresh, "fresh recovery")).not.toBe(false);
  expect(screen.getByRole("option", { name: "fresh recovery" })).toBeVisible();

  h.unmount();
  expect(h.publish(fresh, "stale unmount")).toBe(false);
});

it.each(["disabled", "readOnly"] as const)(
  "rejects late and displayed completion results when the editor becomes %s",
  (state) => {
    const h = mount();
    const input = h.input();
    input.focus();
    h.fill("!late");
    const late = h.completionRequests.length - 1;
    if (state === "disabled") {
      h.retarget({ disabled: true });
      expect(input).toHaveAttribute("aria-disabled", "true");
      expect(input).toHaveAttribute("contenteditable", "false");
    } else input.readOnly = true;
    expect(h.publish(late, "late result")).toBe(false);

    if (state === "disabled") h.retarget({ disabled: false });
    else input.readOnly = false;
    expect(h.input().disabled).toBe(false);
    expect(h.input().readOnly).toBe(false);
    h.input().focus();
    h.fill("!displayed");
    const displayed = h.completionRequests.length - 1;
    expect(h.publish(displayed, "displayed choice")).not.toBe(false);
    expect(
      screen.getByRole("option", { name: "displayed choice" }),
    ).toBeVisible();
    if (state === "disabled") h.retarget({ disabled: true });
    else h.input().readOnly = true;
    fireEvent.keyDown(h.input(), { key: "Enter" });
    expect(h.input()).toHaveValue("!displayed");
    expect(h.messages.send).not.toHaveBeenCalled();
  },
);

it("sends channel messages and thread replies through real form and keyboard events", async () => {
  const h = mount();
  await h.user.type(h.input(), "channel draft");
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "channel draft",
    [],
  );
  expect(h.messages.reply).not.toHaveBeenCalled();
  h.retarget({ threadRootId: "root" });
  await h.user.type(h.input(), "thread draft");
  await h.user.keyboard("{Shift>}{Enter}{/Shift}");
  expect(h.input()).toHaveValue("thread draft\n");
  // This checks the composition guard, not native IME behavior.
  fireEvent.keyDown(h.input(), { key: "Enter", isComposing: true });
  expect(h.messages.reply).not.toHaveBeenCalled();
  await h.user.keyboard("{Enter}");
  expect(h.messages.reply).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "root",
    "thread draft\n",
    [],
  );
  expect(h.messages.send).toHaveBeenCalledTimes(1);
  expect(h.onSend.mock.calls).toEqual([["channel-id"], ["reply-id"]]);
  expect(h.input()).toHaveValue("");
});

it("isolates channel, thread and identity drafts through retargeting and remounting", () => {
  const h = mount();
  h.fill("channel draft");
  h.retarget({ threadRootId: "one" });
  expect(h.input()).toHaveValue("");
  h.fill("first thread");
  h.retarget({ threadRootId: "two" });
  h.fill("second thread");
  h.retarget({ threadRootId: "one", scope: "other identity" });
  expect(h.input()).toHaveValue("");
  h.fill("other identity");
  h.retarget({ threadRootId: "one", scope: "scope" });
  expect(h.input()).toHaveValue("first thread");
  h.retarget({ threadRootId: "two" });
  expect(h.input()).toHaveValue("second thread");
  h.unmount();
  const restored = mount();
  expect(restored.input()).toHaveValue("channel draft");
  restored.retarget({ threadRootId: "one", scope: "other identity" });
  expect(restored.input()).toHaveValue("other identity");
});

it("retains rejected intent and clears the draft only after the outbox accepts it", async () => {
  const h = mount({ threadRootId: "root" });
  h.fill("retry me");
  h.messages.reply.mockImplementationOnce(() => {
    throw new Error("outbox full");
  });
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.input()).toHaveValue("retry me");
  expect(h.onSend).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("outbox full");
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.messages.reply).toHaveBeenCalledTimes(2);
  expect(h.input()).toHaveValue("");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("labels simultaneous composers independently and prevents disabled or unsupported writes", async () => {
  const channel = mount();
  const thread = mount({ threadRootId: "root" });
  expect(screen.getByLabelText("Message #General")).toBe(channel.input());
  expect(screen.getByRole("textbox", { name: "Reply to thread" })).toBe(
    thread.input(),
  );
  expect(thread.input().id).not.toBe(channel.input().id);
  thread.fill("retain me");
  thread.retarget({ disabled: true });
  expect(thread.input()).toHaveAttribute("aria-disabled", "true");
  expect(thread.input()).toHaveAttribute("contenteditable", "false");
  await thread.user.click(
    within(thread.container).getByRole("button", { name: "Send message" }),
  );
  expect(thread.messages.reply).not.toHaveBeenCalled();
  expect(thread.input()).toHaveValue("retain me");
  thread.retarget({
    session: {
      ...thread.session,
      outbox: { supports: () => false },
    } as unknown as RelaySession,
  });
  expect(
    within(thread.container).queryByRole("textbox"),
  ).not.toBeInTheDocument();
  expect(
    within(thread.container).getByText(
      "This relay connection supports reading only.",
    ),
  ).toBeVisible();
});

it("subscribes to emoji changes and releases the subscription when unmounted", () => {
  const h = mount();
  h.fill(":party:");
  expect(h.input().querySelectorAll("img")).toHaveLength(0);
  expect(h.emojiListeners.size).toBe(1);
  expect(h.session.emoji.ensure).toHaveBeenCalled();
  h.setEmoji([{ shortcode: "party", url: "https://emoji.test/party.png" }]);
  expect(h.input().querySelectorAll("img")).toHaveLength(1);
  h.setEmoji([]);
  expect(h.input().querySelectorAll("img")).toHaveLength(0);
  h.unmount();
  expect(h.emojiListeners.size).toBe(0);
});

it("enlarges Unicode-only drafts and restores normal text presentation", () => {
  const h = mount();
  for (const draft of ["😀", "😀 🙏 👏", "😀 🙏 👏 😄"]) {
    h.fill(draft);
    expect(h.input()).toHaveAttribute("data-single-emoji", "true");
    h.fill(`${draft} hello`);
    expect(h.input()).not.toHaveAttribute("data-single-emoji");
  }
});

it.each([undefined, "root"])(
  "persists exact namesake recipients for %s without resolving typed prose",
  async (root) => {
    const options = root ? { threadRootId: root } : {};
    let h = mount(options);
    h.fill("@Honey prose only");
    h.submit();
    expect(
      (root ? h.messages.reply : h.messages.send).mock.calls[0]?.at(-1),
    ).toEqual([]);
    h.fill("Please help ");
    await h.user.click(screen.getByRole("button", { name: "First Honey" }));
    await h.user.click(screen.getByRole("button", { name: "Second Honey" }));
    h.unmount();
    h = mount(options);
    expect(
      within(h.input()).getAllByRole("img", {
        name: /^Person Honey, public key ending/,
      }),
    ).toHaveLength(2);
    expect(
      within(
        screen.getByRole("region", { name: "Explicit mentions" }),
      ).getAllByRole("button"),
    ).toHaveLength(2);
    h.submit();
    expect(
      (root ? h.messages.reply : h.messages.send).mock.calls[0]?.at(-1),
    ).toEqual([first.pubkey, second.pubkey]);
    expect(h.input()).toHaveValue("");
    h.unmount();
    h = mount(options);
    h.fill("@Honey typed after send");
    h.submit();
    expect(
      (root ? h.messages.reply : h.messages.send).mock.calls[0]?.at(-1),
    ).toEqual([]);
  },
);

it("restores live profile avatars with one removal control per exact recipient", async () => {
  const h = mount();
  const media = vi
    .spyOn(h.session, "media")
    .mockImplementation((url) =>
      url ? `https://media.test/${url}` : undefined,
    );
  act(() => {
    h.commands().insertMention(first);
    h.commands().insertMention(second);
    h.commands().insertMention(second);
  });
  let region = screen.getByRole("region", {
    name: "Explicit mentions",
  });
  const controls = within(region).getAllByRole("button");
  expect(controls).toHaveLength(2);
  expect(controls[1]).toHaveTextContent("H");
  // Profiles can arrive after draft restoration; artwork must update without an edit.
  h.setProfiles(
    new Map([
      [first.pubkey, { name: "Honey", picture: "person.png" }],
      [second.pubkey, { name: "Honey", picture: "agent.png", isAgent: true }],
    ]),
  );
  expect(controls[0]?.querySelector(".buzz-avatar")).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );
  expect(controls[1]?.querySelector(".buzz-avatar")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  expect(controls[1]?.querySelector("img")).toHaveAttribute(
    "src",
    "https://media.test/agent.png",
  );
  expect(media).toHaveBeenCalledWith("agent.png", "small");
  // Loaded-library hints update both artwork layers without another keystroke;
  // clearing them removes only that fallback, not self-declared agent metadata.
  for (const control of controls)
    expect(control.querySelectorAll("[data-avatar-shape]")).toHaveLength(2);
  for (const identities of [[first], []]) {
    h.setLibrary(identities);
    for (const [index, control] of controls.entries())
      for (const artwork of control.querySelectorAll("[data-avatar-shape]"))
        expect(artwork).toHaveAttribute(
          "data-avatar-shape",
          index === 1 || identities.length ? "squircle" : "circle",
        );
  }
  expect(h.session.agentLibrary.refresh).not.toHaveBeenCalled();
  h.retarget({ disabled: true });
  for (const control of controls) expect(control).toBeDisabled();
  h.retarget({ disabled: false, extensions: undefined });
  // The optional picker does not own saved intent or its removal controls.
  region = screen.getByRole("region", { name: "Explicit mentions" });
  await h.user.click(
    within(region).getByRole("button", {
      name: `Remove mention Honey ${second.pubkey}`,
    }),
  );
  expect(within(region).getAllByRole("button")).toHaveLength(1);
  expect(h.input()).toHaveValue("@Honey @Honey @Honey ");
  expect(h.input().querySelectorAll(".inline-chip")).toHaveLength(1);
  h.submit();
  expect(h.messages.send).toHaveBeenCalledWith(
    "channel",
    "@Honey @Honey @Honey ",
    [first.pubkey],
  );
  expect(
    screen.queryByRole("region", { name: "Explicit mentions" }),
  ).not.toBeInTheDocument();
});

// Explicit notification intent must remain visible even where Markdown previews are suppressed.
it.each([
  ["inline code", "`", " `"],
  ["fenced code", "```\n", "\n```"],
  ["indented code", "    ", ""],
  ["image", "![", "](https://example.test/image.png)"],
  [
    "image reference",
    "![",
    "][image]\n\n[image]: https://example.test/image.png",
  ],
  ["definition", '[image]: https://example.test/image.png "', '"'],
  ["HTML", "<!-- ", " -->"],
  ["link label", "[", "](https://example.test)"],
  ["deep Markdown", "> ".repeat(101), ""],
])(
  "discloses selected namesakes in %s before and after restoring a draft",
  (_kind, prefix, suffix) => {
    let h = mount();
    h.fill(`${prefix}@Honey ${suffix}`);
    expect(h.input().querySelector(".inline-chip")).toBeNull();
    h.submit();
    expect(h.messages.send.mock.calls.at(-1)?.at(-1)).toEqual([]);
    h.fill(`${prefix}${suffix}`);
    h.input().setSelectionRange(prefix.length, prefix.length);
    act(() => {
      h.commands().insertMention(first);
      h.commands().insertMention(second);
    });
    const text = `${prefix}@Honey @Honey ${suffix}`;
    const labels = [
      "Person Honey, public key ending c a j",
      "Person Honey, public key ending 4 h u",
    ];
    const check = () => {
      expect(h.input()).toHaveValue(text);
      for (const name of labels)
        expect(within(h.input()).getByRole("img", { name })).toBeVisible();
    };
    check();
    h.unmount();
    h = mount();
    check();
    h.submit();
    expect(h.messages.send).toHaveBeenCalledWith("channel", text, [
      first.pubkey,
      second.pubkey,
    ]);
  },
);

it.each([undefined, "root"])(
  "keeps an untouched mention when smart punctuation replaces text behind the caret in %s",
  (root) => {
    const h = mount(root ? { threadRootId: root } : {});
    act(() => {
      h.commands().insertMention(first);
      h.commands().insertText("can you see this is's");
    });
    const input = h.input();
    const text = input.querySelector("[data-editor-text]")?.firstChild;
    if (!(text instanceof Text)) throw new Error("Missing editable text");
    const quote = text.data.indexOf("'");
    expect(quote).toBeGreaterThan(0);
    const target = document.createRange();
    target.setStart(text, quote);
    target.setEnd(text, quote + 1);
    // WebKit's replacement range is behind the caret, not the selection.
    input.setSelectionRange(input.value.length, input.value.length);
    const before = new InputEvent("beforeinput", {
      bubbles: true,
      inputType: "insertReplacementText",
      data: "’",
    });
    Object.defineProperty(before, "getTargetRanges", {
      value: () => [target],
    });
    fireEvent(input, before);
    text.replaceData(quote, 1, "’");
    fireEvent.input(input, {
      inputType: "insertReplacementText",
      data: "’",
    });
    expect(input).toHaveValue("@Honey can you see this is’s");
    expect(
      within(input).getByRole("img", { name: "Person Honey" }),
    ).toBeVisible();
    h.submit();
    expect(
      (root ? h.messages.reply : h.messages.send).mock.calls[0]?.at(-1),
    ).toEqual([first.pubkey]);
  },
);

it("qualifies both namesakes retroactively without changing source and removes qualifiers with ambiguity", () => {
  const h = mount();
  act(() => {
    h.commands().insertMention(first);
  });
  expect(
    within(h.input()).getByRole("img", { name: "Person Honey" }),
  ).toBeVisible();
  act(() => {
    h.commands().insertMention(first);
  });
  expect(h.input().textContent).not.toContain("npub");
  act(() => {
    h.commands().insertMention({ ...second, name: "honey" });
  });
  expect(h.input()).toHaveValue("@Honey @Honey @honey ");
  expect(
    within(h.input()).getAllByRole("img", {
      name: "Person Honey, public key ending c a j",
    }),
  ).toHaveLength(2);
  expect(
    within(h.input()).getByRole("img", {
      name: "Person honey, public key ending 4 h u",
    }),
  ).toHaveTextContent("honey · npub…4hu");
  h.input().setSelectionRange(14, 20);
  act(() => {
    h.commands().insertText("");
  });
  expect(h.input()).toHaveValue("@Honey @Honey  ");
  expect(h.input().textContent).not.toContain("npub");
  h.submit();
  expect(h.messages.send).toHaveBeenCalledWith("channel", "@Honey @Honey  ", [
    first.pubkey,
    first.pubkey,
  ]);
});

it.each([0, 7])(
  "does not replay qualifier motion after removing at %i or restoring a destination draft",
  (start) => {
    const h = mount();
    act(() => {
      h.commands().insertMention(first);
    });
    act(() => {
      h.commands().insertMention(second);
    });
    expect(h.input().querySelectorAll("[data-reveal]")).toHaveLength(1);
    h.input().setSelectionRange(start, start + 6);
    act(() => {
      h.commands().insertText("");
    });
    act(() => {
      h.commands().insertMention(start === 0 ? first : second);
    });
    expect(h.input().querySelectorAll("[data-reveal]")).toHaveLength(0);
    h.retarget({ channelId: "other" });
    act(() => {
      h.commands().insertMention(first);
    });
    h.retarget({ channelId: "channel" });
    expect(h.input().querySelectorAll(".inline-chip-qualifier")).toHaveLength(
      2,
    );
    expect(h.input().querySelectorAll("[data-reveal]")).toHaveLength(0);
  },
);

it("replacing an inline mention with ordinary prose removes notification intent", async () => {
  const h = mount();
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  h.fill("no recipient now");
  h.submit();
  expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual([]);
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  expect(
    within(h.input()).getByRole("img", { name: "Person Honey" }),
  ).toBeVisible();
  h.input().setSelectionRange(0, 6);
  act(() => {
    h.commands().insertText("Honey");
  });
  expect(within(h.input()).queryByRole("img")).not.toBeInTheDocument();
  h.submit();
  expect(h.messages.send.mock.calls[1]?.at(-1)).toEqual([]);
});

it("ambiguous namesake replacement cannot notify the wrong remaining identity", async () => {
  const h = mount();
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  await h.user.click(screen.getByRole("button", { name: "Second Honey" }));
  h.fill("@Honey help");
  h.submit();
  expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual([]);
});

it("serializes tool commands in one React batch and rejects malformed recipients", () => {
  const h = mount();
  h.fill("Hi ");
  act(() => {
    const { insertText, insertMention } = h.commands();
    expect(insertText("there ")).toBe(true);
    expect(insertMention(first)).toBe(true);
    expect(insertText("and ")).toBe(true);
    expect(insertMention(second)).toBe(true);
    expect(insertMention({ pubkey: "wrong", name: "Honey" })).toBe(false);
    expect(insertMention({ ...first, name: "  " })).toBe(false);
    expect(insertMention(null as unknown as typeof first)).toBe(false);
  });
  h.submit();
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "Hi there @Honey and @Honey ",
    [first.pubkey, second.pubkey],
  );
});

it("revokes captured tool commands after retargeting, disabling and unmounting", () => {
  const h = mount();
  h.fill("channel draft");
  const channel = h.commands();
  h.retarget({ threadRootId: "root" });
  act(() => {
    expect(channel.insertText("stale")).toBe(false);
    expect(channel.insertMention(first)).toBe(false);
  });
  expect(h.input()).toHaveValue("");
  const thread = h.commands();
  h.retarget({ disabled: true });
  act(() => {
    expect(thread.insertText("disabled")).toBe(false);
  });
  h.retarget({ disabled: false });
  act(() => {
    expect(h.commands().insertText("current")).toBe(true);
  });
  expect(h.input()).toHaveValue("current");
  const current = h.commands();
  h.unmount();
  act(() => {
    expect(current.insertText("unmounted")).toBe(false);
  });
});

it("keeps custom emoji text readable and sends repeated shortcodes unchanged", () => {
  const h = mount();
  h.setEmoji([{ shortcode: "party", url: "https://emoji.test/party.png" }]);
  act(() => {
    expect(h.commands().insertText(":party:")).toBe(true);
  });
  expect(h.input()).toHaveValue(":party:");
  expect(h.input()).toHaveAttribute("data-single-emoji", "true");
  act(() => {
    expect(h.commands().insertText(":party:")).toBe(true);
  });
  expect(h.input()).toHaveValue(":party::party:");
  expect(h.container.querySelectorAll("img")).toHaveLength(2);
  h.submit();
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    ":party::party:",
    [],
  );
});

it("renders a leading custom emoji inline without changing trailing text", () => {
  const h = mount();
  h.setEmoji([{ shortcode: "bufo", url: "https://emoji.test/bufo.png" }]);
  h.fill(":bufo:lakjsdlkjflakjsdf");
  expect(h.input()).not.toHaveAttribute("data-single-emoji");
  expect(h.input()).toHaveValue(":bufo:lakjsdlkjflakjsdf");
  expect(h.container.querySelectorAll("img")).toHaveLength(1);
  h.submit();
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    ":bufo:lakjsdlkjflakjsdf",
    [],
  );
});

it("rejects overlong and over-limit tool edits without changing accepted intent", () => {
  const h = mount();
  h.fill("x".repeat(15999));
  act(() => {
    expect(h.commands().insertMention(first)).toBe(false);
  });
  expect(h.input()).toHaveValue("x".repeat(15999));
  expect(screen.getByRole("alert")).toHaveTextContent("too long");
  h.fill("");
  act(() => {
    for (let i = 0; i < 32; i++)
      expect(h.commands().insertMention(first)).toBe(true);
  });
  const before = h.input().value;
  act(() => {
    expect(h.commands().insertMention(first)).toBe(false);
  });
  expect(h.input()).toHaveValue(before);
  expect(screen.getByRole("alert")).toHaveTextContent("at most 32 recipients");
});

// The production composer must perform enrollment, not a pre-populated test roster.
for (const threadRootId of [undefined, "f".repeat(64)])
  it(`adds a selected local agent only on Send, then sends after membership confirmation (thread=${!!threadRootId})`, async () => {
    const f = controlFixture();
    f.agent.pubkey = first.pubkey;
    const control = createAgentControl(f.host);
    await control.refresh();
    const h = mount(
      {
        scope: `https://relay.example.test:${"d".repeat(64)}`,
        ...(threadRootId ? { threadRootId } : {}),
      },
      control,
    );
    const channel = {
      id: "channel",
      name: "General",
      channelType: "stream" as const,
      members: ["d".repeat(64)],
    };
    const listeners = new Set<() => void>();
    // A Sessions parent invitation is a different operation, even for the same recipient.
    const invitation: OutgoingEvent = {
      delivery: "failed",
      event: {
        id: "c".repeat(64),
        pubkey: "d".repeat(64),
        kind: 9000,
        content: "",
        created_at: Math.floor(Date.now() / 1000) - 16 * 60,
        tags: [
          ["h", "channel"],
          ["p", first.pubkey],
        ],
      },
    };
    let operations: readonly OutgoingEvent[] = [invitation];
    const retry = vi.fn();
    const add = vi.fn((input) => {
      operations = [
        {
          event: {
            ...input,
            pubkey: "d".repeat(64),
            id: "e".repeat(64),
            created_at: 1,
          },
          delivery: "sending",
        },
      ];
      return "e".repeat(64);
    });
    const list = { status: "ready", channels: [channel] };
    Object.assign(h.session, {
      channels: { list: () => list, subscribeList: () => () => {} },
      read: vi.fn(async () => {
        if (operations[0]?.delivery === "accepted")
          channel.members = [...channel.members, first.pubkey];
        return [];
      }),
      outbox: {
        supports: () => true,
        send: add,
        retry,
        snapshot: () => operations,
        subscribe: (fn: () => void) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      },
    });
    try {
      fireEvent.click(screen.getByRole("button", { name: "First Honey" }));
      expect(add).not.toHaveBeenCalled();
      fireEvent.submit(screen.getByRole("form"));
      await act(async () => {});
      expect(add).toHaveBeenCalledWith({
        kind: 9000,
        content: "",
        tags: [
          ["h", "channel"],
          ["p", first.pubkey],
          ["role", "bot"],
        ],
      });
      expect(h.messages.send).not.toHaveBeenCalled();
      expect(h.messages.reply).not.toHaveBeenCalled();
      await act(async () => {
        operations = operations.map((item) => ({
          ...item,
          delivery: "accepted",
        }));
        for (const listener of listeners) listener();
      });
      const send = threadRootId ? h.messages.reply : h.messages.send;
      expect(send).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
      expect(send.mock.calls[0]?.at(-1)).toEqual([first.pubkey]);
      // Native evidence now shares the ordinary remember-agent classification.
      expect(h.input().value).toBe("@Honey ");
    } finally {
      control.dispose();
    }
  });

it.each([false, true])(
  "keeps the selected draft on an enrollment error (expired=%s) without sending the message",
  async (expired) => {
    const f = controlFixture();
    f.agent.pubkey = first.pubkey;
    const control = createAgentControl(f.host);
    await control.refresh();
    const h = mount(
      { scope: `https://relay.example.test:${"d".repeat(64)}` },
      control,
    );
    const add = vi.fn(() => {
      throw new Error("Cannot add agent");
    });
    const list = {
      status: "ready",
      channels: [
        { id: "channel", channelType: "stream", members: ["d".repeat(64)] },
      ],
    };
    const operations = expired
      ? [
          {
            delivery: "failed",
            event: {
              id: "e".repeat(64),
              kind: 9000,
              created_at: Math.floor(Date.now() / 1000) - 16 * 60,
              tags: [
                ["h", "channel"],
                ["p", first.pubkey],
                ["role", "bot"],
              ],
            },
          },
        ]
      : [];
    Object.assign(h.session, {
      channels: { list: () => list, subscribeList: () => () => {} },
      read: async () => [],
      outbox: { supports: () => true, send: add, snapshot: () => operations },
    });
    try {
      fireEvent.click(screen.getByRole("button", { name: "First Honey" }));
      fireEvent.submit(screen.getByRole("form"));
      await act(async () => {});
      expect(screen.getByRole("alert")).toHaveTextContent(
        expired ? "Open Outbox" : "Cannot add agent",
      );
      expect(h.input().value).toBe("@Honey ");
      expect(h.messages.send).not.toHaveBeenCalled();
      if (expired) expect(add).not.toHaveBeenCalled();
      expect(h.input()).not.toHaveAttribute("aria-disabled", "true");
    } finally {
      control.dispose();
    }
  },
);

it.each(
  ["send", "unmount", "disabled", "denied"].flatMap((outcome) =>
    ["mention", "avatar"].flatMap((recipient) =>
      [true, false].map((parent) => ({
        outcome,
        recipient,
        parent,
      })),
    ),
  ),
)(
  "waits for agent admission before saved session messages: $recipient / $outcome / parent=$parent",
  async ({ outcome, recipient, parent }) => {
    const view = mount();
    const list = {
      status: "ready",
      channels: [
        {
          id: "channel",
          channelType: "session",
          ...(parent ? { parentChannelId: "parent" } : {}),
          members: [] as string[],
        },
      ],
    };
    const library = { status: "ready", definitions: [], identities: [first] };
    let release = () => {};
    const addAgents = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          release = () => {
            if (outcome === "denied") reject(new Error("Cannot add agents"));
            else {
              list.channels[0]?.members.push(first.pubkey);
              resolve();
            }
          };
        }),
    );
    const session = {
      ...view.session,
      channels: { list: () => list, subscribeList: () => () => {} },
      agentLibrary: {
        snapshot: () => library,
        subscribe: () => () => {},
        refresh: async () => {},
        retain: () => () => {},
      },
      workSessions: {
        addAgents,
        refreshMembership: vi.fn(async () => list.channels[0]),
      },
    } as unknown as RelaySession;
    view.retarget({ session, sessionConversation: true });
    expect(view.commands().inviteAgents).toBe(true);
    if (recipient === "mention") {
      await view.user.click(
        screen.getByRole("button", { name: "First Honey" }),
      );
    } else {
      await view.user.type(view.input(), "Hello Honey");
      await view.user.click(
        screen.getByRole("button", { name: "Choose an agent" }),
      );
      await view.user.click(
        await screen.findByRole("menuitemradio", {
          name: parent
            ? "Honey — adds to session and channel"
            : "Honey — adds to session",
        }),
      );
    }
    expect(addAgents).not.toHaveBeenCalled();
    expect(session.workSessions.refreshMembership).not.toHaveBeenCalled();
    expect(view.messages.send).not.toHaveBeenCalled();
    view.submit();
    await waitFor(() =>
      expect(addAgents).toHaveBeenCalledWith(
        "channel",
        [first.pubkey],
        expect.any(Function),
      ),
    );
    expect(view.messages.send).not.toHaveBeenCalled();
    if (outcome === "unmount") view.unmount();
    if (outcome === "disabled") view.retarget({ disabled: true });
    await act(async () => release());
    if (outcome === "send") {
      await waitFor(() => expect(view.messages.send).toHaveBeenCalledOnce());
      expect(addAgents).toHaveBeenCalledOnce();
    } else expect(view.messages.send).not.toHaveBeenCalled();
    if (outcome === "denied") {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Cannot add agents",
      );
      expect(view.input()).toHaveTextContent("Honey");
    }
  },
);

it.each(
  [undefined, "root"].flatMap((root) =>
    [false, true].map((removeMention) => ({ root, removeMention })),
  ),
)(
  "resolves a sole session agent before send/reply: root=$root, removed=$removeMention",
  async ({ root, removeMention }) => {
    const view = mount();
    const channel = {
      id: "channel",
      channelType: "session" as const,
      members: [first.pubkey],
    };
    const list = { status: "ready" as const, channels: [channel] };
    const library = {
      status: "ready" as const,
      definitions: [],
      identities: [first],
    };
    const session = {
      ...view.session,
      viewer: "viewer",
      channels: { list: () => list, subscribeList: () => () => {} },
      agentLibrary: {
        snapshot: () => library,
        subscribe: () => () => {},
        refresh: vi.fn(async () => {}),
      },
      workSessions: {
        refreshMembership: vi.fn(async () => channel),
        addAgents: vi.fn(async () => {}),
      },
    } as unknown as RelaySession;
    view.retarget({
      session,
      sessionConversation: true,
      ...(root ? { threadRootId: root } : {}),
    });
    view.fill("Keep going ");
    if (removeMention) {
      await view.user.click(
        screen.getByRole("button", { name: "First Honey" }),
      );
      const remove = screen.getByRole("button", {
        name: `Remove mention Honey ${first.pubkey}`,
      });
      await view.user.hover(remove);
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        "Remove explicit mention of Honey (aaaaaaaa)",
      );
      await view.user.click(remove);
      expect(view.input()).toHaveValue("Keep going @Honey ");
      expect(view.input().querySelector(".inline-chip")).toBeNull();
      expect(
        screen.queryByRole("region", { name: "Explicit mentions" }),
      ).not.toBeInTheDocument();
    }
    view.submit();
    await waitFor(() =>
      expect(
        root ? view.messages.reply : view.messages.send,
      ).toHaveBeenCalled(),
    );
    if (root)
      expect(view.messages.reply).toHaveBeenCalledExactlyOnceWith(
        "channel",
        root,
        removeMention ? "Keep going @Honey " : "Keep going ",
        [first.pubkey],
      );
    else
      expect(view.messages.send).toHaveBeenCalledExactlyOnceWith(
        "channel",
        removeMention ? "Keep going @Honey " : "Keep going ",
        [first.pubkey],
      );
    expect(session.workSessions.addAgents).not.toHaveBeenCalled();
  },
);

it("routes to the avatar choice and lets an explicit mention override it", async () => {
  const view = mount();
  const library = {
    status: "ready",
    definitions: [],
    identities: [first, { ...second, name: "Fizz" }],
  };
  const list = {
    status: "ready",
    channels: [
      {
        id: "channel",
        channelType: "session",
        members: [first.pubkey, second.pubkey],
      },
    ],
  };
  const session = {
    ...view.session,
    channels: { list: () => list, subscribeList: () => () => {} },
    workSessions: {
      refreshMembership: vi.fn(async () => list.channels[0]),
      addAgents: vi.fn(async () => {}),
    },
    agentLibrary: {
      snapshot: () => library,
      subscribe: () => () => {},
      refresh: async () => {},
      retain: () => () => {},
    },
  } as unknown as RelaySession;
  view.retarget({ session, sessionConversation: true });
  await view.user.click(
    screen.getByRole("button", { name: "Choose an agent" }),
  );
  await view.user.click(
    await screen.findByRole("menuitemradio", { name: "Fizz" }),
  );
  await view.user.type(view.input(), "Hello");
  await view.user.keyboard("{Enter}");
  expect(view.messages.send).toHaveBeenLastCalledWith("channel", "Hello", [
    second.pubkey,
  ]);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Change agent: Fizz" }),
    ).toBeEnabled(),
  );
  await view.user.click(screen.getByRole("button", { name: "First Honey" }));
  view.submit();
  await waitFor(() =>
    expect(view.messages.send).toHaveBeenLastCalledWith(
      "channel",
      expect.any(String),
      [first.pubkey],
    ),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled(),
  );
  // The remembered explicit mention still overrides the picker until removed.
  expect(view.input()).toHaveValue("@Honey ");
  await view.user.click(
    screen.getByRole("button", {
      name: `Remove mention Honey ${first.pubkey}`,
    }),
  );
  expect(view.input()).toHaveValue("@Honey ");
  expect(view.input().querySelector(".inline-chip")).toBeNull();
  view.submit();
  await waitFor(() =>
    expect(view.messages.send).toHaveBeenLastCalledWith("channel", "@Honey ", [
      second.pubkey,
    ]),
  );
  expect(session.workSessions.addAgents).not.toHaveBeenCalled();
});

it.each(["ready", "failed", "unmounted"])(
  "refreshes cached membership before sending an existing mention: %s",
  async (outcome) => {
    const view = mount();
    const channel = {
      id: "channel",
      channelType: "session",
      members: [first.pubkey],
    };
    const list = { status: "ready", channels: [channel] };
    const library = { status: "ready", identities: [first] };
    let release = () => {};
    const refreshMembership = vi.fn(
      () =>
        new Promise<typeof channel>((resolve, reject) => {
          release = () =>
            outcome === "failed"
              ? reject(new Error("Could not refresh channel membership"))
              : resolve(channel);
        }),
    );
    const addAgents = vi.fn();
    const session = {
      ...view.session,
      channels: { list: () => list, subscribeList: () => () => {} },
      agentLibrary: { snapshot: () => library, subscribe: () => () => {} },
      workSessions: { refreshMembership, addAgents },
    } as unknown as RelaySession;
    view.retarget({ session, sessionConversation: true });
    await view.user.click(screen.getByRole("button", { name: "First Honey" }));
    view.submit();
    await waitFor(() =>
      expect(refreshMembership).toHaveBeenCalledWith("channel"),
    );
    expect(view.messages.send).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    if (outcome === "unmounted") view.unmount();
    await act(async () => release());
    expect(addAgents).not.toHaveBeenCalled();
    if (outcome === "ready") expect(view.messages.send).toHaveBeenCalledOnce();
    else expect(view.messages.send).not.toHaveBeenCalled();
    if (outcome === "failed") {
      expect(screen.getByRole("alert")).toHaveTextContent("Could not refresh");
      expect(view.input()).toHaveTextContent("Honey");
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled();
    }
  },
);

it("keeps retry submission available while a new-session draft is locked", () => {
  const submit = vi.fn();
  const h = mount({
    submission: {
      draftKey: "session-retry",
      initialDraft: "Keep this operation",
      locked: true,
      disabled: false,
      submit,
    },
  });
  expect(h.input()).toHaveAttribute("aria-disabled", "true");
  const send = screen.getByRole("button", { name: "Send message" });
  expect(send).toBeEnabled();
  fireEvent.click(send);
  expect(submit).toHaveBeenCalledWith({
    text: "Keep this operation",
    recipients: [],
  });
  expect(h.messages.send).not.toHaveBeenCalled();
});

it.each([undefined, "root"])(
  "prefills only exact selected agents after an accepted send in %s",
  (threadRootId) => {
    const h = mount(threadRootId ? { threadRootId } : {});
    vi.spyOn(h.session.profiles, "snapshot").mockReturnValue(
      new Map([[second.pubkey, { name: "Honey", isAgent: true }]]),
    );
    act(() => {
      h.commands().insertMention(first);
      h.commands().insertMention(second);
      h.commands().insertMention(second);
      h.commands().insertText("hello");
    });
    const send = threadRootId ? h.messages.reply : h.messages.send;
    send.mockImplementationOnce(() => {
      throw new Error("outbox full");
    });
    h.submit();
    expect(h.input()).toHaveValue("@Honey @Honey @Honey hello");
    h.submit();
    expect(send.mock.calls.at(-1)?.at(-1)).toEqual([
      first.pubkey,
      second.pubkey,
      second.pubkey,
    ]);
    expect(h.input()).toHaveValue("@Honey ");
    const recipients = screen.getByRole("region", {
      name: "Explicit mentions",
    });
    expect(within(recipients).getAllByRole("button")).toHaveLength(1);
    expect(
      within(recipients).getByRole("button", {
        name: `Remove mention Honey ${second.pubkey}`,
      }),
    ).toBeVisible();
    expect(
      within(h.input()).getAllByRole("img", { name: "Agent Honey" }),
    ).toHaveLength(1);
    expect(
      h.input().querySelector("button, a, [tabindex], [title]"),
    ).toBeNull();
    h.retarget({ channelId: "other" });
    expect(h.input()).toHaveValue("");
    h.retarget({ channelId: "channel" });
    expect(h.input()).toHaveValue("@Honey ");
    h.submit();
    expect(send.mock.calls.at(-1)?.at(-1)).toEqual([second.pubkey]);
    h.input().setSelectionRange(0, 6);
    act(() => {
      h.commands().insertText("Honey");
    });
    expect(h.input()).toHaveValue("Honey ");
    expect(within(h.input()).queryByRole("img")).not.toBeInTheDocument();
    h.submit();
    expect(send.mock.calls.at(-1)?.at(-1)).toEqual([]);
    expect(h.input()).toHaveValue("");
  },
);

it("opt-out changes future prefills, not the current draft, and re-enable revives nothing", () => {
  const h = mount();
  vi.spyOn(h.session.profiles, "snapshot").mockReturnValue(
    new Map([[second.pubkey, { name: "Honey", isAgent: true }]]),
  );
  act(() => {
    h.commands().insertMention(second);
  });
  h.submit();
  expect(h.input()).toHaveValue("@Honey ");
  setRememberAgentsPreference(false);
  expect(h.input()).toHaveValue("@Honey ");
  h.submit();
  expect(h.messages.send.mock.calls.at(-1)?.at(-1)).toEqual([second.pubkey]);
  expect(h.input()).toHaveValue("");
  setRememberAgentsPreference(true);
  expect(h.input()).toHaveValue("");
});

it.each([
  {},
  { threadRootId: "thread" },
  { threadRootId: "thread", mediaTimeSeconds: 12 },
])(
  "disables nonmember channel/thread/media composers and follows membership changes: %j",
  (destination) => {
    const h = mount(destination);
    const listeners = new Set<() => void>();
    let list: ReturnType<RelaySession["channels"]["list"]> = {
      status: "ready",
      channels: [],
    };
    h.retarget({
      session: {
        ...h.session,
        channels: {
          window: () => {
            throw new Error("Unused fixture window");
          },
          subscribeWindow: () => () => {},
          ensureList() {},
          ensure() {},
          loadOlder() {},
          list: () => list,
          get: () => ({ id: "channel", name: "Public", readOnly: true }),
          subscribeList: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        } as RelaySession["channels"],
      },
    });
    expect(h.input()).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(h.input(), { key: "Enter" });
    expect(h.messages.send).not.toHaveBeenCalled();
    expect(h.messages.reply).not.toHaveBeenCalled();
    act(() => {
      list = { status: "ready", channels: [{ id: "channel", name: "Joined" }] };
      for (const listener of listeners) listener();
    });
    expect(h.input()).not.toHaveAttribute("aria-disabled", "true");
    act(() => {
      list = { status: "ready", channels: [] };
      for (const listener of listeners) listener();
    });
    expect(h.input()).toHaveAttribute("aria-disabled", "true");
  },
);

it("keeps inline recipient identity and source stable through directory collision changes", async () => {
  const h = mount();
  const listeners = new Set<() => void>();
  let identities = [first, second];
  const provider = createAgentDirectory();
  const names = bindNames(
    {
      profiles: h.session.profiles,
      agentLibrary: {
        snapshot: () => ({ status: "ready", definitions: [], identities }),
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        refresh: async () => {},
        retain: () => () => {},
      },
    },
    { snapshot: () => [provider], subscribe: () => () => {} },
  );
  h.retarget({ session: { ...h.session, names } });
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  await h.user.click(screen.getByRole("button", { name: "Second Honey" }));
  const chips = () => within(h.input()).getAllByRole("img");
  const labels = () => chips().map((chip) => chip.textContent);
  expect(labels()).toEqual(["@Honey · npub…caj", "@Honey · npub…4hu"]);
  const source = h.input().value;
  act(() => {
    identities = [first, { ...second, name: "Renamed Honey" }];
    for (const notify of listeners) notify();
  });
  // Selected chips disclose authored recipients, independently of live directory labels.
  expect(names.resolve(second.pubkey)).toBe("Renamed Honey");
  expect(labels()).toEqual(["@Honey · npub…caj", "@Honey · npub…4hu"]);
  expect(h.input()).toHaveValue(source);
  act(() => {
    identities = [first, second];
    for (const notify of listeners) notify();
  });
  expect(names.lookup(first.pubkey)?.qualifier).toBeTruthy();
  expect(labels()).toEqual(["@Honey · npub…caj", "@Honey · npub…4hu"]);
  h.input().setSelectionRange(7, 13);
  act(() => h.commands().insertText(""));
  expect(labels()).toEqual(["@Honey"]);
  h.submit();
  expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual([first.pubkey]);
  h.unmount();
  names.dispose();
});

it.each([false, true])(
  "leaves removed-person rejection to the real session without enrolling anyone (mixed native=%s)",
  async (mixed) => {
    const viewer = keypair(),
      relay = keypair();
    const scope = `https://relay.example.test:${viewer.pubkey}`;
    const f = controlFixture();
    f.agent.pubkey = second.pubkey;
    const native = createAgentControl(f.host);
    await native.refresh();
    let members = [viewer.pubkey, first.pubkey];
    let time = 1700000000;
    const sign = vi.fn(async (template: EventTemplate) =>
      signed(viewer, template),
    );
    const publish = vi.fn(async () => {});
    const readLibrary = vi.fn(async () => ({
      definitions: [],
      identities: [],
    }));
    const owner = createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        scope: "https://relay.example.test",
        media: () => undefined,
        query: async (filters) =>
          filters.flatMap((filter) =>
            filter.kinds?.includes(39002)
              ? [roster(relay, "channel", members, time)]
              : filter.kinds?.includes(39000)
                ? [metadata(relay, "channel", "General")]
                : [],
          ),
        readAgentLibrary: readLibrary,
        writer: { kinds: [9, 9000], sign, publish },
      },
      { outboxStorage: { load: () => [], save() {} }, agentChoices: native },
    );
    const refresh = () =>
      owner.session.read(
        [
          { kinds: [39002], "#d": ["channel"], limit: 1 },
          { kinds: [39000], "#d": ["channel"], limit: 1 },
        ],
        { fresh: true },
      );
    await refresh();
    const h = mount({ session: owner.session, scope }, native);
    try {
      fireEvent.click(screen.getByRole("button", { name: "First Honey" }));
      if (mixed)
        fireEvent.click(screen.getByRole("button", { name: "Second Honey" }));
      const draft = h.input().value;
      members = [viewer.pubkey];
      time++;
      await act(refresh);
      // An ordinary removed recipient must reject synchronously. Awaiting an
      // async act here would hide a transient enrollment lock on the composer.
      h.submit();
      expect(h.input()).not.toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("alert")).toHaveTextContent(
        "no longer a channel member",
      );
      expect(h.input()).toHaveValue(draft);
      expect(sign).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(readLibrary).not.toHaveBeenCalled();
    } finally {
      h.unmount();
      owner.dispose();
      native.dispose();
    }
  },
);
