import { afterEach, expect, test, vi } from "vitest";
import { queryEvents } from "../../../tests/fixtures/finder-data";
import { createRelaySession } from "../../features/relay/session";
import {
  keypair,
  message,
  metadata,
  roster,
} from "../../features/relay/testing";
import { createCorpus } from "./corpus";
import { type ChannelSearchStatus, startFinderSync } from "./sync";

const viewer = keypair();
const author = keypair();
const relay = keypair();
// Ten real pages are necessary to prove the 5,000-message cap. Equal
// timestamps also prove that the cursor does not skip or repeat ties.
const history = Array.from({ length: 5001 }, (_, n) =>
  message(author, "crew", `Archive note ${n}`, 1_700_000_000),
);
const discovery = [
  metadata(relay, "crew", "crew"),
  roster(relay, "crew", [viewer.pubkey, author.pubkey]),
  metadata(relay, "lab", "lab"),
  roster(relay, "lab", [viewer.pubkey, author.pubkey]),
  // Readable but not joined: its messages stay out of the index.
  metadata(relay, "away", "away"),
  roster(relay, "away", [author.pubkey]),
];
const dispose: (() => void)[] = [];
afterEach(() => {
  for (const stop of dispose.splice(0)) stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture(
  messages = history,
  { warm, settle = true }: { warm?: () => string[]; settle?: boolean } = {},
) {
  const reads: Parameters<typeof queryEvents>[1][number][] = [];
  // Every channel-history read, by channel, never reset.
  const channelReads: Parameters<typeof queryEvents>[1][number][] = [];
  const control = { failures: 0, latency: 0 };
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    async query(filters) {
      for (const filter of filters) {
        if (filter["#h"]?.includes("crew") && filter.kinds?.includes(9))
          reads.push(filter);
        if (filter["#h"]?.length === 1 && filter.kinds?.includes(9))
          channelReads.push(filter);
      }
      if (
        filters.some(
          (filter) =>
            filter["#h"]?.includes("crew") && filter.kinds?.includes(9),
        ) &&
        control.failures > 0
      ) {
        control.failures--;
        throw new Error("History unavailable");
      }
      if (control.latency)
        await new Promise((resolve) => setTimeout(resolve, control.latency));
      return queryEvents([...discovery, ...messages], filters);
    },
  });
  dispose.push(owner.dispose);
  await owner.session.channels.ensureList();
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const corpus = createCorpus();
  const sync = startFinderSync({
    session: owner.session,
    corpus,
    changed() {},
    ...(warm && { warm }),
  });
  dispose.push(sync.dispose);
  if (settle) {
    // Complete the separate initial account fill before counting scope reads.
    await vi.advanceTimersByTimeAsync(1000);
    expect(sync.status().phase).toBe("ready");
    reads.length = 0;
  }
  return { corpus, sync, reads, channelReads, control };
}

test("reads ten pages, keeps its cursor and budget across edits and scope switches, and resumes on Keep going", async () => {
  const { corpus, sync, reads } = await fixture();
  let progress: ChannelSearchStatus | undefined;
  let query = "quartz";
  const opening = {};
  let reader = sync.searchChannel(
    "crew",
    () => corpus.search(query, 20, "crew").total < 20,
    (status) => {
      progress = status;
    },
    opening,
  );
  dispose.push(reader.dispose);
  await vi.advanceTimersByTimeAsync(300);
  expect(reads).toHaveLength(2);
  query = "missing";
  reader.wake();
  await vi.advanceTimersByTimeAsync(3000);
  expect(reads).toHaveLength(10);
  expect(corpus.size).toBe(5000);
  expect(progress).toMatchObject({
    capped: true,
    complete: false,
    loading: false,
    oldest: 1_700_000_000,
  });
  reader.dispose();
  reader = sync.searchChannel(
    "crew",
    () => true,
    (status) => {
      progress = status;
    },
    opening,
  );
  dispose.push(reader.dispose);
  await vi.advanceTimersByTimeAsync(1000);
  expect(reads).toHaveLength(10);
  expect(progress?.capped).toBe(true);
  reader.keepGoing();
  await vi.advanceTimersByTimeAsync(300);
  expect(reads).toHaveLength(11);
  expect(corpus.size).toBe(5001);
  expect(progress).toMatchObject({ complete: true, loading: false });
  reader.dispose();
  const reopened = sync.searchChannel(
    "crew",
    () => true,
    () => {},
  );
  dispose.push(reopened.dispose);
  await vi.advanceTimersByTimeAsync(1000);
  expect(reads).toHaveLength(11);
});

test("stops when enough match, cancels on close, and reopens at the next page", async () => {
  const { corpus, sync, reads } = await fixture(history.slice(0, 1001));
  let query = "archive";
  const reader = sync.searchChannel(
    "crew",
    () => corpus.search(query, 20, "crew").total < 20,
    () => {},
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(reads).toHaveLength(1);
  expect(corpus.size).toBe(500);
  await vi.advanceTimersByTimeAsync(1000);
  expect(reads).toHaveLength(1);
  query = "quartz";
  reader.wake();
  reader.dispose();
  await vi.advanceTimersByTimeAsync(1000);
  expect(reads).toHaveLength(1);
  let progress: ChannelSearchStatus | undefined;
  const reopened = sync.searchChannel(
    "crew",
    () => true,
    (status) => {
      progress = status;
    },
  );
  dispose.push(reopened.dispose);
  await vi.advanceTimersByTimeAsync(1000);
  expect(reads).toHaveLength(3);
  expect(corpus.size).toBe(1001);
  expect(progress?.complete).toBe(true);
});

test("retries the same older page with capped backoff and recovers without losing messages", async () => {
  const { corpus, sync, reads, control } = await fixture(history.slice(0, 501));
  let progress: ChannelSearchStatus | undefined;
  const reader = sync.searchChannel(
    "crew",
    () => true,
    (status) => {
      progress = status;
    },
  );
  dispose.push(reader.dispose);
  await vi.advanceTimersByTimeAsync(0);
  expect(corpus.size).toBe(500);
  control.failures = 7;
  await vi.advanceTimersByTimeAsync(300);
  expect(progress?.error).toBe(true);
  expect(reads).toHaveLength(2);
  const cursor = reads[1]?.before_id;
  for (const [index, delay] of [
    2000, 4000, 8000, 16000, 32000, 60000, 60000,
  ].entries()) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(reads).toHaveLength(index + 2);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toHaveLength(index + 3);
    expect(reads.at(-1)?.before_id).toBe(cursor);
  }
  expect(progress).toMatchObject({
    complete: true,
    error: false,
    loading: false,
  });
  expect(corpus.size).toBe(501);
});

test("reads ahead the newest pages of wanted channels and shares the cursor with This channel", async () => {
  const lab = Array.from({ length: 600 }, (_, n) =>
    message(author, "lab", `Lab note ${n}`, 1_700_000_000),
  );
  const away = [message(author, "away", "Away note", 1_700_000_000)];
  const crew = history.slice(0, 1400);
  const { corpus, sync, channelReads, control } = await fixture(
    [...crew, ...lab, ...away],
    { warm: () => ["away", "crew", "lab"], settle: false },
  );
  const of = (id: string) => channelReads.filter((f) => f["#h"]?.[0] === id);
  // The fill is done and the first read-ahead page is waiting on its pace.
  await vi.advanceTimersByTimeAsync(0);
  expect(sync.status().phase).toBe("ready");
  expect(channelReads).toHaveLength(0);
  // Slow pages keep This channel's first read open while the read-ahead
  // reaches the same channel.
  control.latency = 400;
  const reader = sync.searchChannel(
    "crew",
    () => true,
    () => {},
  );
  dispose.push(reader.dispose);
  await vi.advanceTimersByTimeAsync(20_000);
  // Three pages cover crew; no page was read twice or skipped.
  expect(of("crew")).toHaveLength(3);
  expect(new Set(of("crew").map((f) => f.before_id)).size).toBe(3);
  expect(corpus.search("note", 1, "crew").total).toBe(1400);
  // Lab gets its newest page only; away was never read.
  expect(of("lab")).toHaveLength(1);
  expect(of("away")).toHaveLength(0);
  expect(corpus.size).toBe(1900);
});

test("reads ahead one page in each of at most 16 channels", async () => {
  const ids = Array.from({ length: 18 }, (_, n) => `room${n}`);
  const rooms = ids.flatMap((id) => [
    metadata(relay, id, id),
    roster(relay, id, [viewer.pubkey, author.pubkey]),
    message(author, id, `${id} note`, 1_700_000_000),
  ]);
  const { channelReads } = await fixture(rooms, {
    warm: () => ids,
    settle: false,
  });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(channelReads.map((filter) => filter["#h"]?.[0])).toEqual(
    ids.slice(0, 16),
  );
});

test("reads ahead one page per channel", async () => {
  const { channelReads } = await fixture(history, {
    warm: () => ["crew"],
    settle: false,
  });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(channelReads).toHaveLength(1);
});
