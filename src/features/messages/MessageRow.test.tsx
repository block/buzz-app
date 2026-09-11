import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageRow } from "./MessageRow";
import type { ChannelMessage } from "../relay/contracts";
import type { UnreadCapability, UnreadSnapshot } from "../relay/unread";

const row: ChannelMessage = {
  id: "root",
  channelId: "channel",
  authorId: "author",
  content: "Root",
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 23,
};
it.each([
  ["😀 🙏 👏 😄", [], true],
  ["😀".repeat(40), [], true],
  [
    ":party: ".repeat(24),
    [{ shortcode: "party", url: "https://emoji.test/party.png" }],
    true,
  ],
  [
    ":party: 😀 :party: 😀",
    [{ shortcode: "party", url: "https://emoji.test/party.png" }],
    true,
  ],
  ["😀 🙏 👏 😄 hello", [], false],
  [":unknown: 😀", [], false],
  ["  \n  ", [], false],
] as const)(
  "keeps emoji-only message size independent of count: %s",
  (content, emoji, large) => {
    const html = renderToStaticMarkup(
      <MessageRow
        row={{ ...row, content, emoji }}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    expect(html.includes('data-single-emoji="true"')).toBe(large);
  },
);
function render(
  patch: Partial<UnreadSnapshot>,
  replies = 23,
  clickable = true,
  threadRootId?: string,
) {
  const snapshot = vi.fn(() => ({
    observedCount: null,
    manual: "none",
    ...patch,
  }));
  const unread = { snapshot } as unknown as UnreadCapability;
  const html = renderToStaticMarkup(
    <MessageRow
      row={{ ...row, replyCount: replies, threadRootId }}
      unread={unread}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
      onOpenThread={clickable ? () => {} : undefined}
    />,
  );
  return { html, snapshot };
}
it("selects this thread, adds an accessible unread cue and preserves the total reply count", () => {
  const { html, snapshot } = render({ observedCount: 2 });
  expect(snapshot).toHaveBeenCalledExactlyOnceWith({
    kind: "thread",
    channelId: "channel",
    rootId: "root",
  });
  expect(html).toContain(
    'aria-label="View thread: 23 replies. Observed unread replies. Not an exact total."',
  );
  expect(html).toContain(
    'aria-hidden="true" title="Observed unread replies. Not an exact total."',
  );
  expect(html).toContain("23 replies</span>");
});
it.each([null, 0])(
  "omits the dot for %s observed replies, not a fabricated unread total",
  (observedCount) => {
    const { html } = render({ observedCount });
    expect(html).toContain('aria-label="View thread: 23 replies"');
    expect(html).not.toContain("title=");
  },
);
it("describes local manual intent and stale evidence honestly", () => {
  expect(render({ manual: "local-only", observedCount: 0 }).html).toContain(
    "Thread marked unread on this device only",
  );
  expect(render({ manual: "remote", observedCount: 0 }).html).toContain(
    "Thread marked unread",
  );
  expect(render({ observedCount: 1, freshness: "stale" }).html).toContain(
    "Observed unread replies; may be out of date",
  );
});
it("does not select unread for rows without a thread button", () => {
  expect(render({}, 0).snapshot).not.toHaveBeenCalled();
  expect(render({}, 23, false).snapshot).not.toHaveBeenCalled();
});

it("selects the opening root for a broadcast reply instead of its own row ID", () => {
  const { snapshot } = render({ observedCount: 1 }, 23, true, "original-root");
  expect(snapshot).toHaveBeenCalledExactlyOnceWith({
    kind: "thread",
    channelId: "channel",
    rootId: "original-root",
  });
});
