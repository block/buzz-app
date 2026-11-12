import { respondExternal } from "./external";
import { afterEach, expect, it, vi } from "vitest";
import { agentSidebar } from "../features/agents/sidebar";
import type { AgentHandle } from "../features/agents/service";
import type { ChannelSummary } from "../features/relay/contracts";
import type { RelaySession } from "../features/relay/session";
import { createSidebarPreferencesStore } from "../features/relay/sidebar-preferences-store";
import type { SidebarPreferences } from "../features/relay/sidebar-preferences";
import { appClient } from "./app-client";
import type { BuzzClient } from "./client";
import { respond } from "./rpc";
import { sessionTools } from "./session-tools";

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

function setup() {
  let saved: SidebarPreferences = {
    sections: [
      { id: "work", name: "Work", order: 0 },
      { id: "later", name: "Later", order: 1 },
    ],
    assignments: { other: "later" },
    starred: ["alpha"],
    muted: ["other"],
  };
  const read = vi.fn(async () => saved);
  const write = vi.fn(
    async ({
      channelId,
      sectionId,
    }: {
      channelId?: string;
      sectionId?: string;
    }) => {
      const assignments = { ...saved.assignments };
      if (channelId) {
        if (sectionId) assignments[channelId] = sectionId;
        else delete assignments[channelId];
      }
      saved = { ...saved, assignments };
      return { sections: saved.sections, assignments };
    },
  );
  const writeStar = vi.fn(async ({ channelId }: { channelId: string }) => {
    saved = {
      ...saved,
      starred: saved.starred.filter((id) => id !== channelId),
    };
    return saved.starred;
  });
  const store = createSidebarPreferencesStore({
    available: true,
    read,
    write,
    writeStar,
  });
  disposals.push(() => store.dispose());
  const channels: ChannelSummary[] = [
    { id: "alpha", name: "alpha", channelType: "stream", members: ["owner"] },
    {
      id: "beta",
      name: "beta",
      channelType: "dm",
      hidden: true,
      members: ["owner"],
    },
  ];
  const session = {
    sidebarPreferences: store.queries,
    channels: { list: () => ({ status: "ready", channels }) },
  } as unknown as RelaySession;
  let bound: RelaySession | undefined = session;
  const controller = new AbortController();
  const sidebar = agentSidebar(() => bound, "owner");
  const client = appClient(
    { pubkey: "agent", owner: "owner", sidebar } as unknown as AgentHandle,
    {
      read: vi.fn(),
      memories: async () => ({ entries: [], partial: false }),
      signal: controller.signal,
    },
  );
  return {
    client,
    channels,
    store,
    controller,
    read,
    write,
    writeStar,
    saved: () => saved,
    disconnect: () => {
      bound = undefined;
    },
  };
}
async function call(client: BuzzClient, name: string, args: unknown = {}) {
  const reply = (await respond(
    client,
    {},
    { id: 1, method: "tools/call", params: { name, arguments: args } },
  )) as {
    result: { content: { text: string }[]; isError?: boolean };
  };
  return reply.result;
}

it("lists sections, moves joined channels, retries rejected writes, and restores the default group through RPC", async () => {
  const f = setup();
  expect(
    JSON.parse((await call(f.client, "section_list")).content[0]?.text ?? ""),
  ).toEqual({ sections: f.saved().sections, assignments: { other: "later" } });
  expect(
    (
      await call(f.client, "channel_move", {
        channel: "alpha",
        section: "work",
      })
    ).isError,
  ).toBeUndefined();
  expect(f.store.queries.snapshot().data).toMatchObject({
    assignments: { alpha: "work", other: "later" },
    starred: [],
    muted: ["other"],
  });
  f.write.mockRejectedValueOnce(new Error("publication refused"));
  const failed = await call(f.client, "channel_move", {
    channel: "beta",
    section: "work",
  });
  expect(failed).toMatchObject({ isError: true });
  expect(failed.content[0]?.text ?? "").toContain("publication refused");
  expect(f.saved().assignments).not.toHaveProperty("beta");
  expect(
    (await call(f.client, "channel_move", { channel: "beta", section: "work" }))
      .isError,
  ).toBeUndefined();
  expect(
    (await call(f.client, "channel_move", { channel: "alpha" })).isError,
  ).toBeUndefined();
  expect(f.saved().assignments).toEqual({ beta: "work", other: "later" });
  expect(f.saved().sections).toHaveLength(2);
});

it("rejects bad arguments and unknown sections before any preference write", async () => {
  const f = setup();
  for (const args of [
    {},
    { channel: null },
    { channel: " " },
    { channel: "x".repeat(257) },
    { channel: "alpha", section: "" },
    { channel: "alpha", section: null },
    { channel: "alpha", section: "missing" },
    { channel: "alpha", owner: "someone" },
  ])
    expect((await call(f.client, "channel_move", args)).isError).toBe(true);
  expect(
    (await call(f.client, "section_list", { channel: "alpha" })).isError,
  ).toBe(true);
  expect(f.write).not.toHaveBeenCalled();
  expect(f.writeStar).not.toHaveBeenCalled();
});

it.each([
  { members: ["agent"] },
  { cached: true },
  { metadataPending: true },
  { hidden: true, channelType: "stream" },
  { archived: true },
  { huddle: true },
  { channelType: "forum" },
  { channelType: "solo" },
  { channelType: "system" },
] as const)(
  "refuses unavailable or unsupported owner channels: %j",
  async (change) => {
    const f = setup();
    f.channels[0] = {
      id: "alpha",
      name: "alpha",
      members: ["owner"],
      ...change,
    };
    expect(
      (
        await call(f.client, "channel_move", {
          channel: "alpha",
          section: "work",
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await call(f.client, "channel_move", {
          channel: "missing",
          section: "work",
        })
      ).isError,
    ).toBe(true);
    expect(f.write).not.toHaveBeenCalled();
  },
);

it("reports preference read failures and recovers without overwriting unknown state", async () => {
  const f = setup();
  f.read.mockRejectedValueOnce(new Error("read unavailable"));
  expect((await call(f.client, "section_list")).isError).toBe(true);
  expect(f.write).not.toHaveBeenCalled();
  expect((await call(f.client, "section_list")).isError).toBeUndefined();
  expect(
    (
      await call(f.client, "channel_move", {
        channel: "alpha",
        section: "later",
      })
    ).isError,
  ).toBeUndefined();
  expect(f.saved().assignments).toEqual({ alpha: "later", other: "later" });
});

it.each(["cancel", "disconnect"])(
  "stops before writes when %s happens during preference loading",
  async (action) => {
    const f = setup();
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: (value: SidebarPreferences) => void;
    const pendingRead = new Promise<SidebarPreferences>((resolve) => {
      release = resolve;
    });
    f.read.mockImplementationOnce(() => {
      started();
      return pendingRead;
    });
    const pending = call(f.client, "channel_move", {
      channel: "alpha",
      section: "work",
    });
    try {
      await reading;
      if (action === "cancel") f.controller.abort();
      else f.disconnect();
      release(f.saved());
      expect((await pending).isError).toBe(true);
      expect(f.write).not.toHaveBeenCalled();
    } finally {
      release(f.saved());
      await pending;
    }
  },
);

it("loads section tools on search only for owner-capable connections and withholds access from plugin tools", async () => {
  const { client } = setup();
  const list = async (given: BuzzClient) => {
    const reply = (await respond(
      given,
      {},
      { id: 1, method: "tools/list" },
    )) as { result: { tools: { name: string }[] } };
    return reply.result.tools.map(({ name }) => name);
  };
  for (const name of ["section_list", "channel_move"]) {
    expect(await list(client)).toContain(name);
    expect(await list({} as BuzzClient)).not.toContain(name);
    expect(sessionTools().find((tool) => tool.name === name)?.load).toBe(
      "search",
    );
    expect((await call({} as BuzzClient, name)).isError).toBe(true);
  }
  const seen = vi.fn();
  await respond(
    client,
    {},
    { id: 1, method: "tools/call", params: { name: "plugin_tool" } },
    [
      {
        name: "plugin_tool",
        description: "Example",
        inputSchema: { type: "object" },
        call: async (given) => {
          seen(given.sidebar);
          return "done";
        },
      },
    ],
  );
  expect(seen).toHaveBeenCalledExactlyOnceWith(undefined);
});

it("requires full-agent external approval before changing owner sidebar preferences", async () => {
  const f = setup();
  const request = {
    id: 1,
    method: "tools/call",
    params: {
      name: "channel_move",
      arguments: { channel: "alpha", section: "work" },
    },
  };
  const denied = await respondExternal(
    f.client,
    request,
    () => {},
    [],
    () => [],
  );
  expect(denied).toMatchObject({ result: { isError: true } });
  expect(f.write).not.toHaveBeenCalled();
  const approved = await respondExternal(
    f.client,
    request,
    () => {},
    ["agent"],
    () => [],
  );
  expect(approved).toMatchObject({
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({ channel: "alpha", section: "work" }),
        },
      ],
    },
  });
  expect(f.saved().assignments).toMatchObject({ alpha: "work" });
});
