import { afterEach, describe, expect, it, vi } from "vitest";
import { type EventWatch, timerSpent, timerState } from "./attention";
import { migrateWatchKeywords } from "./migrate-keywords";
import { RECORD_PREFIX, STORAGE_KEY, readRecords } from "./store";
import { memoryStorage } from "./test-fakes";

const agent = "a".repeat(64);
const channel = "099e2481-9499-48d6-adad-fa89a15163a0";
const watch: EventWatch = {
  type: "event",
  interest_id: "triage",
  name: "Build failures",
  enabled: true,
  since: 50,
  channels: "all",
  kinds: [9],
  channel,
};
const NOW = 1_000;

afterEach(() => vi.restoreAllMocks());

const seed = (attention: Record<string, unknown>) => {
  const storage = memoryStorage();
  storage.setItem(
    `${RECORD_PREFIX}${agent}`,
    JSON.stringify({ pubkey: agent, config: null, attention }),
  );
  return storage;
};
const stored = (slug: string, value: unknown) => ({
  slug,
  value,
  modifiedAt: 3,
});

describe("migrateWatchKeywords", () => {
  it("turns a keyword watch off and tells its Interest why, once", async () => {
    const storage = seed({
      "interest/triage": stored("interest/triage", {
        type: "interest",
        instructions: "T.",
      }),
      "watch/builds": stored("watch/builds", {
        ...watch,
        keywords: ["failed", "[release]"],
      }),
    });
    await migrateWatchKeywords(storage, NOW);
    const once = storage.getItem(`${RECORD_PREFIX}${agent}`);
    const read = readRecords(storage)[agent];
    expect(read?.skipped).toEqual({});
    expect(read?.attention["watch/builds"]?.value).toEqual({
      ...watch,
      enabled: false,
    });
    const timer = read?.attention["watch/fix-builds"]?.value;
    expect(timer).toMatchObject({
      type: "timer",
      interest_id: "triage",
      enabled: true,
      interval_secs: 60,
      armed_at: NOW,
      max_occurrences: 1,
      expires_at: null,
      channel,
    });
    expect(timer?.type === "timer" && timer.prompt).toContain(
      '"builds" (Build failures) matched only events whose content contained any of ["failed","[release]"]',
    );
    // Seen first long after its interval (Attention was off), it still runs once.
    const state = timerState(
      timer as never,
      read?.timers?.["watch/fix-builds"],
      NOW + 86_400,
    );
    expect(state.nextDue).toBeLessThanOrEqual(NOW + 86_400);
    expect(timerSpent(timer as never, state, NOW + 86_400)).toBe(false);
    await migrateWatchKeywords(storage, NOW + 5);
    expect(storage.getItem(`${RECORD_PREFIX}${agent}`)).toBe(once);
  });
  it("picks a free timer id", async () => {
    const long = "w".repeat(62);
    const storage = seed({
      [`watch/${long}`]: stored(`watch/${long}`, { ...watch, keywords: ["x"] }),
      "watch/a": stored("watch/a", { ...watch, keywords: ["x"] }),
      "watch/fix-a": stored("watch/fix-a", watch),
    });
    await migrateWatchKeywords(storage, NOW);
    const attention = readRecords(storage)[agent]?.attention ?? {};
    expect(Object.keys(attention).sort()).toEqual([
      "watch/a",
      "watch/fix-a",
      "watch/fix-keywords-1",
      "watch/fix-keywords-2",
      `watch/${long}`,
    ]);
    expect(attention["watch/fix-a"]?.value).toEqual(watch);
  });
  it("leaves the watch for the owner when its timer passes the object limit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const attention: Record<string, unknown> = {
      "watch/builds": stored("watch/builds", { ...watch, keywords: ["x"] }),
    };
    for (let i = 0; i < 99; i++)
      attention[`watch/w${i}`] = stored(`watch/w${i}`, watch);
    const storage = seed(attention);
    const before = storage.getItem(`${RECORD_PREFIX}${agent}`);
    await migrateWatchKeywords(storage, NOW);
    expect(storage.getItem(`${RECORD_PREFIX}${agent}`)).toBe(before);
    expect(
      readRecords(storage)[agent]?.skipped?.["watch/builds"],
    ).toMatchObject({ problem: "Unknown field: keywords" });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/watch\/builds: the notice timer would pass/),
    );
  });
  it("converts keyword watches in the legacy shared record", async () => {
    const storage = memoryStorage();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        agents: {
          [agent]: {
            pubkey: agent,
            config: null,
            attention: {
              "watch/builds": stored("watch/builds", {
                ...watch,
                keywords: ["x"],
              }),
            },
          },
        },
      }),
    );
    await migrateWatchKeywords(storage, NOW);
    const record = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}").agents[
      agent
    ];
    expect(record.attention["watch/builds"].value).toEqual({
      ...watch,
      enabled: false,
    });
    expect(record.attention["watch/fix-builds"].value.type).toBe("timer");
  });
  it("leaves missing or malformed storage alone", async () => {
    const storage = memoryStorage();
    await migrateWatchKeywords(storage, NOW);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
    storage.setItem(STORAGE_KEY, "{");
    await migrateWatchKeywords(storage, NOW);
    expect(storage.getItem(STORAGE_KEY)).toBe("{");
  });
});
