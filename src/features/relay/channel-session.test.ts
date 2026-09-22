import { expect, it } from "vitest";
import { isQuietSessionRoot, quietSessionTag } from "./channel-session";
import { foldMessages } from "./fold";
import { keypair, signed } from "./testing";
const author = keypair(),
  relay = keypair();
it.each(
  [
    [],
    [["buzz-session", "2", "quiet"]],
    [["buzz-session", "1"]],
    [["buzz-session", "1", "quiet", "extra"]],
    [quietSessionTag(), quietSessionTag()],
    [quietSessionTag(), ["e", "a".repeat(64), "", "reply"]],
    [quietSessionTag(), ["e", "a".repeat(64)]],
    [quietSessionTag(), ["h", "other"]],
  ].map((tags) => ({ tags })),
)(
  "malformed/unknown/duplicate/root-invalid metadata stays ordinary: %j",
  ({ tags }) => {
    expect(isQuietSessionRoot({ kind: 9, tags: [["h", "c"], ...tags] })).toBe(
      false,
    );
  },
);
it("creator and teammate fold the original marker independently of edits and zero reply count", () => {
  const root = signed(author, {
    kind: 9,
    content: "prompt",
    tags: [["h", "c"], ["p", relay.pubkey], quietSessionTag()],
    created_at: 1,
  });
  const edit = signed(author, {
    kind: 40003,
    content: "revised",
    tags: [
      ["h", "c"],
      ["e", root.id],
    ],
    created_at: 2,
  });
  for (const events of [
    [root],
    [root, edit],
    JSON.parse(JSON.stringify([root, edit])),
  ]) {
    const row = foldMessages("c", relay.pubkey, events)[0];
    expect(row).toMatchObject({
      id: root.id,
      quietSession: true,
      replyCount: 0,
      mentions: [relay.pubkey],
    });
  }
  expect(isQuietSessionRoot({ ...root, kind: 40002 })).toBe(false);
  expect(isQuietSessionRoot({ ...root, tags: [quietSessionTag()] })).toBe(
    false,
  );
});
