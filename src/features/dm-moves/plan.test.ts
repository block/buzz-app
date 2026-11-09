import { expect, it } from "vitest";
import { keypair, message, signed } from "../relay/testing";
import { foldMessages } from "../relay/fold";
import { planMove, movedTemplate } from "./plan";
import {
  controlTemplate,
  moveControl,
  type MoveRequest,
  type MoveControl,
} from "./protocol";
import { validMessageTemplate } from "../../../browser-host/relay-broker.mjs";
import { attachmentMessage } from "../relay/attachments";
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
it("uses host-admitted direct and nested reply references for copied messages", () => {
  const [message] = planMove("dm", relay.pubkey, [root], req);
  if (!message) throw new Error("Missing source message");
  for (const parent of [root.id, child.id]) {
    const template = movedTemplate(req, message, root.id, parent);
    expect(validMessageTemplate({ ...template, created_at: 110 })).toBe(true);
    expect(template.tags.filter(([name]) => name === "e")).toEqual(
      parent === root.id
        ? [["e", root.id, "", "reply"]]
        : [
            ["e", root.id, "", "root"],
            ["e", parent, "", "reply"],
          ],
    );
  }
});
it("honors the inclusive scope and commit boundary", () => {
  const start = message(author, "dm", "Start here", 101);
  const plan = planMove(
    "dm",
    relay.pubkey,
    [root, start, child],
    { ...req, from: { id: start.id, ms: 101000 } },
    undefined,
    101000,
  );
  expect(plan.map((m) => m.original)).toEqual([start.id]);
  expect(plan[0]?.parent).toBeUndefined();
});
it.each([parent, child])(
  "rejects a thread reply as the starting message ($content)",
  (reply) => {
    expect(() =>
      planMove("dm", relay.pubkey, [root, parent, child], {
        ...req,
        from: { id: reply.id, ms: reply.created_at * 1000 },
      }),
    ).toThrow("Conversion cannot start from a thread reply");
  },
);
it("binds a partial range to its previewed message before consent", () => {
  expect(() =>
    planMove("dm", relay.pubkey, [root, parent, child], {
      ...req,
      from: { id: root.id, ms: 0 },
    }),
  ).toThrow("starting message could not be verified");
  const partial = { ...req, from: { id: root.id, ms: 100000 } };
  const later = message(author, "dm", "Later main-DM message", 103);
  expect(() => planMove("dm", relay.pubkey, [later], partial)).toThrow(
    "starting message could not be verified",
  );
  // A deletion after the approved commit keeps its already-bound time cutoff.
  expect(
    planMove("dm", relay.pubkey, [later], partial, undefined, 103000).map(
      (row) => row.original,
    ),
  ).toEqual([later.id]);
});
it("excludes completed and cancelled conversion notices, hidden controls and the current request", () => {
  const previousRequest = signed(author, {
    ...controlTemplate("dm", req),
    created_at: 103,
  });
  const nonce = "00000000-0000-4000-8000-000000000004";
  const previousRoot = "c".repeat(64);
  const previousControls: Exclude<MoveControl, MoveRequest>[] = [
    { type: "approve", move: req.move, worker: req.worker },
    { type: "probe", move: req.move, nonce },
    { type: "ready", move: req.move, nonce, worker: req.worker },
    { type: "commit", move: req.move, nonce, through: 107000 },
    { type: "go", move: req.move, nonce, root: previousRoot },
    { type: "done", move: req.move, worker: req.worker },
  ];
  const controls = previousControls.map((control, index) =>
    signed(author, {
      ...controlTemplate("dm", { ...control, request: previousRequest.id }),
      created_at: 104 + index,
    }),
  );
  expect(moveControl(previousRequest)).toBeDefined();
  for (const control of controls) expect(moveControl(control)).toBeDefined();
  const next: MoveRequest = {
    ...req,
    move: "00000000-0000-4000-8000-000000000003",
    target: "another-channel",
  };
  const cancelledRequest = signed(author, {
    ...controlTemplate("dm", {
      ...req,
      move: "00000000-0000-4000-8000-000000000005",
    }),
    created_at: 110,
  });
  const cancelled = signed(author, {
    ...controlTemplate("dm", {
      type: "cancel",
      move: "00000000-0000-4000-8000-000000000005",
      request: cancelledRequest.id,
    }),
    created_at: 111,
  });
  expect(moveControl(cancelledRequest)).toBeDefined();
  expect(moveControl(cancelled)).toBeDefined();
  const plan = planMove(
    "dm",
    relay.pubkey,
    [
      root,
      parent,
      child,
      previousRequest,
      ...controls,
      cancelledRequest,
      cancelled,
      signed(author, { ...controlTemplate("dm", next), created_at: 112 }),
    ],
    next,
  );
  expect(plan.map((m) => m.original)).toEqual([root.id, parent.id, child.id]);
  expect(plan[2]?.parent).toBe(parent.id);
});
it("preserves media and file metadata, including the latest edited attachment", () => {
  const origin = "https://community.test";
  const upload = (hash: string, type: string, name: string) => ({
    name,
    type,
    size: 100,
    sha256: hash.repeat(64),
    url: `${origin}/media/${hash.repeat(64)}`,
  });
  const photo = attachmentMessage(
    "Photo",
    [upload("a", "image/png", "Photo.png")],
    origin,
  );
  const document = attachmentMessage(
    "Updated file",
    [upload("b", "application/pdf", "Plan.pdf")],
    origin,
  );
  const original = message(author, "dm", photo.content, 100, photo.tags);
  const edit = signed(author, {
    kind: 40003,
    created_at: 101,
    content: document.content,
    tags: [["h", "dm"], ["e", original.id], ...document.tags],
  });
  for (const events of [[original], [original, edit]]) {
    const originalRows = foldMessages("dm", relay.pubkey, events, {
      includeReplies: true,
    });
    const [planned] = planMove("dm", relay.pubkey, events, req);
    if (!planned) throw new Error("Missing planned message");
    const template = movedTemplate(req, planned, root.id, root.id);
    expect(validMessageTemplate({ ...template, created_at: 110 })).toBe(true);
    const copied = signed(author, { ...template, created_at: 110 });
    const [copy] = foldMessages("target", relay.pubkey, [copied], {
      includeReplies: true,
    });
    expect(copy?.attachments).toEqual(originalRows[0]?.attachments);
    expect(copy?.attachments).toHaveLength(1);
    expect(copy?.sourceContent).toBe(
      events.length === 1 ? photo.content : document.content,
    );
    expect(copy?.content).toBe(originalRows[0]?.content);
  }
});

it("blocks rather than guessing an unseen deleted parent's position", () => {
  expect(() => planMove("dm", relay.pubkey, [root, child], req)).toThrow(
    "deleted reply",
  );
});
