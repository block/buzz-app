import { expect, it, vi } from "vitest";
import { importAttention, watchAttentionImport } from "./attention-import";
import type { Agents, Agent } from "./service";
import type { HostProcessOptions } from "../host/service";

const registration = {
  file: "check.json",
  signature: "abc",
  agents: ["agent"],
  channel: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  name: "check",
  title: "Check",
  instructions: "Report changes",
  command: ["check"],
  cwd: "/tmp",
};
it("saves the Interest and watch before archiving and preserves Attention off", async () => {
  const order: string[] = [];
  const agent = { place: "here", attention: {} } as Agent;
  const save = vi.fn(async () => {
    order.push("saved");
  });
  const agents = {
    find: () => undefined,
    snapshot: () => ({ running: [{ ...agent, pubkey: "agent" }] }),
    save,
  } as unknown as Agents;
  await importAttention(agents, {
    spawn: async (_id, options) => {
      const archive = Boolean(options?.args?.length);
      if (archive) order.push("archive");
      else options?.onStdout?.(JSON.stringify([registration]));
      return {
        write: async () => {},
        end: async () => {},
        kill: async () => {},
        exited: Promise.resolve(0),
      };
    },
  });
  expect(order).toEqual(["saved", "archive"]);
  expect(save).toHaveBeenCalledWith("agent", {
    attention: {
      "interest/monitor-check": {
        type: "interest",
        instructions: "Report changes",
      },
      "watch/monitor-check": {
        type: "source",
        provider: "buzz.agents/command",
        enabled: true,
        interest_id: "monitor-check",
        name: "Check",
        channel: registration.channel,
        config: { command: ["check"], cwd: "/tmp" },
      },
    },
  });
});
it("keeps a registration recoverable when saving fails", async () => {
  const spawn = vi.fn(async (_id: string, options?: HostProcessOptions) => {
    options?.onStdout?.(JSON.stringify([registration]));
    return {
      write: async () => {},
      end: async () => {},
      kill: async () => {},
      exited: Promise.resolve(0),
    };
  });
  const agents = {
    snapshot: () => ({
      running: [{ pubkey: "agent", place: "here", attention: {} }],
    }),
    save: async () => {
      throw new Error("disk full");
    },
  } as unknown as Agents;
  await importAttention(agents, { spawn });
  expect(spawn).toHaveBeenCalledTimes(1);
});

it("archives a pending legacy wake only after queuing it for its original conversation", async () => {
  const order: string[] = [];
  const wake = {
    agent: "agent",
    channel: registration.channel,
    thread: "e".repeat(64),
    text: "Review complete",
  };
  const agents = {
    snapshot: () => ({
      running: [{ pubkey: "agent", place: "here", attentionEnabled: true }],
    }),
    wake: (_agent: string, delivery: object) => {
      expect(delivery).toEqual({
        channel: wake.channel,
        root: wake.thread,
        text: wake.text,
      });
      order.push("queued");
    },
  } as unknown as Agents;
  await importAttention(agents, {
    spawn: async (_id, options) => {
      if (options?.args?.length) {
        expect(options.args[0]).toBe("archive-wake");
        order.push("archive");
      } else
        options?.onStdout?.(
          JSON.stringify([{ file: "wake.json", signature: "abc", wake }]),
        );
      return {
        write: async () => {},
        end: async () => {},
        kill: async () => {},
        exited: Promise.resolve(0),
      };
    },
  });
  expect(order).toEqual(["queued", "archive"]);
});

it("retries retained imports when another community's local recipient becomes available", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  let running: Agent[] = [];
  let changed = () => {};
  const save = vi.fn(async () => {});
  const agents = {
    snapshot: () => ({ running }),
    relay: () => ({ snapshot: () => ({ status: "ready" }) }),
    subscribe: (listener: () => void) => {
      changed = listener;
      return () => {};
    },
    save,
  } as unknown as Agents;
  const spawn = vi.fn(async (_id: string, options?: HostProcessOptions) => {
    if (!options?.args?.length)
      options?.onStdout?.(JSON.stringify([registration]));
    return {
      write: async () => {},
      end: async () => {},
      kill: async () => {},
      exited: Promise.resolve(0),
    };
  });
  const stop = watchAttentionImport(agents, { spawn });
  running = [{ pubkey: "other", place: "here", attention: {} } as Agent];
  changed();
  await vi.waitFor(() => expect(warning).toHaveBeenCalled());
  expect(save).not.toHaveBeenCalled();
  running = [
    ...running,
    { pubkey: "agent", place: "here", attention: {} } as Agent,
  ];
  changed();
  await vi.waitFor(() =>
    expect(save).toHaveBeenCalledWith("agent", expect.anything()),
  );
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3));
  stop();
  warning.mockRestore();
});
