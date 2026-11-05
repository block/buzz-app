// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { AgentType } from "../../features/agents/service";
import { ClaudeRuntime } from "./runtime";
import { apply } from "./index";
import { ClaudeSetup } from "./setup";
import { ClaudeDefaults } from "./defaults";
import { recommendedRun } from "../../features/agents/recommended";

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
  let type: AgentType | undefined;
  apply({
    agentProtection: { registerModels: vi.fn() },
    pluginOwner: { id: "buzz.claude-code", revision: "r1" },
    host: { request: vi.fn() },
    agents: {
      register: (registered: AgentType) => {
        type = registered;
      },
      relay: () => undefined,
    },
    effect: vi.fn(),
  } as never);
  expect(type?.sessions?.list(agent)).toEqual([
    { channelId: "room", root: "r", at: 3, status: "Working" },
    { channelId: "dm", at: 2, status: "Idle" },
    // A conversation with no running process is unobserved, not idle.
    { channelId: "old", at: 1 },
  ]);
});

it("shares a Claude agent's model as the claude runtime and imports it back", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  let type: AgentType | undefined;
  apply({
    agentProtection: { registerModels: vi.fn() },
    pluginOwner: { id: "buzz.claude-code", revision: "r1" },
    host: { request: vi.fn() },
    agents: {
      register: (registered: AgentType) => {
        type = registered;
      },
      relay: () => undefined,
    },
    effect: vi.fn(),
  } as never);
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

it("registers review models from the discovered catalog", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.spyOn(ClaudeSetup.prototype, "catalog").mockResolvedValue([
    { value: "opus", displayName: "Opus" },
    { value: "haiku" },
  ] as never);
  const registerModels = vi.fn();
  apply({
    agentProtection: { registerModels },
    pluginOwner: { id: "buzz.claude-code", revision: "r1" },
    host: { request: vi.fn() },
    agents: { register: vi.fn(), relay: () => undefined },
    effect: vi.fn(),
  } as never);
  await expect(registerModels.mock.calls[0]?.[0].models()).resolves.toEqual([
    { id: "opus", label: "Opus" },
    { id: "haiku", label: "haiku" },
  ]);
});

it("recommends a candidate only when Claude is signed in and lists its model and level", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  let ready = true;
  // As a check of the installed Claude reports its sign-in.
  vi.spyOn(ClaudeSetup.prototype, "check").mockImplementation(
    async function (this: { state: object }) {
      this.state = {
        ...this.state,
        status: { state: ready ? "ready" : "signed-out" },
      };
    },
  );
  vi.spyOn(ClaudeSetup.prototype, "catalog").mockResolvedValue([
    // An alias resolves to the pinned model a candidate may name.
    {
      value: "opus",
      resolvedModel: "model-a",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
    },
    { value: "model-b" },
  ] as never);
  let type: AgentType | undefined;
  apply({
    agentProtection: { registerModels: vi.fn() },
    pluginOwner: { id: "buzz.claude-code", revision: "r1" },
    host: { request: vi.fn() },
    agents: {
      register: (registered: AgentType) => {
        type = registered;
      },
      relay: () => undefined,
    },
    effect: vi.fn(),
  } as never);
  const candidate = (model: string, effort = "high") => ({
    harness: "claude-code",
    model,
    effort,
    label: "Model A",
  });
  await expect(type?.recommends?.(candidate("model-a"))).resolves.toBe(true);
  await expect(type?.recommends?.(candidate("opus"))).resolves.toBe(true);
  // A model without levels takes none; one with them needs the candidate's.
  await expect(type?.recommends?.(candidate("model-b"))).resolves.toBe(true);
  await expect(type?.recommends?.(candidate("model-a", "max"))).resolves.toBe(
    false,
  );
  await expect(type?.recommends?.(candidate("model-z"))).resolves.toBe(false);
  // Signed out: a fresh setup's check says so, and nothing is listed.
  ready = false;
  const signedOut = new ClaudeSetup(vi.fn() as never);
  await expect(signedOut.offers(candidate("model-a"))).resolves.toBe(false);
});

it("runs an agent on Recommended on the candidate, else on the device default", async () => {
  vi.stubEnv(
    "VITE_BUZZ_RECOMMENDED_AGENT",
    JSON.stringify([
      { harness: "claude-code", model: "model-a", effort: "high", label: "A" },
    ]),
  );
  try {
    const data = new Map<string, string>();
    const storage = {
      keys: () => [...data.keys()],
      get: (key: string) => data.get(key) ?? null,
      set: async (key: string, value: string | null) => {
        if (value === null) data.delete(key);
        else data.set(key, value);
      },
      add: async (_key: string, value: string) => value,
    };
    let offered = true;
    const run = recommendedRun("claude-code", async () => offered);
    const defaults = new ClaudeDefaults(storage, run);
    await defaults.save({ model: "model-d", effort: "low" });
    const saved = { preset: "recommended", instructions: "Be brief." };
    // Until found it inherits the device default, as a blank agent does.
    expect(defaults.resolve(saved).model).toBe("model-d");
    // The runtime, which resolved it before the finding, is told to again.
    const changed = vi.fn();
    defaults.subscribe(changed);
    await run.find();
    expect(changed).toHaveBeenCalled();
    expect(defaults.resolve(saved)).toMatchObject({
      model: "model-a",
      effort: "high",
    });
    // Off Recommended, its own settings are untouched.
    expect(defaults.resolve({ model: "own" }).model).toBe("own");
    offered = false;
    const none = recommendedRun("claude-code", async () => offered);
    await none.find();
    expect(new ClaudeDefaults(storage, none).resolve(saved).model).toBe(
      "model-d",
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
