import { expect, it, vi } from "vitest";
import { importAttention, watchAttentionImport } from "./attention-import";
import type { Agents } from "./service";
import type { Agent } from "./service";
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
const relay = () => ({
  subscribe: () => () => {},
  snapshot: () => ({
    status: "ready",
    session: {
      channels: {
        list: () => ({ channels: [{ id: registration.channel }] }),
        subscribeList: () => () => {},
      },
    },
  }),
});
it("saves the Interest and watch before archiving and preserves Attention off", async () => {
  const order: string[] = [];
  const agent = { key: "agent", place: "here", attention: {} } as Agent;
  const save = vi.fn(async () => {
    order.push("saved");
  });
  const agents = {
    find: () => undefined,
    relay,
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
        provider: "attention/command",
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
    relay,
    snapshot: () => ({
      running: [
        { pubkey: "agent", key: "agent", place: "here", attention: {} },
      ],
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
    relay,
    snapshot: () => ({
      running: [
        {
          pubkey: "agent",
          key: "agent",
          place: "here",
          attentionEnabled: true,
        },
      ],
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
    relay,
    snapshot: () => ({ running }),
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
  running = [
    { pubkey: "other", key: "other", place: "here", attention: {} } as Agent,
  ];
  changed();
  await vi.waitFor(() => expect(warning).toHaveBeenCalled());
  expect(save).not.toHaveBeenCalled();
  running = [
    ...running,
    { pubkey: "agent", key: "agent", place: "here", attention: {} } as Agent,
  ];
  changed();
  await vi.waitFor(() =>
    expect(save).toHaveBeenCalledWith("agent", expect.anything()),
  );
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3));
  stop();
  warning.mockRestore();
});

it("retains a registration when its existing Interest has different instructions", async () => {
  const spawn = vi.fn(async (_id: string, options?: HostProcessOptions) => {
    options?.onStdout?.(JSON.stringify([registration]));
    return {
      write: async () => {},
      end: async () => {},
      kill: async () => {},
      exited: Promise.resolve(0),
    };
  });
  const save = vi.fn();
  await importAttention(
    {
      relay,
      snapshot: () => ({
        running: [
          {
            pubkey: "agent",
            key: "agent",
            place: "here",
            attention: {
              "interest/monitor-check": {
                value: { type: "interest", instructions: "Another task" },
              },
            },
          },
        ],
      }),
      save,
    } as unknown as Agents,
    { spawn },
  );
  expect(save).not.toHaveBeenCalled();
  expect(spawn).toHaveBeenCalledTimes(1);
});

it.each([
  ["registration", true, true],
  ["wake", true, true],
  ["registration", false, true],
  ["registration", false, false],
  ["wake", false, true],
  ["wake", false, false],
])(
  "imports %s into its destination membership (home present: %s, owner sees channel: %s)",
  async (kind, hasHome, visible) => {
    const home = {
      key: "agent",
      pubkey: "agent",
      place: "here",
      attention: {},
      attentionEnabled: true,
    };
    const target = { ...home, key: visible ? "agent@other.example" : home.key };
    const save = vi.fn(async () => {}),
      wake = vi.fn();
    const agents = {
      snapshot: () => ({ running: hasHome ? [home, target] : [target] }),
      save,
      wake,
      relay: (key: string) => ({
        snapshot: () => ({
          status: "ready",
          session: {
            channels: {
              list: () => ({
                channels:
                  visible && key === target.key
                    ? [{ id: registration.channel }]
                    : [],
              }),
            },
          },
        }),
      }),
    } as unknown as Agents;
    const spawn = vi.fn(async (_id: string, options?: HostProcessOptions) => {
      if (!options?.args?.length)
        options?.onStdout?.(
          JSON.stringify([
            kind === "registration"
              ? registration
              : {
                  file: "wake.json",
                  signature: "abc",
                  wake: {
                    agent: "agent",
                    channel: registration.channel,
                    text: "Review complete",
                  },
                },
          ]),
        );
      return {
        write: async () => {},
        end: async () => {},
        kill: async () => {},
        exited: Promise.resolve(0),
      };
    });
    await importAttention(agents, { spawn });
    expect(kind === "registration" ? save : wake).toHaveBeenCalledWith(
      target.key,
      expect.anything(),
    );
    expect(spawn).toHaveBeenCalledTimes(2);
  },
);

it.each(["registration", "wake"])(
  "retains %s when only a foreign membership remains and the destination is unknown",
  async (kind) => {
    const save = vi.fn(),
      wake = vi.fn();
    const agents = {
      snapshot: () => ({
        running: [
          {
            key: "agent@other",
            pubkey: "agent",
            place: "here",
            attention: {},
            attentionEnabled: true,
          },
        ],
      }),
      relay: () => ({
        snapshot: () => ({
          status: "ready",
          session: { channels: { list: () => ({ channels: [] }) } },
        }),
      }),
      save,
      wake,
    } as unknown as Agents;
    const spawn = vi.fn(async (_id: string, options?: HostProcessOptions) => {
      options?.onStdout?.(
        JSON.stringify([
          kind === "registration"
            ? registration
            : {
                file: "wake.json",
                signature: "abc",
                wake: {
                  agent: "agent",
                  channel: registration.channel,
                  text: "Done",
                },
              },
        ]),
      );
      return {
        write: async () => {},
        end: async () => {},
        kill: async () => {},
        exited: Promise.resolve(0),
      };
    });
    await importAttention(agents, { spawn });
    expect(save).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
  },
);

it("retains ambiguous destination memberships without saving or archiving", async () => {
  const save = vi.fn();
  const agents = {
    relay,
    snapshot: () => ({
      running: ["agent", "agent@other.example"].map((key) => ({
        key,
        pubkey: "agent",
        place: "here",
        attention: {},
      })),
    }),
    save,
  } as unknown as Agents;
  const spawn = vi.fn(async (_id: string, options?: HostProcessOptions) => {
    options?.onStdout?.(JSON.stringify([registration]));
    return {
      write: async () => {},
      end: async () => {},
      kill: async () => {},
      exited: Promise.resolve(0),
    };
  });
  await importAttention(agents, { spawn });
  expect(save).not.toHaveBeenCalled();
  expect(spawn).toHaveBeenCalledTimes(1);
});

it("reads retry connection status using the membership key", async () => {
  const lookup = vi.fn(relay);
  const agents = {
    relay: lookup,
    snapshot: () => ({
      running: [
        { key: "agent@other.example", pubkey: "agent", attentionEnabled: true },
      ],
    }),
    subscribe: () => () => {},
  } as unknown as Agents;
  const stop = watchAttentionImport(agents, {
    spawn: async (_id, options) => {
      options?.onStdout?.("[]");
      return {
        write: async () => {},
        end: async () => {},
        kill: async () => {},
        exited: Promise.resolve(0),
      };
    },
  });
  expect(lookup).toHaveBeenCalledWith("agent@other.example");
  stop();
});

it("retries discovery after a session replacement and cleans up its listeners", async () => {
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  const relayListeners = new Set<() => void>();
  const oldListeners = new Set<() => void>(),
    newListeners = new Set<() => void>();
  let discovered = false;
  const session = (listeners: Set<() => void>) => ({
    channels: {
      list: () => ({
        channels: discovered ? [{ id: registration.channel }] : [],
      }),
      subscribeList: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  let current = session(oldListeners);
  const connection = {
    snapshot: () => ({ status: "ready", session: current }),
    subscribe: (listener: () => void) => {
      relayListeners.add(listener);
      return () => relayListeners.delete(listener);
    },
  };
  const save = vi.fn(async () => {});
  const agents = {
    snapshot: () => ({
      running: [
        { key: "agent", pubkey: "agent", place: "here", attention: {} },
        { key: "agent@other", pubkey: "agent", place: "here", attention: {} },
      ],
    }),
    relay: (key: string) =>
      key === "agent"
        ? connection
        : {
            snapshot: () => ({
              status: "ready",
              session: {
                channels: {
                  list: () => ({ channels: [] }),
                  subscribeList: () => () => {},
                },
              },
            }),
            subscribe: () => () => {},
          },
    subscribe: () => () => {},
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
  try {
    await vi.waitFor(() => expect(warnings).toHaveBeenCalled());
    expect(save).not.toHaveBeenCalled();
    expect(oldListeners.size).toBe(1);
    current = session(newListeners);
    for (const listener of [...relayListeners]) listener();
    expect(oldListeners.size).toBe(0);
    expect(newListeners.size).toBe(1);
    discovered = true;
    for (const listener of [...newListeners]) listener();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3));
  } finally {
    stop();
    warnings.mockRestore();
  }
  expect(newListeners.size).toBe(0);
  expect(relayListeners.size).toBe(0);
});
