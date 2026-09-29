import { expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { ThreadSnapshot } from "../../features/relay/threads";
import { requestWork } from "./request-work";
import { cachedRequestWork } from "./request-work-cache";
vi.mock("./request-work", () => ({ requestWork: vi.fn(() => []) }));
it("shares a projection across sibling decorations and panel; every evidence/scope change invalidates it", () => {
  const snapshot = {
    status: "listening",
    records: [],
    turns: [],
    typing: [],
    trimmed: 0,
  } as ReturnType<RelaySession["agentActivity"]["snapshot"]>;
  const thread = {
    status: "ready",
    root: undefined,
    replies: [],
    error: undefined,
    canLoadMore: false,
    limited: false,
  } as ThreadSnapshot;
  const result = cachedRequestWork(snapshot, thread, "c", "r", "v");
  for (let n = 0; n < 52; n++)
    expect(cachedRequestWork(snapshot, thread, "c", "r", "v")).toBe(result);
  expect(requestWork).toHaveBeenCalledTimes(1);
  cachedRequestWork({ ...snapshot }, thread, "c", "r", "v");
  cachedRequestWork(snapshot, { ...thread }, "c", "r", "v");
  cachedRequestWork(snapshot, thread, "other", "r", "v");
  cachedRequestWork(snapshot, thread, "c", "other", "v");
  cachedRequestWork(snapshot, thread, "c", "r", "other");
  expect(requestWork).toHaveBeenCalledTimes(6);
});
