import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentRouting, type AgentRoutingRequest } from "./agent-routing";

const a = "1".repeat(64),
  b = "2".repeat(64);
const request: AgentRoutingRequest = {
  channelId: "chat",
  text: "Check my calendar",
  context: [],
  candidates: [a, b].map((pubkey) => ({
    pubkey,
    name: pubkey,
    description: "Calendar",
  })),
};
const roots: Context[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose();
});
function setup() {
  const root = new Context();
  roots.push(root);
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
    settled: () => true,
  });
  const owner = root.extend({
    pluginOwner: { id: "test.router", revision: "one" },
  });
  return { router: createAgentRouting(root), owner };
}

it("keeps normal behavior without a plugin, or with one candidate", async () => {
  const h = setup(),
    run = vi.fn(async () => [a]);
  expect(
    await h.router.route(request, new AbortController().signal),
  ).toBeUndefined();
  h.router.register({ id: "one", route: run }, h.owner);
  expect(
    await h.router.route(
      { ...request, candidates: request.candidates.slice(0, 1) },
      new AbortController().signal,
    ),
  ).toBeUndefined();
  expect(run).not.toHaveBeenCalled();
});

it.each([[a], [b], [a, b]])(
  "accepts the selected set %j in candidate order",
  async (...selected) => {
    const h = setup();
    h.router.register({ id: "one", route: async () => selected }, h.owner);
    expect(await h.router.route(request, new AbortController().signal)).toEqual(
      selected,
    );
  },
);

it.each([[], [a, a], ["3".repeat(64)]])(
  "rejects invalid assignments %j instead of starting all agents",
  async (...selected) => {
    const h = setup();
    h.router.register({ id: "one", route: async () => selected }, h.owner);
    await expect(
      h.router.route(request, new AbortController().signal),
    ).rejects.toThrow("valid set");
  },
);

it("rejects a late result after the contributing plugin unloads", async () => {
  const h = setup();
  let resolve!: (value: string[]) => void;
  h.router.register(
    {
      id: "one",
      route: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
    h.owner,
  );
  const pending = h.router.route(request, new AbortController().signal);
  await h.owner.fiber.dispose();
  resolve([a]);
  await expect(pending).rejects.toThrow("router changed");
});

it("rejects a pending result if a second router becomes active", async () => {
  const h = setup();
  let finish!: (value: string[]) => void;
  h.router.register(
    {
      id: "one",
      route: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
    h.owner,
  );
  const pending = h.router.route(request, new AbortController().signal);
  h.router.register({ id: "two", route: async () => [b] }, h.owner);
  finish([a]);
  await expect(pending).rejects.toThrow("router changed");
});

it("bounds a stalled decision and cancels a send without awaiting the plugin", async () => {
  vi.useFakeTimers();
  const h = setup();
  h.router.register({ id: "one", route: () => new Promise(() => {}) }, h.owner);
  const control = new AbortController();
  const canceled = expect(
    h.router.route(request, control.signal),
  ).rejects.toThrow("canceled");
  control.abort(new Error("canceled"));
  await canceled;
  const expired = expect(
    h.router.route(request, new AbortController().signal),
  ).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(15_000);
  await expired;
});

it("refuses ambiguous plugin policies", async () => {
  const h = setup();
  h.router.register({ id: "one", route: async () => [a] }, h.owner);
  h.router.register({ id: "two", route: async () => [b] }, h.owner);
  await expect(
    h.router.route(request, new AbortController().signal),
  ).rejects.toThrow("More than one");
});
