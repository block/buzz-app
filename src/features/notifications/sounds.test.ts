import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { PluginRuntime } from "../../plugins/runtime";
import { SOUND_NAMES, isSoundName } from "./sound";
import { createSoundRegistry } from "./sounds";

const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  vi.unstubAllGlobals();
});
function bundledOnly() {
  const ctx = new Context();
  contexts.push(ctx);
  const runtime = new PluginRuntime(ctx, async () => ({ apply() {} }));
  ctx.effect(() => () => runtime.dispose());
  return createSoundRegistry(ctx);
}

it("playback without an Audio constructor reports null, never throws", () => {
  // Bare Node has no Audio global; delivery sound stays best-effort.
  expect(bundledOnly().play("doong")).toBeNull();
});

it("playback restarts a cached bundled clip", () => {
  const instances: Array<{ src: string; currentTime: number; play: unknown }> =
    [];
  const play = vi.fn(async () => {});
  vi.stubGlobal(
    "Audio",
    class {
      currentTime = 5;
      play = play;
      constructor(public src: string) {
        instances.push(this);
      }
    },
  );
  const registry = bundledOnly();
  const first = registry.play("ping");
  expect(instances[0]?.src).toBe("/sounds/ping.mp3");
  expect(first).toBe(instances[0]);
  expect(first?.currentTime).toBe(0);
  registry.play("ping");
  expect(instances).toHaveLength(1);
  expect(play).toHaveBeenCalledTimes(2);
  for (const name of SOUND_NAMES) registry.play(name);
  // "ping" is already cached from above, so it stays first and is not recreated.
  expect(instances.map((audio) => audio.src)).toEqual(
    ["ping", ...SOUND_NAMES.filter((name) => name !== "ping")].map(
      (name) => `/sounds/${name}.mp3`,
    ),
  );
});

it("Silent is valid and never creates or plays an audio asset", () => {
  const audio = vi.fn();
  vi.stubGlobal("Audio", audio);
  const registry = bundledOnly();
  expect(isSoundName("silent")).toBe(true);
  expect(registry.isAvailable("silent")).toBe(true);
  expect(registry.source("silent")).toBeNull();
  expect(registry.play("silent")).toBeNull();
  expect(audio).not.toHaveBeenCalled();
});

it("bundled sounds play from public/sounds", () => {
  const registry = bundledOnly();
  expect(registry.isAvailable("ping")).toBe(true);
  expect(registry.source("ping")).toBe("/sounds/ping.mp3");
  expect(registry.isAvailable("example.sound-pack/chime")).toBe(false);
  expect(registry.source("example.sound-pack/chime")).toBeNull();
  expect(registry.play("example.sound-pack/chime")).toBeNull();
  expect(registry.snapshot()).toEqual([]);
});
