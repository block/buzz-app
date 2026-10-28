import { expect, it, vi } from "vitest";
import { delivered, runtimeLink } from "../../features/agents/plugin-testing";
import { linkPi, servePi } from "./exposed";
import type { PiRuntime } from "./runtime";
import type { PiSetup } from "./setup";

it("tells Pi's UI of each runtime change, so it reads its places again", async () => {
  const listeners = new Set<() => void>();
  let places = [{ key: "channel", conversation: 1, seen: 0 }];
  const runtime = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    working: () => [],
    places: vi.fn(async () => places),
    transcript: vi.fn(async () => ({ entries: [], more: false })),
  };
  const setup = { login: vi.fn(async () => {}) };
  const ui = linkPi(
    runtimeLink(
      servePi(setup as unknown as PiSetup, runtime as unknown as PiRuntime),
    ),
  );
  const changed = vi.fn();
  ui.runtime.subscribe(changed);
  await delivered();
  await expect(ui.runtime.places("a")).resolves.toEqual(places);
  places = [...places, { key: "channel/root", conversation: 2, seen: 0 }];
  for (const listener of [...listeners]) listener();
  await delivered();
  expect(changed).toHaveBeenCalled();
  await expect(ui.runtime.places("a")).resolves.toHaveLength(2);
  await ui.setup.login("openai", "key");
  expect(setup.login).toHaveBeenCalledWith("openai", "key");
});
