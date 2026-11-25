import { expect, it, vi } from "vitest";
import type { ChannelDetails } from "./channel-details-protocol";
import { FREE_NAME_ATTEMPTS, nameTaken, saveWithFreeName } from "./free-name";
import { PublishRejected } from "./outbox";

const base = { name: "sf-weather" } as unknown as ChannelDetails;
const taken = (name: string) =>
  new PublishRejected(
    "The relay refused the change.",
    `invalid: an open channel named "${name}" already exists`,
  );

it("recognizes only the relay's taken-name refusal", () => {
  expect(nameTaken(taken("x"))).toBe(true);
  expect(nameTaken(new Error("Permission denied"))).toBe(false);
});

it("saves the chosen name when it is free", async () => {
  const save = vi.fn(async () => {});
  await expect(saveWithFreeName({ save }, base, base)).resolves.toBe(
    "sf-weather",
  );
  expect(save).toHaveBeenCalledOnce();
});

it("adds -2, then -3, while the name is taken", async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce(taken("sf-weather"))
    .mockRejectedValueOnce(taken("sf-weather-2"))
    .mockResolvedValueOnce(undefined);
  await expect(saveWithFreeName({ save }, base, base)).resolves.toBe(
    "sf-weather-3",
  );
  expect(save.mock.calls.map((call) => call[1].name)).toEqual([
    "sf-weather",
    "sf-weather-2",
    "sf-weather-3",
  ]);
});

it("stops at the cap and reports the refusal", async () => {
  const save = vi.fn(async (_base: unknown, draft: { name: string }) => {
    throw taken(draft.name);
  });
  await expect(saveWithFreeName({ save }, base, base)).rejects.toBeInstanceOf(
    PublishRejected,
  );
  expect(save).toHaveBeenCalledTimes(1 + FREE_NAME_ATTEMPTS);
});

it("never retries another error", async () => {
  const save = vi.fn().mockRejectedValue(new Error("Permission denied"));
  await expect(saveWithFreeName({ save }, base, base)).rejects.toThrow(
    "Permission denied",
  );
  expect(save).toHaveBeenCalledOnce();
});
