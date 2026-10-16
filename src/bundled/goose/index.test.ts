// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { AgentType } from "../../features/agents/service";
import { GooseRuntime } from "./runtime";
import { apply } from "./index";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
afterEach(() => vi.restoreAllMocks());

it("observes each conversation's open session with its status", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.spyOn(GooseRuntime.prototype, "sessions").mockReturnValue([
    { key: "room/r", busy: true, sessionId: "s1", at: 2 },
    { key: "dm", busy: false, sessionId: "s2", at: 1 },
    // A one-off turn joins no conversation.
    { key: "timer/x #1", busy: true },
  ]);
  let type: AgentType | undefined;
  apply({
    pluginOwner: { id: "buzz.goose", revision: "r1" },
    host: { request: vi.fn() },
    agents: {
      register: (registered: AgentType) => {
        type = registered;
      },
      relay: () => undefined,
    },
    effect: vi.fn(),
  } as never);
  expect(type?.sessions?.list("a".repeat(64))).toEqual([
    { channelId: "room", root: "r", at: 2, status: "Working" },
    { channelId: "dm", at: 1, status: "Idle" },
  ]);
});
