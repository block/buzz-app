import { expect, it, vi } from "vitest";
import { ATTENTION_TOOLS } from "./attention";
import { type Listing, respond } from "./rpc";
import {
  BUZZ_SESSION,
  callSessionTool,
  type AddedTool,
  addedKey,
  sessionHint,
  sessionTools,
} from "./session-tools";
import { TOOL_TITLES, toolTitle } from "./tool-titles";
import { TOOLS } from "./tools";
import type { ProtectionAction } from "../features/agent-protection/service";

const tool = (name: string, description = "Does it."): AddedTool => ({
  name,
  description,
  inputSchema: { type: "object" },
  call: async () => "done",
});

it("keys the added tools whatever order plugins started in", () => {
  expect(addedKey([])).toBe("");
  const key = addedKey([tool("notes_add"), tool("tasks_create")]);
  expect(key).not.toBe("");
  expect(addedKey([tool("tasks_create"), tool("notes_add")])).toBe(key);
  expect(
    addedKey([tool("notes_add"), tool("tasks_create", "Creates a task.")]),
  ).not.toBe(key);
});

it("titles every Buzz tool, and lists the title with it", async () => {
  // Every tool set a session has: the Buzz, attention, Solo worker, plugin,
  // settings and Bestie tools.
  for (const each of BUZZ_SESSION.tools) {
    expect(each.title, each.name).toMatch(/^[A-Z]\S* \S/);
    expect(toolTitle(each.name), each.name).toBe(each.title);
  }
  // No title outlives its tool.
  expect(Object.keys(TOOL_TITLES).sort()).toEqual(
    BUZZ_SESSION.tools.map((each) => each.name).sort(),
  );
  expect(toolTitle("channel_list")).toBe("List channels");
  for (const name of ["notes_add", "toString", "__proto__", ""])
    expect(toolTitle(name), name).toBeUndefined();
  const list = (await respond(undefined, {}, { id: 1, method: "tools/list" }, [
    tool("notes_add"),
  ])) as { result: { tools: { name: string; title?: string }[] } };
  const listed = (name: string) =>
    list.result.tools.find((each) => each.name === name);
  expect(listed("channel_list")?.title).toBe("List channels");
  // A plugin's tool is listed as it was added, with no title made up for it.
  expect(listed("notes_add")).toEqual({
    name: "notes_add",
    description: "Does it.",
    inputSchema: { type: "object" },
  });
});

// The retired owner-read tools, listed here rather than taken from a catalog.
const RETIRED_OWNER_TOOLS = [
  "owner_channel_list",
  "owner_channel_get",
  "owner_member_list",
  "owner_read",
  "owner_canvas_get",
  "owner_canvas_history",
];

it("neither lists nor mentions the retired owner-read tools", () => {
  const names = sessionTools([tool("notes_add")]).map((each) => each.name);
  const hint = sessionHint([tool("notes_add")]);
  for (const name of RETIRED_OWNER_TOOLS) {
    expect(names).not.toContain(name);
    expect(hint).not.toContain(name);
  }
  expect(hint).not.toMatch(/owner's (own )?access|with your access/);
});

it("loads the Buzz tools up front, and attention and plugins' tools on search", () => {
  const tools = sessionTools([tool("notes_add")]);
  const load = (name: string) => tools.find((each) => each.name === name)?.load;
  expect(TOOLS.every((each) => load(each.name) === "always")).toBe(true);
  expect(ATTENTION_TOOLS.every((each) => load(each.name) === "search")).toBe(
    true,
  );
  expect(load("notes_add")).toBe("search");
  expect(sessionHint([tool("notes_add"), tool("tasks_create")])).toContain(
    "tools from enabled plugins",
  );
});

it("keeps the namespace hint within 1024 characters with many plugin tools", () => {
  const added = Array.from({ length: 100 }, (_, index) =>
    tool(`example_plugin_action_${index}`),
  );
  expect(sessionHint(added).length).toBeLessThanOrEqual(1024);
  expect(
    sessionTools(added).filter(({ name }) =>
      name.startsWith("example_plugin_"),
    ),
  ).toEqual(
    added.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
      load: "search",
    })),
  );
});

it("lists the tools as the harness has it, and without their load by default", async () => {
  const answer = (method: string, listing?: Listing) =>
    respond(undefined, {}, { id: 1, method }, [], listing) as Promise<{
      result: {
        instructions?: string;
        tools?: { name: string; load?: unknown; marked?: unknown }[];
      };
    }>;
  const plain = (await answer("tools/list")).result.tools ?? [];
  expect(plain.map((each) => each.name)).toEqual(
    sessionTools().map((each) => each.name),
  );
  expect(plain.some((each) => "load" in each)).toBe(false);
  expect((await answer("initialize")).result.instructions).toBe(undefined);
  const listing: Listing = {
    instructions: "Search for the rest.",
    tool: ({ name, load }) => ({ name, marked: load === "always" }),
  };
  const shaped = (await answer("tools/list", listing)).result.tools ?? [];
  expect(shaped.find((each) => each.name === "send")?.marked).toBe(true);
  expect(shaped.find((each) => each.name === "watch_add")?.marked).toBe(false);
  expect((await answer("initialize", listing)).result.instructions).toBe(
    "Search for the rest.",
  );
});

it("holds a protected tool until approval and executes only the reviewed arguments", async () => {
  let allow!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const approval = new Promise<void>((resolve) => {
    allow = resolve;
  });
  const protect = vi.fn(async (action) => {
    if (action.kind === "tool") {
      entered();
      await approval;
    }
  });
  const call = vi.fn(async (_client, _context, args) => JSON.stringify(args));
  const args = { command: "echo reviewed" };
  const client = { protect } as unknown as import("./client").BuzzClient;
  const result = callSessionTool(client, {}, "plugin_write", args, [
    { ...tool("plugin_write"), call },
  ]);
  await started;
  expect(call).not.toHaveBeenCalled();
  args.command = "changed while waiting";
  allow();
  expect(await result).toBe(JSON.stringify({ command: "echo reviewed" }));
  expect(protect.mock.calls.map(([action]) => action.kind)).toEqual([
    "tool",
    "tool-result",
  ]);
  expect(protect.mock.calls[0]?.[0].command).toBe("echo reviewed");
});
it("does not review a natively gated tool call twice unless a captured file changed it", async () => {
  const protect = vi.fn(async (_action: ProtectionAction) => {});
  const client = {
    protect,
    nativeToolGate: true,
    read: vi.fn(async () => new TextEncoder().encode("Private notes")),
  } as unknown as import("./client").BuzzClient;
  const call = vi.fn(async () => "done");
  await callSessionTool(client, {}, "plugin_write", { text: "hi" }, [
    { ...tool("plugin_write"), call },
  ]);
  expect(protect.mock.calls.map(([action]) => action.kind)).toEqual([
    "tool-result",
  ]);
  protect.mockClear();
  await callSessionTool(client, {}, "send", { path: "notes.md" }).catch(
    () => undefined,
  );
  expect(protect.mock.calls[0]?.[0]).toMatchObject({
    kind: "tool",
    content: { title: "send", arguments: { text: "Private notes" } },
  });
});
it("withholds a denied tool result and checks thrown tool errors before exposing them", async () => {
  const client = {
    protect: vi.fn(async (action) => {
      if (action.kind === "tool-result") throw new Error("denied result");
    }),
  } as unknown as import("./client").BuzzClient;
  await expect(
    callSessionTool(client, {}, "plugin_write", {}, [tool("plugin_write")]),
  ).rejects.toThrow("denied result");
  await expect(
    callSessionTool(client, {}, "plugin_write", {}, [
      {
        ...tool("plugin_write"),
        call: async () => {
          throw new Error("untrusted error");
        },
      },
    ]),
  ).rejects.toThrow("denied result");
});

it("leaves a plugin tool's path and files semantics with that plugin", async () => {
  const read = vi.fn();
  const client = {
    protect: vi.fn(async () => {}),
    read,
  } as unknown as import("./client").BuzzClient;
  const args = { path: "plugin-owned", files: ["plugin-owned"] };
  const call = vi.fn(async (_client, _context, captured) =>
    JSON.stringify(captured),
  );
  expect(
    await callSessionTool(client, {}, "send", args, [
      { ...tool("send"), call },
    ]),
  ).toBe(JSON.stringify(args));
  expect(read).not.toHaveBeenCalled();
});

it("checks file-capture errors before exposing them and does not recheck approval failures", async () => {
  const protect = vi.fn(async (action) => {
    if (action.kind === "tool-result") throw new Error("denied result");
  });
  const client = {
    protect,
    read: vi.fn(async () => {
      throw new Error("untrusted read error");
    }),
  } as unknown as import("./client").BuzzClient;
  await expect(
    callSessionTool(client, {}, "send", { path: "body.md" }),
  ).rejects.toThrow("denied result");
  expect(protect).toHaveBeenCalledExactlyOnceWith({
    kind: "tool-result",
    session: "{}",
    content: { error: "untrusted read error" },
  });
  protect.mockReset().mockRejectedValue(new Error("denied action"));
  await expect(
    callSessionTool(client, {}, "plugin_write", {}, [tool("plugin_write")]),
  ).rejects.toThrow("denied action");
  expect(protect).toHaveBeenCalledOnce();
  expect(protect.mock.calls[0]?.[0].kind).toBe("tool");
});
