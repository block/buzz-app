// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveListener } from "../../features/relay/incoming";
import type { RelaySession } from "../../features/relay/session";
import { keypair, signed } from "../../features/relay/testing";
const agent = keypair();
import { createSubmissionUpdates } from "./submission-updates";
import { loadSubmissions, type SavedSubmission } from "./submissions";

vi.mock("./submissions", async (original) => ({
  ...(await original<typeof import("./submissions")>()),
  loadSubmissions: vi.fn(),
}));
const request = "11111111-1111-4111-8111-111111111111";
const row: SavedSubmission = {
  artifactId: "artifact",
  revision: "revision",
  value: {
    version: 2,
    pr: 1,
    submitter: "owner",
    device: "device",
    configRevision: "config",
    submittedAt: 100,
    config: {
      version: 1,
      repository: "example-org/project",
      reminderMinutes: 15,
      lanes: [
        {
          id: "ui",
          name: "UI",
          instructions: "Review",
          reviewers: [agent.pubkey],
        },
      ],
    },
    threads: [{ id: "root", request, delivered: true }],
  },
};
function report(status: string, sequence = 1) {
  return signed(agent, {
    created_at: 200 + sequence,
    kind: 9,
    content: "",
    tags: [
      ["h", "channel"],
      ["t", "buzz.review.status"],
      ["r", request],
      ["review", "artifact", "0"],
      ["e", "root", "", "reply"],
      ["status", status],
      ["review-sequence", String(sequence)],
    ],
  });
}
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.mocked(loadSubmissions)
    .mockReset()
    .mockResolvedValue({ rows: [row], warning: "" });
});
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function fixture(scope = "viewer-community", channel = "channel") {
  const listeners = new Set<LiveListener>();
  const session = {
    scope,
    subscribeLive: vi.fn((listener: LiveListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  } as unknown as RelaySession;
  const store = createSubmissionUpdates(session, channel);
  const stop = store.subscribe(vi.fn());
  cleanups.push(stop);
  return {
    store,
    session,
    stop,
    emit: (event: ReturnType<typeof report>) => {
      for (const listener of listeners) listener({ events: [event] });
    },
  };
}
it("shares one read, buffers live reports during loading, and persists explicit acknowledgment", async () => {
  let finish!: (value: Awaited<ReturnType<typeof loadSubmissions>>) => void;
  vi.mocked(loadSubmissions).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const f = fixture();
  cleanups.push(f.store.subscribe(vi.fn()));
  await vi.advanceTimersByTimeAsync(250);
  expect(loadSubmissions).toHaveBeenCalledTimes(1);
  expect(f.session.subscribeLive).toHaveBeenCalledTimes(1);
  f.emit(report("reviewing"));
  finish({ rows: [row], warning: "" });
  await vi.advanceTimersByTimeAsync(0);
  const accepted = firstRow(f.store);
  expect(accepted.reviewStates).toEqual(["reviewing"]);
  expect(f.store.unread(accepted)).toBe(true);
  f.store.markSeen(accepted);
  expect(f.store.unread(accepted)).toBe(false);
  f.emit(report("lgtm_not_approved", 2));
  const completed = firstRow(f.store);
  expect(completed.lastReviewedAt).toBe(202);
  expect(f.store.unread(completed)).toBe(true);
  f.store.markSeen(accepted);
  expect(f.store.unread(completed)).toBe(true);
  f.store.markSeen(completed);
  vi.mocked(loadSubmissions).mockResolvedValue({
    rows: [completed],
    warning: "",
  });
  const reopened = fixture();
  await vi.advanceTimersByTimeAsync(250);
  expect(reopened.store.unread(firstRow(reopened.store))).toBe(false);
  const otherViewer = fixture("another-viewer");
  await vi.advanceTimersByTimeAsync(250);
  expect(otherViewer.store.unread(firstRow(otherViewer.store))).toBe(true);
});
it("ignores unrelated and invalid reports and flags a reminder after acknowledgment", async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(250);
  expect(f.store.unread(firstRow(f.store))).toBe(false);
  f.emit({ ...report("approved"), pubkey: "other" });
  expect(f.store.unread(firstRow(f.store))).toBe(false);
  f.emit(report("lgtm_not_approved"));
  const completed = firstRow(f.store);
  f.store.markSeen(completed);
  vi.mocked(loadSubmissions).mockResolvedValue({
    rows: [
      {
        ...row,
        value: {
          ...row.value,
          threads: [
            {
              id: "root",
              request: "22222222-2222-4222-8222-222222222222",
              delivered: true,
            },
          ],
        },
      },
    ],
    warning: "",
  });
  f.store.reload();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.unread(firstRow(f.store))).toBe(true);
});
it("discards reads after access is lost and recovers on a fresh subscription", async () => {
  let finish!: (value: Awaited<ReturnType<typeof loadSubmissions>>) => void;
  vi.mocked(loadSubmissions).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const f = fixture();
  await vi.advanceTimersByTimeAsync(250);
  f.stop();
  finish({ rows: [row], warning: "" });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.snapshot().rows).toEqual([]);
  cleanups.push(f.store.subscribe(vi.fn()));
  await vi.advanceTimersByTimeAsync(250);
  expect(f.store.snapshot().rows).toHaveLength(1);
});
it("keeps unread markers on read failure and allows retry", async () => {
  vi.mocked(loadSubmissions).mockRejectedValueOnce(
    new Error("Read unavailable"),
  );
  const f = fixture();
  await vi.advanceTimersByTimeAsync(250);
  expect(f.store.snapshot().error).toBe("Read unavailable");
  f.store.reload();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.snapshot().error).toBe("");
  expect(f.store.snapshot().rows).toHaveLength(1);
});

function firstRow(store: ReturnType<typeof createSubmissionUpdates>) {
  const value = store.snapshot().rows[0];
  if (!value) throw new Error("Missing test row");
  return value;
}

it("keeps multiple acknowledgments usable when local storage cannot be written", async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(250);
  f.emit(report("lgtm_not_approved"));
  const completed = firstRow(f.store);
  const other = { ...completed, artifactId: "another-artifact" };
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  f.store.markSeen(completed);
  f.store.markSeen(other);
  expect(f.store.unread(completed)).toBe(false);
  expect(f.store.unread(other)).toBe(false);
  const anotherChannel = fixture("viewer-community", "another-channel");
  expect(anotherChannel.store.unread(completed)).toBe(true);
});
