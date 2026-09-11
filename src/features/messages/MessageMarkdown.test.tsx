import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MessageMarkdown, safeMessageUrl } from "./MessageMarkdown";
import type { ChannelMessage } from "../relay/contracts";

function render(
  content: string,
  {
    emoji = [] as { shortcode: string; url: string }[],
    media = (_url: string) => undefined as string | undefined,
  } = {},
) {
  return renderToStaticMarkup(
    <MessageMarkdown
      row={
        {
          id: "message",
          channelId: "channel",
          authorId: "author",
          content,
          createdAt: 1,
          mentions: [],
          participants: [],
          attachments: [],
          reactions: [],
          replyCount: 0,
          emoji,
        } satisfies ChannelMessage
      }
      media={media}
      onOpenLink={() => false}
    />,
  );
}

describe("MessageMarkdown", () => {
  it("renders compact CommonMark and GFM structure with chat line breaks", () => {
    const html = render(`# Heading
first
second

- one
- two

~~done~~

> quote

| A | B |
| - | - |
| 1 | 2 |

- [x] checked`);
    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("first<br/>\nsecond");
    expect(html).toContain("<ul>");
    expect(html).toContain("<del>done</del>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox" disabled="" checked=""');
  });

  it("renders inline and fenced code without parsing markdown inside it", () => {
    const html = render("`**literal** :party:`\n\n```ts\nconst x = 1\n```");
    expect(html).toContain("<code>**literal** :party:</code>");
    expect(html).toContain('<code class="language-ts">const x = 1');
    expect(html).not.toContain("<strong>literal</strong>");
  });

  it("keeps raw HTML inert and never renders markdown images", () => {
    const html = render(
      '<script>alert("x")</script>\n\nbefore <b>raw</b> ![remote alt](https://images.test/a.png)',
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<img");
    expect(html).toContain("remote alt");
  });

  it("allows credential-free HTTPS links and makes other destinations non-clickable", () => {
    expect(safeMessageUrl("https://example.com/path?q=1")).toBe(
      "https://example.com/path?q=1",
    );
    for (const url of [
      "http://example.com",
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///tmp/x",
      "/relative",
      "https://user:secret@example.com",
    ])
      expect(safeMessageUrl(url)).toBeUndefined();

    const safe = render("[Example](https://example.com/path)");
    expect(safe).toContain('href="https://example.com/path"');
    expect(safe).toContain('target="_blank"');
    expect(safe).toContain('rel="noopener noreferrer"');
    expect(safe).toContain('title="https://example.com/path"');

    const unsafe = render("[bad](javascript:alert(1)) [local](/relative)");
    expect(unsafe).not.toContain("<a");
    expect(unsafe).toContain("bad");
    expect(unsafe).toContain("local");
  });

  it("renders known event-local emoji through media, except in links and code", () => {
    const media = vi.fn(() => "https://media.test/party.png");
    const html = render(
      ":party: `:party:` [:party:](https://example.com/:party:)",
      {
        emoji: [{ shortcode: "party", url: "https://source.test/party.png" }],
        media,
      },
    );
    expect(html.match(/<img/g)).toHaveLength(1);
    expect(html).toContain('alt=":party:"');
    expect(html).toContain("<code>:party:</code>");
    expect(html).toContain(">:party:</a>");
    expect(media).toHaveBeenCalledWith("https://source.test/party.png");
  });

  it("falls back to literal text for exceptionally large inbound content", () => {
    const html = render(`${"a".repeat(100_001)} **not parsed**`);
    expect(html).toContain("**not parsed**");
    expect(html).not.toContain("<strong>");
  });
});
