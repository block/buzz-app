import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import { DecisionsService } from "../../features/decisions/service";
import { flush } from "../../features/relay/testing";
import { createApply, inject } from ".";
import type { TypeSafeNative } from "./key";

const ONE = "wss://one.example";
const TWO = "wss://two.example";
const question = { a: { type: "yes_no" as const, instructions: "y" } };

/** The joined communities, as the community reader reports them. */
function reader(ids: readonly string[] = [ONE, TWO]) {
  const listeners = new Set<() => void>();
  let state = {
    status: "ready" as "loading" | "ready",
    memberships: ids.map((id) => ({ id })),
  };
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set(next: typeof state) {
      state = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** Native with a saved key for each of `saved` (by relay host). */
function fakeNative(saved: string[] = []) {
  const keys = new Set(saved);
  const host = (community: string) => new URL(community).host.toLowerCase();
  return {
    keys,
    status: vi.fn(async (community: string) => keys.has(host(community))),
    setKey: vi.fn(async (community: string, _key: string) => {
      keys.add(host(community));
    }),
    clearKey: vi.fn(async (community: string) => {
      keys.delete(host(community));
    }),
    adopt: vi.fn(async (_: readonly string[]) => {}),
    decide: vi.fn(
      async (_: unknown): Promise<unknown> => ({
        outcome: "answered",
        backend: "typesafe",
        model: "jev-1.13.0",
        answers: { a: { type: "yes_no", probability: 0.4 } },
      }),
    ),
  } satisfies TypeSafeNative & { keys: Set<string> };
}

async function setup(
  native: Parameters<typeof createApply>[0],
  communities = reader(),
) {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  root.provide("communityReader", communities);
  const decisions = new DecisionsService(root, undefined);
  await root
    .extend({ pluginOwner: { id: "buzz.typesafe", revision: "one" } })
    .plugin({ inject, apply: createApply(native) })
    .await();
  await flush();
  return decisions;
}

it("offers TypeSafe as a decision provider, which needs a key in the browser", async () => {
  const decisions = await setup(() => undefined);
  expect(decisions.providers().map((provider) => provider.label)).toEqual([
    "TypeSafe",
  ]);
  expect(decisions.backend(ONE)).toBe("buzz.typesafe/typesafe");
  expect(decisions.status(ONE)).toBe("needs-setup");
  await expect(
    decisions.decide({ state: "x", questions: question, community: ONE }),
  ).resolves.toEqual({
    outcome: "failed",
    backend: "buzz.typesafe/typesafe",
    reason: "unavailable",
  });
});

it("is ready in each community with its own key, and asks native to decide", async () => {
  const native = fakeNative(["one.example"]);
  const decisions = await setup(() => native);
  // The joined communities' keys are read at once.
  expect(decisions.status(ONE)).toBe("ready");
  expect(decisions.status("https://ONE.example/")).toBe("ready");
  expect(decisions.status(TWO)).toBe("needs-setup");
  // Another is read when first asked about.
  expect(decisions.status("wss://three.example")).toBe("checking");
  await flush();
  expect(decisions.status("wss://three.example")).toBe("needs-setup");
  const request = { state: "x", questions: question, community: ONE };
  await expect(decisions.decide(request)).resolves.toEqual({
    outcome: "answered",
    backend: "buzz.typesafe/typesafe",
    model: "jev-1.13.0",
    answers: { a: { type: "yes_no", probability: 0.4 } },
  });
  // The service names the community by its relay origin.
  expect(native.decide).toHaveBeenCalledWith({
    ...request,
    community: "https://one.example",
    timeoutMs: 30_000,
  });
});

it("has no key for a request that names no community, and never asks native", async () => {
  const native = fakeNative(["one.example"]);
  const decisions = await setup(() => native);
  expect(decisions.status()).toBe("needs-setup");
  await expect(
    decisions.decide({ state: "x", questions: question }),
  ).resolves.toEqual({
    outcome: "failed",
    backend: "buzz.typesafe/typesafe",
    reason: "missing_credentials",
  });
  expect(native.decide).not.toHaveBeenCalled();
});

it("saves and removes one community's key without changing another's", async () => {
  const native = fakeNative(["one.example", "two.example"]);
  const decisions = await setup(() => native);
  const provider = decisions.providers()[0];
  if (!provider) throw new Error("No provider");
  decisions.status(ONE);
  decisions.status(TWO);
  await flush();
  expect([decisions.status(ONE), decisions.status(TWO)]).toEqual([
    "ready",
    "ready",
  ]);
  // The Settings row edits its own community's key.
  const { TypeSafeKeys } = await import("./key");
  const keys = new TypeSafeKeys(native);
  await keys.for(ONE).clear();
  expect(native.clearKey).toHaveBeenCalledWith(ONE);
  expect(keys.for(ONE).snapshot()).toBe("missing");
  expect(keys.for(TWO).snapshot()).toBe("checking");
  await flush();
  expect(keys.for(TWO).snapshot()).toBe("saved");
  await keys.for(ONE).save("tk");
  expect(native.setKey).toHaveBeenCalledWith(ONE, "tk");
  expect(keys.for("https://one.example/").snapshot()).toBe("saved");
});

it("gives the old key to the joined communities before reading any key", async () => {
  const native = fakeNative();
  let adopted = () => {};
  native.adopt.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        adopted = () => {
          native.keys.add("one.example");
          resolve();
        };
      }),
  );
  const communities = reader();
  communities.set({ status: "loading", memberships: [] });
  const decisions = await setup(() => native, communities);
  // Still loading: nothing is adopted or read yet.
  expect(decisions.status(ONE)).toBe("checking");
  expect(native.adopt).not.toHaveBeenCalled();
  communities.set({
    status: "ready",
    memberships: [{ id: ONE }, { id: TWO }],
  });
  expect(native.adopt).toHaveBeenCalledWith([
    "https://one.example",
    "https://two.example",
  ]);
  await flush();
  expect(decisions.status(ONE)).toBe("checking");
  expect(native.status).not.toHaveBeenCalled();
  adopted();
  await flush();
  decisions.status(ONE);
  await flush();
  expect(decisions.status(ONE)).toBe("ready");
  // Later changes to the joined communities adopt nothing more.
  communities.set({
    status: "ready",
    memberships: [{ id: "wss://three.example" }],
  });
  expect(native.adopt).toHaveBeenCalledOnce();
});

it("reads keys even when adopting the old key fails", async () => {
  const native = fakeNative(["one.example"]);
  native.adopt.mockRejectedValue(new Error("locked"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const decisions = await setup(() => native);
  await flush();
  decisions.status(ONE);
  await flush();
  expect(decisions.status(ONE)).toBe("ready");
  warn.mockRestore();
});

it.each([
  ["invalid args `request` for command `decide`", "invalid_request"],
  ["decisions.decide not allowed", "service_error"],
])("reports a native rejection (%s) as %s", async (message, reason) => {
  const native = fakeNative(["one.example"]);
  native.decide.mockImplementation(async () => {
    throw message;
  });
  const decisions = await setup(() => native);
  await expect(
    decisions.decide({ state: "x", questions: question, community: ONE }),
  ).resolves.toEqual({
    outcome: "failed",
    backend: "buzz.typesafe/typesafe",
    reason,
  });
});
