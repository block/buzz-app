// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { AgentType } from "../../features/agents/service";
import { apply, PROTECTION_UNAVAILABLE } from "./index";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));

it("registers without protection support, saying why a protected agent doesn't run", () => {
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
  expect(type?.protection).toBeUndefined();
  expect(type?.protectionUnavailable).toBe(PROTECTION_UNAVAILABLE);
});
