// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import type { ThreadSnapshot, ThreadView } from "../relay/threads";
import type { ChannelMessage } from "../relay/contracts";
import { CARD_READERS, MessageLinkCards } from "./MessageLinkCards";
import { FOLD_AFTER } from "./LinkPreviews";
import { MessageMarkdown } from "./MessageMarkdown";
import { CustomEmoji } from "../../bundled/emoji/CustomEmoji";
import { emojiMatches } from "../relay/emoji";
import type {
  ConversationExtensions,
  InlineRenderer,
} from "../conversation/contracts";
import type { Contribution } from "../../plugins/contributions";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const id = (n: number) => n.toString(16).padStart(64, "a");
const link = (n: number) => `buzz://message?channel=general&id=${id(n)}`;
const message = (messageId: string, content?: string): ChannelMessage => ({
  id: messageId,
  channelId: "general",
  authorId: "b".repeat(64),
  content: content ?? `linked body ${messageId.slice(-2)}`,
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
  emoji: [{ shortcode: "rickroll", url: "https://example.com/rickroll.png" }],
});

const cards = (root: ParentNode = document) =>
  Array.from(root.querySelectorAll<HTMLElement>("[data-message-link-card]"));

const inlineRenderers: readonly Contribution<InlineRenderer>[] = [
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
      const emoji = content.message.emoji?.find(
        (entry) => `:${entry.shortcode}:` === text,
      );
      return emoji ? <CustomEmoji emoji={emoji} media={media} /> : text;
    },
  },
];
/** The linking conversation's renderers: custom emoji, as the bundled
 * plugin draws them from the message's own emoji. */
const extensions: ConversationExtensions = {
  tools: { snapshot: () => [], subscribe: () => () => {} },
  inline: {
    snapshot: () => inlineRenderers,
    subscribe: () => () => {},
  },
};

/** Renders a linked message as a row does, opening links with `onOpenLink`. */
const markdown =
  (onOpenLink: (url: string) => boolean = () => true) =>
  (row: ChannelMessage) => (
    <MessageMarkdown
      row={row}
      extensions={extensions}
      media={(url) => url}
      onOpenLink={onOpenLink}
    />
  );

/** A session whose exact reads find each linked message at once. */
function fakeSession(
  contents: Readonly<Record<string, string>> = {},
  reads = { pending: false },
) {
  const open = new Set<string>();
  const thread = vi.fn(
    (_channelId: string, messageId: string, _options?: unknown) => {
      open.add(messageId);
      const snapshot: ThreadSnapshot = {
        status: reads.pending ? "loading" : "ready",
        root: reads.pending
          ? undefined
          : message(messageId, contents[messageId]),
        replies: [],
        error: undefined,
        canLoadMore: false,
        limited: false,
      };
      return {
        snapshot: () => snapshot,
        subscribe: () => () => {},
        refresh: vi.fn(async () => {}),
        loadMore: vi.fn(async () => {}),
        retarget: vi.fn<ThreadView["retarget"]>(async () => "selected"),
        dispose: vi.fn(() => open.delete(messageId)),
      } satisfies ThreadView;
    },
  );
  const list = {
    status: "ready",
    channels: [{ id: "general", name: "General" }],
  };
  const profiles = new Map([["b".repeat(64), { name: "Avery" }]]);
  const session = {
    thread,
    profiles: {
      subscribe: () => () => {},
      snapshot: () => profiles,
      ensure: vi.fn(async () => {}),
    },
    channels: { subscribeList: () => () => {}, list: () => list },
    media: (url: string) => url,
  } as unknown as RelaySession;
  return { session, thread, open };
}

it("shows each linked message as a card that opens its link", () => {
  const { session, thread } = fakeSession({
    [id(1)]: "Ship **it** at [the docs](https://example.com/docs)",
  });
  const onOpenLink = vi.fn(() => true);
  render(
    <MessageLinkCards
      urls={[link(1)]}
      session={session}
      scope="community"
      onOpenLink={onOpenLink}
      renderMessage={markdown(onOpenLink)}
    />,
  );
  const [card] = cards();
  if (!card) throw new Error("no card");
  expect(card.textContent).toContain("Avery");
  expect(card.textContent).toContain("General");
  expect(thread).toHaveBeenCalledWith("general", id(1), {
    exact: true,
    priority: "background",
  });
  // The body renders as its row would: formatting and working links.
  const bold = screen.getByText("it");
  expect(bold.tagName).toBe("STRONG");
  fireEvent.click(screen.getByRole("link", { name: "the docs" }));
  expect(onOpenLink).toHaveBeenLastCalledWith("https://example.com/docs");
  expect(onOpenLink).toHaveBeenCalledTimes(1);
  // The time is the card's link, and its surface opens it too.
  const time = card.querySelector("time")?.closest("a");
  expect(time?.getAttribute("href")).toBe(link(1));
  expect(fireEvent.click(time as HTMLElement)).toBe(false);
  expect(onOpenLink).toHaveBeenLastCalledWith(link(1));
  fireEvent.click(bold);
  expect(onOpenLink).toHaveBeenCalledTimes(3);
  expect(onOpenLink).toHaveBeenLastCalledWith(link(1));
});

it("names a linked message's attachment when it has no other text", () => {
  const { session } = fakeSession({ [id(1)]: "" });
  render(
    <MessageLinkCards
      urls={[link(1)]}
      session={session}
      scope="community"
      onOpenLink={() => true}
      renderMessage={markdown()}
    />,
  );
  expect(cards()[0]?.textContent).toContain("Empty message");
});

it("renders a linked message's custom emoji", () => {
  const { session } = fakeSession({ [id(1)]: "Hovering over :rickroll: now" });
  render(
    <MessageLinkCards
      urls={[link(1)]}
      session={session}
      scope="community"
      onOpenLink={() => true}
      renderMessage={markdown()}
    />,
  );
  const emoji = cards()[0]?.querySelector("img");
  expect(emoji?.getAttribute("src")).toBe("https://example.com/rickroll.png");
  expect(cards()[0]?.textContent).not.toContain(":rickroll:");
});

it("shows a card's last read message at once when it remounts", () => {
  const reads = { pending: false };
  const { session } = fakeSession({ [id(9)]: "Seen **before**" }, reads);
  const card = (
    <MessageLinkCards
      urls={[link(9)]}
      session={session}
      scope="community"
      onOpenLink={() => true}
      renderMessage={markdown()}
    />
  );
  const first = render(card);
  expect(cards()[0]?.textContent).toContain("Seen before");
  first.unmount();
  // The next read is still on the way, as after a channel switch.
  reads.pending = true;
  render(card);
  expect(cards()[0]?.textContent).toContain("Seen before");
  expect(screen.queryByText("Loading message…")).toBeNull();
});

it("fills the cards about to be seen from one read before their own reads answer", async () => {
  const { session } = fakeSession({}, { pending: true });
  const read = vi.fn(async (filters: readonly { ids?: readonly string[] }[]) =>
    (filters[0]?.ids ?? []).map((messageId) => ({
      id: messageId,
      kind: 9,
      pubkey: "b".repeat(64),
      created_at: 1,
      content: `prefetched ${messageId.slice(-2)} ${link(20)}`,
      tags: [["h", "general"]],
    })),
  );
  Object.assign(session, { read });
  render(
    <MessageLinkCards
      urls={[11, 12, 13, 14].map(link)}
      session={session}
      scope="community"
      onOpenLink={() => true}
      renderMessage={markdown()}
    />,
  );
  await screen.findByText(/prefetched ad/);
  expect(cards().map((card) => card.textContent)).toEqual([
    expect.stringContaining("prefetched ab"),
    expect.stringContaining("prefetched ac"),
    expect.stringContaining("prefetched ad"),
  ]);
  // One read for the shown cards; the folded card and the linked messages'
  // own links wait.
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0]?.[0][0]?.ids).toEqual([11, 12, 13].map(id));
  expect(screen.queryByText("Loading message…")).toBeNull();
});

it("collapses a long linked message behind a button that doesn't open the card", () => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(900);
  const { session } = fakeSession({ [id(1)]: "A long message" });
  const onOpenLink = vi.fn(() => true);
  render(
    <MessageLinkCards
      urls={[link(1)]}
      session={session}
      scope="community"
      onOpenLink={onOpenLink}
      renderMessage={markdown(onOpenLink)}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Show full message" }));
  expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
  expect(onOpenLink).not.toHaveBeenCalled();
});

it("opens nothing from a card into a channel the reader can't see", () => {
  const { session, thread } = fakeSession();
  Object.assign(session.channels, {
    describe: () => ({ state: "withheld" }),
    refer: () => () => {},
  });
  const onOpenLink = vi.fn(() => true);
  render(
    <MessageLinkCards
      urls={[link(1)]}
      session={session}
      scope="community"
      onOpenLink={onOpenLink}
      renderMessage={markdown(onOpenLink)}
    />,
  );
  const [card] = cards();
  expect(card?.textContent).toContain("Private channel");
  expect(card?.textContent).not.toContain("Open link");
  fireEvent.click(card as HTMLElement);
  expect(onOpenLink).not.toHaveBeenCalled();
  expect(thread).not.toHaveBeenCalled();
});

it(`folds cards past ${FOLD_AFTER} behind one button`, () => {
  const { session } = fakeSession();
  render(
    <MessageLinkCards
      urls={[1, 2, 3, 4].map(link)}
      session={session}
      scope="community"
      onOpenLink={() => true}
      renderMessage={markdown()}
    />,
  );
  expect(cards()).toHaveLength(FOLD_AFTER);
  fireEvent.click(
    screen.getByRole("button", { name: "Show 1 more linked message" }),
  );
  expect(cards()).toHaveLength(4);
  fireEvent.click(
    screen.getByRole("button", { name: "Show fewer linked messages" }),
  );
  expect(cards()).toHaveLength(FOLD_AFTER);
});

it("keeps a linked message's spoilers hidden until revealed", () => {
  const { session } = fakeSession({
    [id(1)]: "The answer is ||forty-two|| and ||more||.",
  });
  const onOpenLink = vi.fn(() => true);
  render(
    <MessageLinkCards
      urls={[link(1)]}
      session={session}
      scope="community"
      onOpenLink={onOpenLink}
      renderMessage={markdown(onOpenLink)}
    />,
  );
  const reveal = screen.getAllByRole("button", { name: "Reveal spoiler" });
  expect(reveal).toHaveLength(2);
  expect(
    screen.getByText("forty-two").closest("[aria-hidden='true']"),
  ).toBeTruthy();
  // Revealing one is the spoiler's click, not the card's.
  fireEvent.click(reveal[0] as HTMLElement);
  expect(onOpenLink).not.toHaveBeenCalled();
});

it(`holds at most ${CARD_READERS} readers, and a waiting card reads once one frees`, () => {
  const { session, open } = fakeSession();
  const rows = Array.from({ length: CARD_READERS + 1 }, (_, n) => (
    <MessageLinkCards
      key={link(n + 1)}
      urls={[link(n + 1)]}
      session={session}
      scope="community"
      onOpenLink={() => true}
      renderMessage={markdown()}
    />
  ));
  const { rerender } = render(<>{rows}</>);
  expect(open.size).toBe(CARD_READERS);
  expect(open.has(id(CARD_READERS + 1))).toBe(false);
  // The waiting card keeps its place and says it's loading.
  const waiting = cards().at(-1);
  expect(waiting?.textContent).toBe("Loading message…");
  rerender(<>{rows.slice(1)}</>);
  expect(open.has(id(1))).toBe(false);
  expect(open.has(id(CARD_READERS + 1))).toBe(true);
  expect(cards().at(-1)?.textContent).toContain("linked body");
});

it("shows one card for links naming the same message, and says when a card can't open", () => {
  const { session } = fakeSession();
  render(
    <MessageLinkCards
      urls={[link(1), link(1).replace(id(1), id(1).toUpperCase())]}
      session={session}
      scope="community"
      onOpenLink={() => false}
      renderMessage={markdown()}
    />,
  );
  expect(cards()).toHaveLength(1);
  fireEvent.click(cards()[0] as HTMLElement);
  expect(
    screen.getByText("This Buzz link couldn’t be opened here."),
  ).toBeTruthy();
});
