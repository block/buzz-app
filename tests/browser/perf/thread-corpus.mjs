import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";

// The long-thread workload in docs/channels.md#targets: a weekly-update thread
// of 5,000 replies, ten times what the thread panel keeps loaded at once (10
// initial replies plus nine pages of 50). Text, timestamps and structure are
// fixed; keys are ephemeral. Bodies mix plain prose, Markdown lists, mentions
// and links, and their lengths follow a real long thread's top-level reply
// heights (median ~280px in a 580px pane).
export const THREAD_CHANNEL = "22222222-2222-4222-8222-222222222222";
export const THREAD_REPLIES = 5000;
/** Replies a full window holds at the newest end. */
export const THREAD_WINDOW = 460;

const topics = ["platform", "growth", "infra", "mobile", "design", "support"];
const items = [
  "shipped the onboarding flow",
  "paired with design on the empty states",
  "cleaned up the flaky upload tests",
  "reviewed the relay migration plan",
  "wrote the launch FAQ",
  "met three customers about billing",
  "drafted next quarter's roadmap",
  "moved the nightly job to the new queue",
  "profiled the search index rebuild",
  "closed out the accessibility audit",
];
const extra = [
  "It took longer than planned because the staging data was stale, so most of the week went to rebuilding fixtures before the real work could start.",
  "The surprising part was how much the retry path mattered once traffic doubled; the happy path barely moved.",
  "Next week is mostly follow-through: two reviews, one design session and the write-up for the wider group.",
];

// Reply i's body, opening with its 1-based position in the thread ("Message
// #142") so a reader can tell where they are. Every reply has a short heading
// and three to six items; one in three adds a longer paragraph, one in five a
// quote, one in seven is plain prose without Markdown.
export function threadBody(i, names) {
  const pick = (n) => items[(i * 7 + n * 3) % items.length];
  const mention = names[(i * 5) % names.length];
  if (i % 7 === 3)
    return [
      `Message #${i + 1}. Quick one from ${topics[i % topics.length]} this week.`,
      `Mostly ${pick(0)}, plus ${pick(1)}. Nothing blocked.`,
      extra[i % extra.length],
    ].join("\n\n");
  const count = 3 + (i % 4);
  const lines = [
    `**Message #${i + 1}** · Week 45 update from the ${topics[i % topics.length]} side`,
    "",
    `1. **Shipped:** ${pick(0)} and ${pick(1)} (see [the notes](https://example.com/notes/${i}))`,
    `2. **Learned:** ${pick(2)}; the \`retry()\` path mattered most`,
    `3. **Next:** ${pick(3)} with @${mention}`,
    ...(count > 3
      ? [
          `4. **Blockers:** ${i % 3 ? "none" : `waiting on @${names[(i + 3) % names.length]} for review`}`,
        ]
      : []),
    ...(count > 4 ? [`5. **Reading:** https://example.com/reading/${i}`] : []),
    ...(count > 5
      ? [`6. **Shoutout:** @${names[(i + 9) % names.length]}`]
      : []),
  ];
  if (i % 3 === 0) lines.push("", extra[i % extra.length]);
  if (i % 5 === 0) lines.push("", "> The numbers above are preliminary.");
  return lines.join("\n");
}

// Signing thousands of replies takes seconds, so each worker signs a corpus
// once and every sample serves the same frozen events.
const corpora = new Map();
function corpus(replies) {
  const cached = corpora.get(replies);
  if (cached) return cached;
  const authors = Array.from({ length: 40 }, () => generateSecretKey());
  const names = authors.map((_, i) => `Person ${i + 1}`);
  const root = finalizeEvent(
    {
      kind: 9,
      created_at: 1700000100,
      content: "Weekly updates thread",
      tags: [["h", THREAD_CHANNEL]],
    },
    authors[0],
  );
  const list = [];
  for (let i = 0; i < replies; i++) {
    const nested = i % 25 === 7 && list.length > 0;
    list.push(
      finalizeEvent(
        {
          kind: 9,
          created_at: root.created_at + 100 + i * 30,
          content: threadBody(i, names),
          tags: [
            ["h", THREAD_CHANNEL],
            ["p", getPublicKey(authors[(i * 5) % authors.length])],
            ...(nested
              ? [
                  ["e", root.id, "", "root"],
                  ["e", list.at(-1).id, "", "reply"],
                ]
              : [["e", root.id, "", "reply"]]),
          ],
        },
        authors[i % authors.length],
      ),
    );
  }
  const result = Object.freeze({
    authors,
    root: Object.freeze(root),
    replies: Object.freeze(list.map((event) => Object.freeze(event))),
  });
  corpora.set(replies, result);
  return result;
}

// Replace the fixture's strict-window thread (inboxThreadWindow) with the
// corpus. Every 25th reply answers the reply before it, forming a collapsed
// branch. Returns the root event.
export function populateThread(app, { replies = THREAD_REPLIES } = {}) {
  const { channelId } = app.inboxWindow;
  if (channelId !== THREAD_CHANNEL)
    throw new Error(`Thread corpus expects channel ${THREAD_CHANNEL}`);
  const { authors, root, replies: list } = corpus(replies);
  for (const [i, key] of authors.entries())
    app.serveProfile(key, { name: `Person ${i + 1}` });
  app.histories.set(`primary/${channelId}`, [root]);
  app.threadReplies.set(root.id, [...list]);
  app.inboxWindow.root = root;
  app.inboxWindow.replies = app.threadReplies.get(root.id);
  return root;
}
