import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import {
  createMentionPlacements,
  PLACEMENT_TIMEOUT_MS,
  type MentionPlacer,
} from "./mention-placement";
import type { AgentKey } from "./membership";

const top = {
  id: "a".repeat(64),
  pubkey: "b".repeat(64),
  kind: 9,
  created_at: 1,
  content: "@agent hi",
  tags: [["h", "c1"]],
} as RelayEvent;
const agent = "agent" as AgentKey;

function setup() {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const placements = createMentionPlacements(root);
  const plugin = (id: string) =>
    root.extend({ pluginOwner: { id, revision: "1" } } as never);
  return { placements, plugin };
}

describe("mention placements", () => {
  it("asks the one placer about a top-level mention, never one in a thread", async () => {
    const { placements, plugin } = setup();
    const place = vi.fn<MentionPlacer["place"]>(async () => ({
      topLevel: true,
      note: "It asks for #release-notes.",
    }));
    placements.register(plugin("p1"), { id: "where", place });
    const signal = new AbortController().signal;
    await expect(placements.place(agent, "c1", top, signal)).resolves.toEqual({
      placement: { topLevel: true },
      note: "It asks for #release-notes.",
    });
    expect(place).toHaveBeenCalledWith(
      { agent, channel: "c1", event: top },
      expect.any(AbortSignal),
    );
    const reply = {
      ...top,
      tags: [
        ["h", "c1"],
        ["e", "d".repeat(64), "", "reply"],
      ],
    };
    await expect(placements.place(agent, "c1", reply, signal)).resolves.toEqual(
      {},
    );
    expect(place).toHaveBeenCalledTimes(1);
  });

  it("keeps the native place for a bad, own-thread, late, stale or failed answer, or two placers", async () => {
    vi.useFakeTimers();
    try {
      const { placements, plugin } = setup();
      let answer: () => Promise<unknown> = async () => ({ root: "not hex" });
      const remove = placements.register(plugin("p1"), {
        id: "where",
        place: () => answer() as never,
      });
      const signal = new AbortController().signal;
      const place = () => placements.place(agent, "c1", top, signal);
      await expect(place()).resolves.toEqual({});
      answer = async () => ({ root: top.id, note: " only a note " });
      await expect(place()).resolves.toEqual({ note: "only a note" });
      answer = async () => ({ root: "E".repeat(64) });
      await expect(place()).resolves.toEqual({
        placement: { root: "e".repeat(64) },
      });
      answer = async () => ({ root: "e".repeat(64), topLevel: true });
      await expect(place()).resolves.toEqual({});
      answer = async () => {
        throw new Error("down");
      };
      await expect(place()).resolves.toEqual({});
      answer = () => new Promise(() => {});
      const late = place();
      await vi.advanceTimersByTimeAsync(PLACEMENT_TIMEOUT_MS);
      await expect(late).resolves.toEqual({});
      // An answer that comes after its plugin turned off.
      let answered!: (value: unknown) => void;
      answer = () => new Promise((resolve) => (answered = resolve));
      const removed = place();
      remove();
      answered({ topLevel: true, note: "stale" });
      await expect(removed).resolves.toEqual({});
      placements.register(plugin("p1"), {
        id: "where",
        place: () => answer() as never,
      });
      answer = async () => ({ topLevel: true });
      placements.register(plugin("p2"), {
        id: "where",
        place: async () => ({ topLevel: true }),
      });
      await expect(place()).resolves.toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });
});
