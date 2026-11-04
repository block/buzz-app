// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { AgentType } from "../../features/agents/service";
import { apply } from "./index";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));

function applied() {
  let type: AgentType | undefined;
  apply({
    agentProtection: { registerModels: vi.fn() },
    pluginOwner: { id: "buzz.pi", revision: "r1" },
    host: { request: vi.fn() },
    agents: {
      register: (registered: AgentType) => {
        type = registered;
      },
      relay: () => undefined,
    },
    effect: vi.fn(),
  } as never);
  return type;
}

it("shares a Pi agent's provider and model as the pi runtime and imports them back", () => {
  const type = applied();
  const shared = type?.exportShared?.({
    provider: "anthropic",
    model: "sonnet",
    workspace: "/private",
  });
  expect(shared).toEqual({
    runtime: "pi",
    provider: "anthropic",
    model: "sonnet",
  });
  expect(type?.importShared?.(shared ?? { model: "" })).toMatchObject({
    provider: "anthropic",
    model: "sonnet",
    workspace: "~/.buzz",
  });
  expect(
    type?.importShared?.({ runtime: "codex", model: "x" }),
  ).toBeUndefined();
});

it("takes a proposed provider, resetting the model and effort it leaves stale", () => {
  const type = applied();
  const saved = {
    ...(type?.defaults().config as object),
    provider: "openai",
    model: "gpt-4o",
    effort: "high",
  };
  expect(type?.propose?.({ provider: "anthropic" }, saved)).toEqual({
    ...saved,
    provider: "anthropic",
    model: "",
    effort: "",
  });
});
