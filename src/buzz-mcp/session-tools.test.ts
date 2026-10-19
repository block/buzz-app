import { expect, it } from "vitest";
import { ATTENTION_TOOLS } from "./attention";
import { respond } from "./rpc";
import { type AddedTool, addedKey, sessionGroups } from "./session-tools";
import { TOOLS } from "./tools";

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

it("groups the Buzz tools up front, and attention and each plugin's tools on search", async () => {
  const groups = sessionGroups([
    { ...tool("apps_create"), pluginId: "block.builderlab" },
    { ...tool("apps_open"), pluginId: "block.builderlab" },
    { ...tool("notes_add"), pluginId: "acme.notes" },
  ]);
  expect(
    groups.map(({ name, load, tools }) => [
      name,
      load,
      tools.map((each) => each.name).join(),
    ]),
  ).toEqual([
    ["buzz", "always", TOOLS.map((each) => each.name).join()],
    [
      "buzz_attention",
      "search",
      ATTENTION_TOOLS.map((each) => each.name).join(),
    ],
    ["block_builderlab", "search", "apps_create,apps_open"],
    ["acme_notes", "search", "notes_add"],
  ]);
  expect(groups[2]?.hint).toContain(
    "block.builderlab plugin adds: apps_create, apps_open",
  );
  // A server of one group says what it holds, and lists only its tools.
  const added = [{ ...tool("notes_add"), pluginId: "acme.notes" }];
  const answer = (method: string, group: string) =>
    respond(undefined, {}, { id: 1, method }, added, group) as Promise<{
      result?: { tools?: { name: string }[]; instructions?: string };
      error?: unknown;
    }>;
  expect((await answer("initialize", "acme_notes")).result?.instructions).toBe(
    sessionGroups(added)[2]?.hint,
  );
  expect(
    (await answer("tools/list", "acme_notes")).result?.tools?.map(
      (each) => each.name,
    ),
  ).toEqual(["notes_add"]);
  expect((await answer("tools/list", "gone")).error).toBeDefined();
});

it("gives a plugin whose name another group has its own", () => {
  expect(
    sessionGroups([
      { ...tool("a_one"), pluginId: "buzz.attention" },
      { ...tool("b_one"), pluginId: "foo.bar" },
      { ...tool("c_one"), pluginId: "foo_bar" },
    ]).map((group) => group.name),
  ).toEqual([
    "buzz",
    "buzz_attention",
    "buzz_attention_2",
    "foo_bar",
    "foo_bar_2",
  ]);
  // Moving a tool to another plugin's group replaces the sessions that list it.
  expect(addedKey([{ ...tool("a_one"), pluginId: "x.y" }])).not.toBe(
    addedKey([{ ...tool("a_one"), pluginId: "x.z" }]),
  );
});
