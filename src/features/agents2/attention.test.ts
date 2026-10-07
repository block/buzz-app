import { describe, expect, it } from "vitest";
import type { EventData } from "../relay/events";
import {
  addressedTo,
  compileFilter,
  timerSpent,
  timerState,
  validateObject,
  watchMatches,
  type EventWatch,
  type TimerWatch,
} from "./attention";

const agent = "a".repeat(64);
const channel = "0b8e2a3c-1d4f-4a5b-8c6d-7e8f9a0b1c2d";
const event = (patch: Partial<EventData> = {}): EventData => ({
  id: "e".repeat(64),
  pubkey: "b".repeat(64),
  created_at: 100,
  kind: 9,
  content: "hi",
  tags: [["h", channel]],
  ...patch,
});
const watch: EventWatch = {
  type: "event",
  interest_id: "default",
  enabled: true,
  since: 50,
  channels: [channel],
  kinds: [9],
};

describe("validateObject", () => {
  it("accepts each spec value at a matching slug", () => {
    expect(
      validateObject("interest/default", {
        type: "interest",
        instructions: "x",
      }),
    ).toBeUndefined();
    expect(validateObject("watch/w", watch)).toBeUndefined();
    expect(
      validateObject("watch/t", {
        type: "timer",
        interest_id: "default",
        prompt: "tick",
        enabled: true,
        interval_secs: 60,
        armed_at: 0,
        max_occurrences: null,
        expires_at: null,
      }),
    ).toBeUndefined();
  });
  it("refuses wrong slugs, unknown or missing fields and bad values", () => {
    expect(validateObject("other/x", watch)).toMatch(/slug/);
    expect(validateObject("interest/x", watch)).toMatch(/interest/);
    expect(validateObject("watch/w", { ...watch, extra: 1 })).toMatch(
      /Unknown/,
    );
    const { since: _, ...missing } = watch;
    expect(validateObject("watch/w", missing)).toMatch(/Missing/);
    expect(validateObject("watch/w", { ...watch, channels: ["c1"] })).toMatch(
      /channels/,
    );
    expect(validateObject("watch/w", { ...watch, tags: { h: ["x"] } })).toMatch(
      /other than h/,
    );
    expect(
      validateObject("watch/w", { ...watch, filter: "author ==" }),
    ).toMatch(/string/);
  });
});

describe("compileFilter", () => {
  it("evaluates the grammar with precedence and negation", () => {
    const filter = compileFilter(
      `!is_reply && (content == "go" || author == "${"c".repeat(64)}")`,
    );
    expect(filter(event({ content: "go" }))).toBe(true);
    expect(filter(event({ pubkey: "c".repeat(64) }))).toBe(true);
    expect(filter(event())).toBe(false);
    expect(
      filter(event({ content: "go", tags: [["e", "x", "", "reply"]] })),
    ).toBe(false);
  });
  it("refuses trailing text and unknown words", () => {
    expect(() => compileFilter("true false")).toThrow(/end/);
    expect(() => compileFilter("trueish")).toThrow(/Unexpected/);
  });
});

describe("matching", () => {
  it("matches enabled watches by since, channel, kind and tags", () => {
    expect(watchMatches(watch, event())).toBe(true);
    expect(watchMatches({ ...watch, enabled: false }, event())).toBe(false);
    expect(watchMatches(watch, event({ created_at: 10 }))).toBe(false);
    expect(watchMatches(watch, event({ tags: [] }))).toBe(false);
    expect(watchMatches(watch, event({ kind: 7 }))).toBe(false);
    expect(watchMatches({ ...watch, tags: { t: ["x"] } }, event())).toBe(false);
  });
  it("treats mentions, DMs and replies to the agent as addressed", () => {
    expect(addressedTo(event({ tags: [["p", agent]] }), agent)).toBe(true);
    expect(addressedTo(event({ kind: 1, tags: [["p", agent]] }), agent)).toBe(
      false,
    );
    expect(
      addressedTo(
        event({ tags: [["e", "mine"]] }),
        agent,
        (id) => id === "mine",
      ),
    ).toBe(true);
    expect(
      addressedTo(event({ pubkey: agent, tags: [["p", agent]] }), agent),
    ).toBe(false);
  });
  it("restarts a timer's schedule on a new armed_at and spends it", () => {
    const timer: TimerWatch = {
      type: "timer",
      interest_id: "default",
      prompt: "tick",
      enabled: true,
      interval_secs: 10,
      armed_at: 100,
      max_occurrences: 1,
      expires_at: null,
    };
    const state = timerState(timer, undefined);
    expect(state).toEqual({ armedAt: 100, nextDue: 110, used: 0 });
    expect(timerState(timer, { ...state, used: 1 }).used).toBe(1);
    expect(timerState({ ...timer, armed_at: 200 }, state).nextDue).toBe(210);
    expect(timerSpent(timer, { ...state, used: 1 }, 0)).toBe(true);
    expect(timerSpent({ ...timer, expires_at: 50 }, state, 50)).toBe(true);
  });
});
