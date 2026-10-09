import { afterEach, expect, it, vi } from "vitest";
import { SOUND_NAMES, isSoundName, playNotificationSound } from "./sound";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("playback without an Audio constructor reports null, never throws", () => {
  // Bare Node has no Audio global; delivery sound stays best-effort.
  expect(playNotificationSound("doong")).toBeNull();
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
  const first = playNotificationSound("ping");
  expect(instances[0]?.src).toBe("/sounds/ping.mp3");
  expect(first).toBe(instances[0]);
  expect(first?.currentTime).toBe(0);
  playNotificationSound("ping");
  expect(instances).toHaveLength(1);
  expect(play).toHaveBeenCalledTimes(2);
  for (const name of SOUND_NAMES) playNotificationSound(name);
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
  expect(isSoundName("silent")).toBe(true);
  expect(playNotificationSound("silent")).toBeNull();
  expect(audio).not.toHaveBeenCalled();
});
