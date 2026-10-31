import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import { link } from "./link";
import { createLocalAgentActivity } from "./local-activity";
import { AgentsRunnerService } from "./runner-service";
import type { AgentCommunities } from "./service";
import { memoryStorage } from "./test-fakes";

it("runs without the Manager, which hears its agent types over the link", async () => {
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const plugin = ctx.extend({
    pluginOwner: Object.freeze({ id: "example", revision: "one" }),
  });
  const channel = new MessageChannel();
  const communities = {
    snapshot: () => ({ viewer: undefined }),
    subscribe: () => () => {},
    open: () => undefined,
  } as unknown as AgentCommunities;
  const runner = new AgentsRunnerService(ctx, channel.port1, {
    communities,
    native: undefined,
    storage: memoryStorage(),
    localActivity: createLocalAgentActivity(),
    decisions: undefined,
  });
  const manager = link(channel.port2);
  manager.watch("runner.types", null, () => {});
  runner.register(plugin, {
    id: "echo",
    title: "Echo",
    defaults: () => ({ config: {} }),
    run: () => {},
  });
  await vi.waitFor(() =>
    expect(manager.read("runner.types")).toEqual([
      expect.objectContaining({ key: "example/echo", title: "Echo" }),
    ]),
  );
  // A hosted type is the Manager's.
  expect(() =>
    runner.register(plugin, {
      id: "hosted",
      title: "Hosted",
      defaults: () => ({ config: {} }),
      remote: {
        provision: async () => ({}),
        activate: async () => {},
        profile: async () => {},
        remove: async () => {},
      },
    } as never),
  ).toThrow("A hosted agent type runs elsewhere");
  manager.close();
  await ctx.fiber.dispose();
});
