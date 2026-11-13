// @vitest-environment node
import { expect, it, vi } from "vitest";
import { PROMPTS_BUDGET, sessionPrompts } from "./session-prompts";
import {
  removeStandaloneSessions,
  STANDALONE_DAYS,
  STANDALONE_LIMIT,
  STANDALONE_PREFIX,
  standaloneSessions,
} from "./standalone-sessions";
import { localStore } from "./store";

const AGENT = "a".repeat(64);
const OTHER = "b".repeat(64);
const DAY = 86_400_000;
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

it("keeps each one-off turn's session once, with when it started", async () => {
  const storage = memory();
  let now = 1_000;
  const sessions = standaloneSessions(storage, "pi", AGENT, () => now);
  await sessions.add("s1");
  now = 2_000;
  await sessions.add("s2");
  await sessions.add("s1");
  expect(sessions.list()).toEqual([
    { id: "s1", at: 1_000 },
    { id: "s2", at: 2_000 },
  ]);
  // Each agent type and agent keeps its own.
  expect(standaloneSessions(storage, "claude-code", AGENT).list()).toEqual([]);
  expect(standaloneSessions(storage, "pi", OTHER).list()).toEqual([]);
});

it("outlasts the saved prompts dropping its sessions", async () => {
  const storage = memory();
  const prompts = sessionPrompts(storage, "pi", AGENT);
  await prompts.save("once", [], { at: 1, title: "", conversation: null });
  await standaloneSessions(storage, "pi", AGENT).add("once");
  for (const later of ["l1", "l2", "l3"])
    await prompts.save(later, [
      { label: "", text: later.repeat(PROMPTS_BUDGET / 6) },
    ]);
  expect(prompts.sessions().map(({ id }) => id)).not.toContain("once");
  expect(
    standaloneSessions(storage, "pi", AGENT)
      .list()
      .map(({ id }) => id),
  ).toEqual(["once"]);
});

it("keeps a session for as long as Usage reads back, then drops it", async () => {
  const storage = memory();
  let now = 0;
  const sessions = standaloneSessions(storage, "pi", AGENT, () => now);
  await sessions.add("old");
  now = STANDALONE_DAYS * DAY;
  expect(sessions.list().map(({ id }) => id)).toEqual(["old"]);
  now += 1;
  expect(sessions.list()).toEqual([]);
  await sessions.add("new");
  expect(
    JSON.parse(storage.get(`${STANDALONE_PREFIX}pi:${AGENT}`) ?? ""),
  ).toEqual({ version: 1, sessions: [["new", now]] });
});

it("keeps at most the newest sessions past its limit", async () => {
  const storage = memory();
  const many = Array.from(
    { length: STANDALONE_LIMIT },
    (_, index): [string, number] => [`s${index}`, Date.now()],
  );
  await storage.set(
    `${STANDALONE_PREFIX}pi:${AGENT}`,
    JSON.stringify({ version: 1, sessions: many }),
  );
  const sessions = standaloneSessions(storage, "pi", AGENT);
  await sessions.add("newest");
  const ids = sessions.list().map(({ id }) => id);
  expect(ids).toHaveLength(STANDALONE_LIMIT);
  expect(ids[0]).toBe("s1");
  expect(ids.at(-1)).toBe("newest");
});

it("drops damaged entries and reads a damaged value as none", async () => {
  const storage = memory();
  const key = `${STANDALONE_PREFIX}pi:${AGENT}`;
  await storage.set(
    key,
    JSON.stringify({
      version: 1,
      sessions: [
        ["ok", Date.now()],
        ["", 1],
        ["x".repeat(257), 1],
        [3, 1],
        ["t", "soon"],
      ],
    }),
  );
  expect(
    standaloneSessions(storage, "pi", AGENT)
      .list()
      .map(({ id }) => id),
  ).toEqual(["ok"]);
  await storage.set(key, "{");
  expect(standaloneSessions(storage, "pi", AGENT).list()).toEqual([]);
});

it("logs a failed save rather than throwing", async () => {
  const storage = memory();
  const failing = {
    ...storage,
    set: async () => {
      throw new Error("full");
    },
  };
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(
      standaloneSessions(failing, "pi", AGENT).add("s"),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  } finally {
    error.mockRestore();
  }
});

it("removes a membership's sessions of every agent type, and only its", async () => {
  const storage = memory();
  await standaloneSessions(storage, "pi", AGENT).add("p");
  await standaloneSessions(storage, "claude-code", AGENT).add("c");
  await standaloneSessions(storage, "pi", OTHER).add("o");
  await removeStandaloneSessions(storage, AGENT);
  expect(standaloneSessions(storage, "pi", AGENT).list()).toEqual([]);
  expect(standaloneSessions(storage, "claude-code", AGENT).list()).toEqual([]);
  expect(
    standaloneSessions(storage, "pi", OTHER)
      .list()
      .map(({ id }) => id),
  ).toEqual(["o"]);
});
