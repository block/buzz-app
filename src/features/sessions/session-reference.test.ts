import { expect, it } from "vitest";
import { fromMarkdown } from "mdast-util-from-markdown";
import { parseTargetLink, targetLink } from "../navigation/targets";
import {
  sessionReference,
  referenceMarkdown,
  sessionReferenceTitle,
} from "./session-reference";
const scope = {
  viewer: "a".repeat(64),
  communityOrigin: "https://example.com",
};
const rootId = "b".repeat(64);
it("shares the same exact root without a viewer, tags, or new routing schema", () => {
  const reference = sessionReference(
    scope,
    "general",
    rootId,
    "  Fix\n the issue ",
  );
  expect(parseTargetLink(reference.href)).toEqual({
    version: 1,
    kind: "conversation",
    scope: { communityOrigin: scope.communityOrigin },
    channelId: "general",
    messageId: rootId,
    threadRootId: rootId,
  });
  expect(decodeURIComponent(reference.href)).not.toContain(scope.viewer);
  expect(reference.label).toBe("Session: Fix the issue");
});
it.each([
  "<script>alert(1)</script> [steal](https://evil.test) &copy;",
  "![x](a) *bold* `code` \\ [bracket]",
  "x".repeat(200),
  "",
])("roundtrips bounded plain text safely through Markdown: %s", (title) => {
  const reference = sessionReference(scope, "general", rootId, title);
  const markdown = referenceMarkdown(reference);
  const paragraph = fromMarkdown(markdown ?? "").children[0];
  expect(paragraph?.type).toBe("paragraph");
  if (paragraph?.type !== "paragraph") throw new Error("No paragraph");
  expect(paragraph.children).toHaveLength(1);
  const link = paragraph.children[0];
  expect(link?.type).toBe("link");
  if (link?.type !== "link") throw new Error("No link");
  expect(link.url).toBe(reference.href);
  expect(link.children).toEqual([
    { type: "text", value: reference.label, position: expect.anything() },
  ]);
  expect(reference.label.length).toBeLessThanOrEqual(169);
});
it("does not classify arbitrary links, legacy destinations or mismatched roots as session references", () => {
  for (const href of [
    "javascript:alert(1)",
    "https://example.com",
    `buzz://message?channel=c&id=${rootId}&thread=${rootId}`,
    targetLink({
      version: 1,
      kind: "conversation",
      scope,
      channelId: "general",
      messageId: rootId,
      threadRootId: "c".repeat(64),
    }),
  ]) {
    expect(referenceMarkdown({ href, label: "Session: Work" })).toBeUndefined();
    expect(sessionReferenceTitle(href, "Session: Work")).toBeUndefined();
  }
});
