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
];
const dispose: (() => void)[] = [];
afterEach(() => {
  for (const stop of dispose.splice(0)) stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture(messages = history) {
  const reads: Parameters<typeof queryEvents>[1][number][] = [];
  const control = { failures: 0 };
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    async query(filters) {
      for (const filter of filters)
        if (filter["#h"]?.includes("crew") && filter.kinds?.includes(9))
          reads.push(filter);
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
  });
  dispose.push(sync.dispose);
  // Complete the separate initial account fill before counting scope reads.
  await vi.advanceTimersByTimeAsync(1000);
  expect(sync.status().phase).toBe("ready");
  reads.length = 0;
  return { corpus, sync, reads, control };
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
