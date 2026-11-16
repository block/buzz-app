import { expect, it, vi } from "vitest";
import { threadTitlesEnabled } from "../../features/messages/thread-title-store";
import { apply } from "./index";
import manifest from "./manifest.json";

it("turns shared titles on while it runs and registers the timeline title", () => {
  const conversation = { registerAccessory: vi.fn() };
  const effects: (() => () => void)[] = [];
  const effect = (run: () => () => void) => effects.push(run);
  apply({ conversation, effect } as unknown as Parameters<typeof apply>[0]);
  expect(threadTitlesEnabled()).toBe(false);
  const stop = effects[0]?.();
  expect(threadTitlesEnabled()).toBe(true);
  stop?.();
  expect(threadTitlesEnabled()).toBe(false);
  expect(conversation.registerAccessory.mock.calls[0]?.[0]).toMatchObject({
    id: "thread-title",
    placement: "message",
  });
  expect(manifest).not.toHaveProperty("host");
});
