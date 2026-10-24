// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import type { RelayData } from "../relay/service";
import type { SoloTaskRow } from "./solo-navigation-contract";
import { SoloNavigationService, soloMovePolicy } from "./solo-navigation";
import { writeView } from "../../shared/view-state";
afterEach(() => localStorage.clear());
it("uses one scoped snapshot for placement without a sidebar, fences replacement, and restores fallback", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const owner = createRelaySession(null);
  const channels = ["parent", "child"].map(
    (id) => ({ id, name: id, channelType: "solo" }) as ChannelSummary,
  );
  const session = {
    ...owner.session,
    channels: {
      ...owner.session.channels,
      list: () => ({ status: "ready" as const, channels }),
    },
  };
  const state = {
    status: "ready" as const,
    session,
    scope: "scope",
    viewer: "viewer",
    generation: 1,
  };
  const relay = {
    snapshot: () => state,
    subscribe: () => () => {},
  } as unknown as RelayData;
  const service = new SoloNavigationService(root, relay);
  let revision = 0;
  let rows: readonly SoloTaskRow[] = [
    { channelId: "parent", status: "running" },
    { channelId: "child", parentChannelId: "parent", status: "waiting" },
  ];
  let changed = () => {};
  const read = vi.fn(() => ({ rows }));
  const run = vi.fn();
  const fiber = root
    .extend({ pluginOwner: { id: "example", revision: "one" } })
    .plugin((ctx) => {
      ctx.soloNavigation.register({
        id: "tasks",
        title: "Nexus",
        childNoun: { one: "Worker", other: "Workers" },
        dataRevision: () => revision,
        read,
        subscribe: (listener) => {
          changed = listener;
          return () => {
            changed = () => {};
          };
        },
        create: { label: "New task…", run },
      });
    });
  try {
    await fiber.await();
    await vi.waitFor(() =>
      expect(soloMovePolicy(session, "child")).toEqual({
        root: "parent",
        title: "parent",
      }),
    );
    expect(read).toHaveBeenCalledTimes(1);
    service.setOptions({ group: "status", sort: "name", show: "all-tasks" });
    expect(read).toHaveBeenCalledTimes(1);
    writeView("scope", "solo-view:example/tasks", {
      group: "none",
      sort: "bad",
    });
    expect(service.snapshot()?.options).toEqual({
      group: "none",
      sort: "recent",
      show: "all-chats",
    });
    rows = [
      { channelId: "parent", parentChannelId: "child", status: "running" },
      { channelId: "child", parentChannelId: "parent", status: "waiting" },
    ];
    revision++;
    changed();
    expect(service.snapshot()).toBeUndefined();
    expect(soloMovePolicy(session, "child")).toBeUndefined();
    rows = [];
    revision++;
    changed();
    expect(service.snapshot()?.enhancement.title).toBe("Nexus");
    await fiber.dispose();
    await service.create();
    expect(run).not.toHaveBeenCalled();
    expect(service.snapshot()).toBeUndefined();
  } finally {
    await root.fiber.dispose();
    owner.dispose();
  }
});
