import { expect, it } from "vitest";
import { keypair, message, signed } from "../relay/testing";
import { foldMessages } from "../relay/fold";
import { planMove, movedTemplate } from "./plan";
import type { MoveRequest } from "./protocol";
const author = keypair(),
  relay = keypair();
const req: MoveRequest = {
  type: "request",
  move: "00000000-0000-4000-8000-000000000001",
  worker: "00000000-0000-4000-8000-000000000002",
  target: "target",
  expires: 200,
  authors: [[author.pubkey, author.pubkey]],
};
const root = message(author, "dm", "Root", 100);
const parent = message(author, "dm", "Parent", 101, [
  ["e", root.id, "", "root"],
  ["e", root.id, "", "reply"],
]);
const child = message(author, "dm", "Child", 102, [
  ["e", root.id, "", "root"],
  ["e", parent.id, "", "reply"],
]);
it("copies the production edit/delete fold with actual authors and original ordering", () => {
  const edit = signed(author, {
    kind: 40003,
    created_at: 103,
    content: "Latest",
    tags: [
      ["h", "dm"],
      ["e", child.id],
    ],
  });
  const deletion = signed(author, {
    kind: 5,
    created_at: 104,
    content: "",
    tags: [
      ["h", "dm"],
      ["e", parent.id],
    ],
  });
  const plan = planMove(
    "dm",
    relay.pubkey,
    [child, parent, root, edit, deletion],
    req,
  );
  expect(plan.map((m) => [m.original, m.content, m.author])).toEqual([
    [root.id, "Root", author.pubkey],
    [child.id, "Latest", author.pubkey],
  ]);
  expect(plan[1]?.parent).toBe(root.id);
  const copied = signed(author, {
    ...movedTemplate(
      req,
      plan[1] as NonNullable<(typeof plan)[1]>,
      root.id,
      root.id,
    ),
    created_at: 110,
  });
  expect(copied.pubkey).toBe(author.pubkey);
  expect(
    foldMessages("target", relay.pubkey, [copied], { includeReplies: true })[0]
      ?.moved,
  ).toEqual({ move: req.move, original: child.id, ms: 102000 });
});
it("reattaches through a deleted row withheld by the relay using IDs only", () => {
  const plan = planMove(
    "dm",
    relay.pubkey,
    [root, child],
    req,
    undefined,
    Infinity,
    { [parent.id]: root.id },
  );
  expect(plan[1]?.parent).toBe(root.id);
  expect(() => planMove("dm", relay.pubkey, [child], req)).toThrow(
    "deleted reply",
  );
});
it("honors the inclusive scope and commit boundary", () => {
  const plan = planMove(
    "dm",
    relay.pubkey,
    [root, parent, child],
    { ...req, from: { id: parent.id, ms: 101000 } },
    undefined,
    101000,
  );
  expect(plan.map((m) => m.original)).toEqual([parent.id]);
  expect(plan[0]?.parent).toBeUndefined();
});
it("rejects attachments before target writes", () => {
  const media = message(author, "dm", "Photo", 100, [
    ["imeta", "url https://example.com/image.png", "m image/png"],
  ]);
  expect(() => planMove("dm", relay.pubkey, [media], req)).toThrow(
    "attachments",
  );
});

it("blocks rather than guessing an unseen deleted parent's position", () => {
  expect(() => planMove("dm", relay.pubkey, [root, child], req)).toThrow(
    "deleted reply",
  );
});
