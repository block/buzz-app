// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { AgentType } from "../../features/agents/service";
import { apply, PROTECTION_UNAVAILABLE } from "./index";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));

function registered() {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  let type: AgentType | undefined;
  apply({
    pluginOwner: { id: "buzz.acp", revision: "r1" },
    host: { spawn: vi.fn(), request: vi.fn() },
    agents: {
      register: (registered: AgentType) => {
        type = registered;
      },
      relay: () => undefined,
      subscribe: () => () => undefined,
      snapshot: () => ({ agents: [], running: [] }),
    },
    effect: vi.fn(),
  } as never);
  return type;
}

it("tells the host each agent's session scope", () => {
  const scope = (value: string) =>
    registered()?.sessionControls?.scope({ config: { scope: value } } as never);
  expect(scope("channel")).toBe("channel");
  expect(scope("thread")).toBe("thread");
});

it("offers interrupted mentions for Resume", () => {
  expect(registered()?.resumes).toBe(true);
});

it("registers without protection support, saying why a protected agent doesn't run", () => {
  const type = registered();
  expect(type?.protection).toBeUndefined();
  // So its protection can still be changed, and its type.
  expect(type?.retire).toBeTypeOf("function");
  expect(type?.protectionUnavailable).toBe(PROTECTION_UNAVAILABLE);
});
