import { expect, it } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { replyTree } from "./reply-tree";
import {
  continuesMessageGroup,
  publicMessageNeighbor,
  responseAvatarAnchors,
} from "./message-grouping";

const first: ChannelMessage = {
  id: "first",
  channelId: "channel",
  authorId: "author",
  content: "Hello",
  createdAt: new Date(2026, 8, 28, 12).getTime() / 1000,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
};

it("assigns response playback only to the joined group's visible anchors", () => {
  const rows = [
    { ...first, id: "history" },
    { ...first, id: "request", authorId: "human" },
    first,
    { ...first, id: "last" },
  ];
  expect([...responseAvatarAnchors(rows, first.authorId)]).toEqual([
    "first",
    "last",
  ]);
  expect([...responseAvatarAnchors(rows, undefined)]).toEqual([]);
  expect([...responseAvatarAnchors(rows, "other")]).toEqual([]);
  expect([
    ...responseAvatarAnchors(
      [...rows, { ...first, id: "new-request", authorId: "human" }],
      first.authorId,
    ),
  ]).toEqual([]);
  expect([
    ...responseAvatarAnchors(
      [first, { ...first, id: "reply", threadRootId: first.id }],
      first.authorId,
    ),
  ]).toEqual(["reply"]);
});

it("keeps nested response ownership separate from the parent avatar", () => {
  const parent = { ...first, threadRootId: "root" };
  const nested = { ...parent, id: "nested", replyParentId: parent.id };
  const deeper = { ...nested, id: "deeper", replyParentId: nested.id };
  for (const rows of [
    [parent, nested],
    [parent, nested, deeper],
  ]) {
    const tree = replyTree(rows, "root");
    const anchors = responseAvatarAnchors(
      rows,
      first.authorId,
      (previous, current) =>
        tree.parents.get(previous.id) === tree.parents.get(current.id) &&
        !tree.children.get(previous.id)?.length &&
        continuesMessageGroup(previous, current),
    );
    expect([...anchors]).toEqual(
      rows.length === 2 ? ["nested"] : ["nested", "deeper"],
    );
  }
});

it("groups adjacent same-author messages through the five-minute boundary", () => {
  for (const seconds of [0, 1, 299, 300]) {
    expect(
      continuesMessageGroup(first, {
        ...first,
        id: "next",
        createdAt: first.createdAt + seconds,
      }),
    ).toBe(true);
  }
});
it("breaks groups at missing history, author/channel changes, time gaps and reversed time", () => {
  expect(continuesMessageGroup(undefined, first)).toBe(false);
  for (const change of [
    { authorId: "other" },
    { channelId: "other" },
    { createdAt: first.createdAt + 301 },
    { createdAt: first.createdAt - 1 },
  ]) {
    expect(continuesMessageGroup(first, { ...first, ...change })).toBe(false);
  }
});
it("breaks at local midnight even within five minutes", () => {
  const before = {
    ...first,
    createdAt: new Date(2026, 8, 28, 23, 59).getTime() / 1000,
  };
  expect(
    continuesMessageGroup(before, {
      ...first,
      createdAt: before.createdAt + 120,
    }),
  ).toBe(false);
});
it("keeps membership events separate on either side", () => {
  const membership = {
    ...first,
    membership: {} as NonNullable<ChannelMessage["membership"]>,
  };
  expect(continuesMessageGroup(first, membership)).toBe(false);
  expect(continuesMessageGroup(membership, first)).toBe(false);
});

it("keeps thread shares separate from adjacent authored messages", () => {
  const shared = { ...first, sentFromThread: { rootId: "a".repeat(64) } };
  expect(continuesMessageGroup(first, shared)).toBe(false);
  expect(continuesMessageGroup(shared, first)).toBe(false);
});

it("keeps a verified relayed message out of its signer's group", () => {
  const relayed = (verified: boolean) => ({
    ...first,
    id: "relayed",
    relayedFrom: { agent: "agent", verified },
  });
  expect(continuesMessageGroup(first, relayed(true))).toBe(false);
  expect(continuesMessageGroup(relayed(true), first)).toBe(false);
  // Unverified, it is the signer's ordinary message.
  expect(continuesMessageGroup(first, relayed(false))).toBe(true);
});

it("keeps automation bylines on every row, even for a common signer and owner", () => {
  const workflow = { ...first, workflowOwnerId: "owner" };
  expect(continuesMessageGroup(first, workflow)).toBe(false);
  expect(continuesMessageGroup(workflow, first)).toBe(false);
  expect(continuesMessageGroup(workflow, { ...workflow, id: "next" })).toBe(
    false,
  );
});

it("continues a reply into activity but starts the next public reply separately", () => {
  const activity = { ...first, id: "activity", audience: "agents" as const };
  expect(continuesMessageGroup(first, activity)).toBe(true);
  expect(continuesMessageGroup(activity, { ...activity, id: "next" })).toBe(
    true,
  );
  expect(continuesMessageGroup(activity, first)).toBe(false);
});

it.each([-1, 1] as const)(
  "does not bridge another author's visible activity in direction %s",
  (direction) => {
    const rows = [
      first,
      { ...first, id: "work", authorId: "agent", audience: "agents" as const },
      { ...first, id: "followup" },
    ];
    const index = direction === 1 ? 0 : 2;
    expect(publicMessageNeighbor(rows, index, direction)).toBeUndefined();
    rows[1] = { ...first, id: "work", audience: "agents" };
    expect(publicMessageNeighbor(rows, index, direction)?.id).toBe(
      direction === 1 ? "followup" : "first",
    );
  },
);
