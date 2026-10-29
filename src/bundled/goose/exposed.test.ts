import { expect, it, vi } from "vitest";
import { delivered, runtimeLink } from "../../features/agents/plugin-testing";
import { linkGoose, serveGoose } from "./exposed";
import type { GooseRuntime } from "./runtime";
import type { GooseSetup } from "./setup";
import type { GooseHistory } from "./transcript";

function linked() {
  const setup = {
    snapshot: () => ({ readiness: "ready" as const }),
    subscribe: () => () => true,
    check: vi.fn(async () => {}),
    providers: vi.fn(async () => ({ providers: [], defaults: {} })),
    saved: vi.fn(async () => new Set(["API_KEY"])),
    save: vi.fn(async () => {}),
    saveDefaults: vi.fn(async () => {}),
  };
  const history = {
    find: vi.fn(async () => undefined),
    recent: vi.fn(async () => [{ sessionId: "s" }]),
    transcript: vi.fn(async () => undefined),
  };
  const runtime = {
    subscribe: () => () => {},
    sessions: () => [{ key: "channel", busy: true }],
  };
  const ui = linkGoose(
    runtimeLink(
      serveGoose(
        setup as unknown as GooseSetup,
        runtime as unknown as GooseRuntime,
        history as unknown as GooseHistory,
      ),
    ),
  );
  return { ui, setup, history };
}

it("gives goose's UI its setup over the link, sets as sets and saves with their fields", async () => {
  const { ui, setup } = linked();
  expect(ui.setup.snapshot()).toEqual({ readiness: "checking" });
  await delivered();
  expect(ui.setup.snapshot()).toEqual({ readiness: "ready" });
  await expect(ui.setup.saved("openai")).resolves.toEqual(new Set(["API_KEY"]));
  await ui.setup.save("openai", { API_KEY: "k" });
  expect(setup.save).toHaveBeenCalledWith("openai", { API_KEY: "k" });
  await ui.setup.saveDefaults({ provider: "openai", model: "m" });
  expect(setup.saveDefaults).toHaveBeenCalledWith(
    { provider: "openai", model: "m" },
    {},
  );
});

it("reads goose's sessions and history over the link, with nothing found as undefined", async () => {
  const { ui, history } = linked();
  expect(ui.runtime.sessions("a")).toEqual([]);
  await delivered();
  expect(ui.runtime.sessions("a")).toEqual([{ key: "channel", busy: true }]);
  const signal = new AbortController().signal;
  await expect(
    ui.history.find("a", "~", { channelId: "c" }, signal),
  ).resolves.toBeUndefined();
  expect(history.find).toHaveBeenCalledWith(
    "a",
    "~",
    { channelId: "c" },
    expect.any(AbortSignal),
  );
  await expect(ui.history.recent("a", "~", signal)).resolves.toEqual([
    { sessionId: "s" },
  ]);
});
