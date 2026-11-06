import { describe, expect, it, vi } from "vitest";
import type { ProtectionAction } from "../features/agent-protection/service";
import type { BuzzClient, OwnerAccess, OwnerChannel } from "./client";
import { OWNER_TOOLS, callOwnerTool, isOwnerTool } from "./owner";
import { respond } from "./rpc";
import {
  type AddedTool,
  callSessionTool,
  sessionHint,
  sessionTools,
} from "./session-tools";

const executedAs = {
  agent: "b".repeat(64),
  owner: "a".repeat(64),
  community: "https://relay.example.test",
};
const id = "11111111-1111-4111-8111-111111111111";
const channel = (name: string): OwnerChannel => ({
  id: `${name}-id`,
  name,
  type: "stream",
  visibility: "private",
  archived: false,
  role: null,
});

function owned() {
  return {
    channels: vi.fn<OwnerAccess["channels"]>(async () => ({
      execution: executedAs,
      channels: ["Plans", "Planning", "Lunch"].map(channel),
      partial: false,
    })),
    channel: vi.fn(async () => ({
      execution: executedAs,
      channel: channel("Plans"),
      capabilities: {
        manageRoles: false,
        removeMembers: false,
        archive: false,
        unarchive: false,
        delete: false,
      },
    })),
    members: vi.fn(async () => ({
      execution: executedAs,
      channel: id,
      total: 3,
      members: [{ pubkey: executedAs.owner, role: "owner" as const }],
    })),
    held: vi.fn<OwnerAccess["held"]>(),
  };
}
const clientWith = (fields: Partial<BuzzClient> = {}) =>
  ({
    pubkey: executedAs.agent,
    key: executedAs.agent,
    ...fields,
  }) as BuzzClient;

describe("callOwnerTool", () => {
  it("lists, filters and pages the owner's channels with who it ran as", async () => {
    const ownerAccess = owned();
    const client = clientWith({ ownerAccess });
    expect(
      JSON.parse(
        (
          await callOwnerTool(client, "owner_channel_list", {
            q: "PLAN",
            limit: 1,
          })
        ).text,
      ),
    ).toEqual({
      executedAs,
      channels: [channel("Plans")],
      total: 2,
      next: { offset: 1 },
      partial: false,
    });
    ownerAccess.channels.mockResolvedValueOnce({
      execution: executedAs,
      channels: [],
      partial: true,
      error: "offline",
    });
    expect(
      JSON.parse((await callOwnerTool(client, "owner_channel_list", {})).text),
    ).toEqual({
      executedAs,
      channels: [],
      total: 0,
      partial: true,
      error: "offline",
    });
  });

  it("answers a channel and a page of its members", async () => {
    const ownerAccess = owned();
    const client = clientWith({ ownerAccess });
    expect(
      JSON.parse(
        (await callOwnerTool(client, "owner_channel_get", { channel: id }))
          .text,
      ),
    ).toMatchObject({ executedAs, channel: { name: "Plans" } });
    expect(ownerAccess.channel).toHaveBeenCalledWith(id);
    expect(
      JSON.parse(
        (
          await callOwnerTool(client, "owner_member_list", {
            channel: id,
            offset: 1,
            limit: 1,
          })
        ).text,
      ),
    ).toEqual({
      executedAs,
      channel: id,
      total: 3,
      members: [{ pubkey: executedAs.owner, role: "owner" }],
      next: { offset: 2 },
    });
    expect(ownerAccess.members).toHaveBeenCalledWith(id, {
      offset: 1,
      limit: 1,
    });
    await callOwnerTool(client, "owner_member_list", {
      channel: id,
      limit: 900,
    });
    expect(ownerAccess.members).toHaveBeenLastCalledWith(id, {
      offset: 0,
      limit: 500,
    });
  });

  it.each([
    ["owner_channel_get", {}, "channel is required"],
    ["owner_channel_get", { channel: 7 }, "channel must be text"],
    ["owner_member_list", { channel: id, limit: 0 }, "limit must be"],
    ["owner_member_list", { channel: id, offset: -1 }, "offset must be"],
    ["owner_channel_list", { limit: 1.5 }, "limit must be"],
    // No argument may name another owner, account, community or agent.
    ["owner_channel_list", { owner: executedAs.agent }, "owner cannot be used"],
    ["owner_channel_get", { channel: id, community: "x" }, "cannot be used"],
  ])("rejects %s %j before reading", async (name, args, message) => {
    const ownerAccess = owned();
    await expect(
      callOwnerTool(clientWith({ ownerAccess }), name, args),
    ).rejects.toThrow(message);
    const { held: _, ...reads } = ownerAccess;
    for (const read of Object.values(reads))
      expect(read).not.toHaveBeenCalled();
  });

  it("reads nothing for a client without owner access", async () => {
    for (const { name } of OWNER_TOOLS)
      await expect(
        callOwnerTool(clientWith(), name, { channel: id }),
      ).rejects.toThrow("not available to this agent here; nothing was read");
  });

  it("names only the three read tools", () => {
    expect(OWNER_TOOLS.map(({ name }) => name)).toEqual([
      "owner_channel_list",
      "owner_channel_get",
      "owner_member_list",
    ]);
    expect(
      OWNER_TOOLS.every(
        (tool) =>
          tool.annotations?.readOnlyHint === true &&
          tool.inputSchema.additionalProperties === false,
      ),
    ).toBe(true);
    expect(isOwnerTool("owner_channel_list")).toBe(true);
    expect(isOwnerTool("owner_send")).toBe(false);
  });
});

describe("owner tools in the session", () => {
  const names = (tools: readonly { name: string }[]) =>
    tools.map(({ name }) => name);

  it("lists them only to a client with owner access, on search", async () => {
    expect(names(sessionTools()).some(isOwnerTool)).toBe(false);
    expect(sessionHint()).not.toContain("owner_channel_list");
    const tools = sessionTools([], true);
    expect(
      tools.filter((tool) => isOwnerTool(tool.name)).map((tool) => tool.load),
    ).toEqual(["search", "search", "search"]);
    expect(sessionHint([], true)).toContain("owner_channel_list");
    const list = async (client?: BuzzClient) =>
      (
        (await respond(client, {}, { id: 1, method: "tools/list" })) as {
          result: { tools: { name: string }[] };
        }
      ).result.tools;
    expect(names(await list()).some(isOwnerTool)).toBe(false);
    expect(names(await list(clientWith())).some(isOwnerTool)).toBe(false);
    expect(names(await list(clientWith({ ownerAccess: owned() })))).toEqual(
      expect.arrayContaining(names(OWNER_TOOLS)),
    );
  });

  it("refuses a direct or remembered call from a client without owner access", async () => {
    await expect(
      callSessionTool(clientWith(), {}, "owner_channel_list", {}),
    ).rejects.toThrow("nothing was read");
  });

  it("gives a plugin tool neither owner access nor settings, even one shadowing an owner tool", async () => {
    const ownerAccess = owned();
    const settings = { list: vi.fn(), get: vi.fn(), set: vi.fn() };
    const seen: BuzzClient[] = [];
    const plugin = (name: string): AddedTool => ({
      name,
      description: "A plugin's tool.",
      inputSchema: { type: "object" },
      call: async (client) => {
        seen.push(client);
        return "plugin";
      },
    });
    const client = clientWith({ ownerAccess, settings });
    for (const name of ["notes_add", "owner_channel_list"])
      expect(await callSessionTool(client, {}, name, {}, [plugin(name)])).toBe(
        "plugin",
      );
    expect(seen).toHaveLength(2);
    for (const each of seen) {
      expect("ownerAccess" in each).toBe(false);
      expect("settings" in each).toBe(false);
      expect(each.pubkey).toBe(executedAs.agent);
    }
    expect(ownerAccess.channels).not.toHaveBeenCalled();
  });

  it("releases an owner answer only after its review, while its binding holds", async () => {
    const ownerAccess = owned();
    const order: string[] = [];
    const protect = vi.fn(async (action: ProtectionAction) => {
      order.push(action.kind);
    });
    ownerAccess.held.mockImplementation(() => {
      order.push("held");
    });
    const client = clientWith({ ownerAccess, protect });
    expect(
      JSON.parse(
        String(await callSessionTool(client, {}, "owner_channel_list", {})),
      ),
    ).toMatchObject({ executedAs });
    expect(order).toEqual(["tool", "tool-result", "held"]);
    expect(ownerAccess.held).toHaveBeenCalledWith(executedAs);
    ownerAccess.held.mockImplementation(() => {
      throw new Error("changed during the call");
    });
    await expect(
      callSessionTool(client, {}, "owner_channel_list", {}),
    ).rejects.toThrow("changed during the call");
  });

  it("reads nothing when protection refuses the call, and withholds a refused result", async () => {
    const ownerAccess = owned();
    const protect = vi.fn(async (action: ProtectionAction) => {
      if (action.kind === "tool") throw new Error("denied action");
    });
    await expect(
      callSessionTool(
        clientWith({ ownerAccess, protect }),
        {},
        "owner_channel_list",
        {},
      ),
    ).rejects.toThrow("denied action");
    expect(ownerAccess.channels).not.toHaveBeenCalled();

    protect.mockImplementation(async (action) => {
      if (action.kind === "tool-result") throw new Error("denied result");
    });
    await expect(
      callSessionTool(
        clientWith({ ownerAccess, protect }),
        {},
        "owner_channel_list",
        {},
      ),
    ).rejects.toThrow("denied result");
    expect(ownerAccess.channels).toHaveBeenCalledOnce();
    const result = protect.mock.calls.at(-1)?.[0];
    expect(result).toMatchObject({ kind: "tool-result" });
    expect(String(result?.content)).toContain('"executedAs"');
  });
});
