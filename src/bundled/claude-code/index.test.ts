// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { ClaudeRuntime } from "./runtime";
import * as claude from "./index";
import { appliedType } from "../../features/agents/plugin-testing";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
afterEach(() => vi.restoreAllMocks());

it("observes saved sessions with the live status of running ones", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const agent = "a".repeat(64);
  vi.spyOn(ClaudeRuntime.prototype, "conversations").mockReturnValue([
    {
      key: "room/r",
      agent,
      sessionId: "s1",
      channelId: "room",
      root: "r",
      at: 3,
    },
    { key: "dm", agent, sessionId: "s2", channelId: "dm", at: 2 },
    { key: "old", agent, sessionId: "s3", channelId: "old", at: 1 },
  ]);
  vi.spyOn(ClaudeRuntime.prototype, "sessions").mockReturnValue([
    { key: "room/r", busy: true },
    { key: "dm", busy: false },
  ]);
  const type = appliedType(claude, {
    pluginOwner: { id: "buzz.claude-code", revision: "r1" },
    host: { request: vi.fn() },
    agents: { relay: () => undefined },
    effect: vi.fn(),
  });
  expect(type?.sessions?.list(agent)).toEqual([
    { channelId: "room", root: "r", at: 3, status: "Working" },
    { channelId: "dm", at: 2, status: "Idle" },
    // A conversation with no running process is unobserved, not idle.
    { channelId: "old", at: 1 },
  ]);
});

it("shares a Claude agent's model as the claude runtime and imports it back", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const type = appliedType(claude, {
    pluginOwner: { id: "buzz.claude-code", revision: "r1" },
    host: { request: vi.fn() },
    agents: { relay: () => undefined },
    effect: vi.fn(),
  });
  const shared = type?.exportShared?.({ model: "opus", workspace: "/private" });
  expect(shared).toEqual({ runtime: "claude", model: "opus" });
  expect(type?.importShared?.(shared ?? { model: "" })).toMatchObject({
    model: "opus",
    workspace: "~/.buzz",
  });
  expect(
    type?.importShared?.({ runtime: "goose", model: "opus" }),
  ).toBeUndefined();
});
