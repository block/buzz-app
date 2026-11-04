// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  AGENTS_ONLY_LIMIT,
  messageStylePreference,
  onlyAgentsBesides,
  dmBubblesPreference,
  ownColorPreference,
  setDmBubblesPreference,
  setMessageStylePreference,
  setOwnColorPreference,
  threadAuthors,
} from "./message-bubbles";

const viewer = "a".repeat(64);
const person = "b".repeat(64);
const agent = "c".repeat(64);
const other = "d".repeat(64);
const agents = new Set([agent, other]);
const isAgent = (key: string) => agents.has(key);

afterEach(() => {
  vi.restoreAllMocks();
  setMessageStylePreference("bubbles");
  setOwnColorPreference(false);
  setDmBubblesPreference(true);
  localStorage.clear();
});

it("defaults to bubbles, persists bubbles only with agents, and ignores unknown values", () => {
  localStorage.clear();
  expect(messageStylePreference()).toBe("bubbles");
  setMessageStylePreference("agents");
  expect(messageStylePreference()).toBe("agents");
  expect(localStorage.getItem("buzz-message-style.v1")).toBe("agents");
  localStorage.setItem("buzz-message-style.v1", "unknown");
  expect(messageStylePreference()).toBe("bubbles");
});

it("keeps own color off by default and persists turning it on", () => {
  localStorage.clear();
  expect(ownColorPreference()).toBe(false);
  setOwnColorPreference(true);
  expect(ownColorPreference()).toBe(true);
  expect(localStorage.getItem("buzz-message-own-color.v1")).toBe("on");
});

it("keeps direct-message bubbles on by default and persists turning them off", () => {
  localStorage.clear();
  expect(dmBubblesPreference()).toBe(true);
  setDmBubblesPreference(false);
  expect(dmBubblesPreference()).toBe(false);
  expect(localStorage.getItem("buzz-message-dm-bubbles.v1")).toBe("off");
});

it("retains the active choice when storage fails and can retry saving it", () => {
  const storage = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementationOnce(() => {
      throw new Error("full");
    });
  setMessageStylePreference("agents");
  expect(messageStylePreference()).toBe("agents");
  storage.mockRestore();
  setMessageStylePreference("agents");
  expect(localStorage.getItem("buzz-message-style.v1")).toBe("agents");
});

it("recognizes the viewer with one or more agents and no other people", () => {
  expect(onlyAgentsBesides([viewer, agent], viewer, isAgent)).toBe(true);
  expect(onlyAgentsBesides([agent, viewer, other], viewer, isAgent)).toBe(true);
  expect(onlyAgentsBesides([viewer, agent, person], viewer, isAgent)).toBe(
    false,
  );
  expect(onlyAgentsBesides([viewer], viewer, isAgent)).toBe(false);
  expect(onlyAgentsBesides([agent, other], viewer, isAgent)).toBe(false);
  expect(onlyAgentsBesides([viewer, agent], undefined, isAgent)).toBe(false);
  expect(onlyAgentsBesides(undefined, viewer, isAgent)).toBe(false);
  const many = Array.from({ length: AGENTS_ONLY_LIMIT + 1 }, (_, i) =>
    String(i).padStart(64, "0"),
  );
  expect(onlyAgentsBesides([viewer, ...many], viewer, () => true)).toBe(false);
});

it("lists a thread's own authors", () => {
  const row = (authorId: string, extra = {}) => ({ authorId, ...extra });
  expect(threadAuthors([])).toEqual([]);
  expect(threadAuthors([row(agent)])).toEqual([agent]);
  expect(threadAuthors([row(viewer), row(agent), row(agent)])).toEqual([
    viewer,
    agent,
  ]);
  expect(
    threadAuthors([
      row(viewer),
      row(person, { membership: { type: "member_joined" } }),
      row(other, { workflowOwnerId: viewer }),
    ]),
  ).toEqual([viewer]);
});
