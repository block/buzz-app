// @vitest-environment node
import { expect, it, vi } from "vitest";
import { localStore, type AgentStore } from "./store";
import { PROMPTS_BUDGET, sessionPrompts } from "./session-prompts";

const AGENT = "a".repeat(64);
const memory = () => {
  const items = new Map<string, string>();
  return localStore({
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    clear: () => items.clear(),
  });
};

it("keeps every session's first save, each text once", async () => {
  const storage = memory();
  const prompts = sessionPrompts(storage, "goose", AGENT);
  const shared = [{ label: "", text: "same prompt" }];
  await Promise.all([prompts.save("one", shared), prompts.save("two", shared)]);
  await prompts.save("one", [{ label: "", text: "rebuilt later" }]);
  expect(prompts.get("one")).toEqual(shared);
  expect(prompts.get("two")).toEqual(shared);
  const [key] = storage.keys();
  expect(storage.get(key as string)?.match(/same prompt/g)).toHaveLength(1);
  // Another agent type of the same agent keeps its own.
  expect(sessionPrompts(storage, "pi", AGENT).get("one")).toBeUndefined();
});

it("drops the oldest sessions to stay in budget, never cutting text", async () => {
  const prompts = sessionPrompts(memory(), "codex", AGENT);
  const big = (n: number) => `${n}`.repeat(PROMPTS_BUDGET / 3);
  for (const n of [1, 2, 3])
    await prompts.save(`s${n}`, [{ label: "", text: big(n) }]);
  expect(prompts.get("s1")).toBeUndefined();
  expect(prompts.get("s3")?.[0]?.text).toBe(big(3));
  // Too large to keep at all: marked, not truncated.
  await prompts.save("huge", [{ label: "", text: "x".repeat(PROMPTS_BUDGET) }]);
  expect(prompts.get("huge")).toBeNull();
  // A dropped session is never filled in again by reading it.
  expect(prompts.shown([])).toEqual([]);
});

it("logs a failed save without throwing", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const failing: AgentStore = {
    ...memory(),
    set: async () => {
      throw new Error("disk full");
    },
  };
  await expect(
    sessionPrompts(failing, "pi", AGENT).save("s", [{ label: "", text: "t" }]),
  ).resolves.toBeUndefined();
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});
