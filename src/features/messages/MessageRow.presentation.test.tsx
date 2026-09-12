import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageRow, type MessagePresentation } from "./MessageRow";
import type { ChannelMessage } from "../relay/contracts";

const row: ChannelMessage = {
  id: "root",
  channelId: "alpha",
  authorId: "alice",
  createdAt: 1700000000,
  content: "Original excerpt https://example.com",
  mentions: [],
  attachments: [{ url: "https://example.com/image.png", video: false }],
  reactions: [{ content: "👍" }],
  replyCount: 2,
  participants: [],
};
function render(presentation: MessagePresentation = {}) {
  return renderToStaticMarkup(
    <MessageRow
      {...presentation}
      row={row}
      profile={{ name: "Alice" }}
      media={(url) => url}
      day={false}
      onOpenLink={() => false}
      onOpenThread={() => {}}
      retry={undefined}
      context={<span>#alpha</span>}
      footer={<button type="button">Open conversation</button>}
    />,
  );
}
it("keeps standard rows opt-out and original content/actions in both presentations", () => {
  for (const html of [render(), render({ presentation: "bubbles" })]) {
    expect(html).toContain("Original excerpt");
    expect(html).toContain('href="https://example.com/"');
    expect(html).toContain("Open image attachment");
    expect(html).toContain("👍");
    expect(html).toContain("View thread: 2 replies");
    expect(html).toContain("Open conversation");
    expect(html).toContain("#alpha");
  }
  expect(render()).not.toContain("data-direction");
});
it("uses explicit viewer identity for directional bubbles, never names or missing identity", () => {
  expect(render({ presentation: "bubbles" })).toContain(
    'data-direction="incoming"',
  );
  expect(render({ presentation: "bubbles", viewer: "Alice" })).toContain(
    'data-direction="incoming"',
  );
  expect(render({ presentation: "bubbles", viewer: "alice" })).toContain(
    'data-direction="outgoing"',
  );
});
