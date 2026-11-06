import { expect, test } from "vitest";
import {
  populateThread,
  threadBody,
  THREAD_CHANNEL,
  THREAD_REPLIES,
} from "./thread-corpus.mjs";

const names = Array.from({ length: 40 }, (_, i) => `Person ${i + 1}`);
const bodies = Array.from({ length: THREAD_REPLIES }, (_, i) =>
  threadBody(i, names),
);

// The shape at a size quick to sign; samples sign THREAD_REPLIES once per worker.
test("nests every 25th reply and signs a corpus once per worker", () => {
  const fixture = () => ({
    inboxWindow: {
      root: { id: "fixture" },
      replies: [],
      channelId: THREAD_CHANNEL,
    },
    histories: new Map(),
    threadReplies: new Map(),
    serveProfile() {},
  });
  const app = fixture();
  const root = populateThread(app, { replies: 100 });
  const replies = app.inboxWindow.replies;
  const nested = replies.filter((event) =>
    event.tags.some(([, , , marker]) => marker === "root"),
  );
  expect(replies).toHaveLength(100);
  expect(nested).toHaveLength(4);
  expect(replies.map((event) => event.content)).toEqual(bodies.slice(0, 100));
  expect(replies[41].content).toMatch(/^\*\*Message #42\*\*/);
  expect(app.histories.get(`primary/${THREAD_CHANNEL}`)).toEqual([root]);
  expect(app.threadReplies.get(root.id)).toBe(replies);
  expect(app.inboxWindow.root).toBe(root);
  // Another sample serves the same signed events without signing again.
  const again = fixture();
  expect(populateThread(again, { replies: 100 })).toBe(root);
  expect(again.inboxWindow.replies).toEqual(replies);
  expect(again.inboxWindow.replies).not.toBe(replies);
});

test("mixes plain prose, Markdown, mentions, links and quotes", () => {
  const share = (pattern) =>
    bodies.filter((body) => pattern.test(body)).length / bodies.length;
  expect(share(/^\*\*Message #\d+\*\* · Week 45 update/)).toBeGreaterThan(0.8);
  expect(share(/^Message #\d+\. Quick one/)).toBeGreaterThan(0.1);
  expect(share(/@Person \d+/)).toBeGreaterThan(0.8);
  expect(share(/https:\/\/example\.com\//)).toBeGreaterThan(0.8);
  expect(share(/^> /m)).toBeGreaterThan(0.15);
  expect(share(/`retry\(\)`/)).toBeGreaterThan(0.8);
});
