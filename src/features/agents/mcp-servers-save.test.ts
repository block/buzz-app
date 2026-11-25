// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

// A credential store of value names, as the native commands keep it.
const store = new Set<string>();
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "agent_mcp_env_status") return { names: [...store] };
    if (command === "agent_mcp_env_set") {
      for (const row of args.rows as { name: string }[]) store.add(row.name);
      for (const name of args.remove as string[]) store.delete(name);
      return null;
    }
    throw new Error(command);
  }),
}));

const { envName, saveMcp } = await import("./mcp-servers");
type McpList = import("./mcp-servers").McpList;
type Approval = import("./mcp-servers").Approval;

const AGENT = "a".repeat(64);
const server = (slot: string) => ({
  name: "docs",
  enabled: true,
  slot,
  transport: "stdio" as const,
  command: "docs",
  args: [],
  env: ["TOKEN"],
});
const list = (slot: string): McpList => ({
  servers: [server(slot)],
  disabledInherited: [],
});
const accepted = (l: McpList, id: string): Approval => ({
  ok: true,
  list: l,
  approvedAt: 1,
  id,
});
const OLD = "0".repeat(16);
const NEXT = "1".repeat(16);
const NEWER = "2".repeat(16);

beforeEach(() => {
  store.clear();
  for (const slot of [OLD, NEWER]) store.add(envName(slot, "TOKEN"));
});

it("deletes only values neither the save nor the list accepted now uses", async () => {
  await saveMcp(
    AGENT,
    list(NEXT),
    [{ name: envName(NEXT, "TOKEN"), value: "v" }],
    async () => undefined,
    // A newer list, from another device, was accepted as this save finished.
    () => accepted(list(NEWER), "newer"),
  );
  expect([...store].sort()).toEqual(
    [envName(NEXT, "TOKEN"), envName(NEWER, "TOKEN")].sort(),
  );
});

it("deletes nothing when the accepted list isn't known or changes meanwhile", async () => {
  const unknown = [
    () => undefined,
    () => ({ ok: false as const, reason: "unreadable" }),
  ];
  let calls = 0;
  const changing = () => accepted(list(NEXT), calls++ ? "b" : "a");
  for (const current of [...unknown, changing]) {
    await saveMcp(AGENT, list(NEXT), [], async () => undefined, current);
    expect(store.has(envName(OLD, "TOKEN"))).toBe(true);
  }
});

it("deletes nothing when the publish fails", async () => {
  await expect(
    saveMcp(
      AGENT,
      list(NEXT),
      [],
      async () => {
        throw new Error("offline");
      },
      () => accepted(list(NEXT), "x"),
    ),
  ).rejects.toThrow("offline");
  expect(store.has(envName(OLD, "TOKEN"))).toBe(true);
});
