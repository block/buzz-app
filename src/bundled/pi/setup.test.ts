// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { Pi } from "./pi";
import { explainTurn, PiSetup } from "./setup";

/** A Pi host that answers every request with `reply`. */
const pi = (reply: () => Promise<unknown>) => {
  const request = vi.fn(reply);
  return { request, host: { request } as unknown as Pick<Pi, "request"> };
};
const SETTINGS = "buzz://settings?section=agents&provider=buzz.pi%2Fpi";

it("removes a provider's key with Pi's logout, naming only that provider", async () => {
  const { request, host } = pi(async () => ({}));
  await new PiSetup(host).logout("openai");
  expect(request).toHaveBeenCalledWith("logout", { provider: "openai" });
  expect(request).toHaveBeenCalledTimes(1);
});

it("lets a failed removal reach the caller", async () => {
  const { host } = pi(async () => {
    throw new Error("auth.json is locked");
  });
  await expect(new PiSetup(host).logout("openai")).rejects.toThrow(
    "auth.json is locked",
  );
});

it("explains a provider Pi has no key for, quoting Pi", () => {
  expect(explainTurn("Provider is not configured: openai", SETTINGS)).toBe(
    `Pi is missing an API key for openai. Head to [Settings](${SETTINGS}) to add one.\n\nPi said:\n> Provider is not configured: openai`,
  );
});

it("leaves any other failure as it is", () => {
  expect(explainTurn("401 invalid x-api-key", SETTINGS)).toBe(
    "401 invalid x-api-key",
  );
});
