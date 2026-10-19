import { expect, it } from "vitest";
import { ATTENTION_TOOLS } from "./attention";
import { respond } from "./rpc";
import {
  type AddedTool,
  addedKey,
  sessionHint,
  sessionTools,
} from "./session-tools";
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

it("loads the Buzz tools up front, and attention and plugins' tools on search", () => {
  const tools = sessionTools([tool("notes_add")]);
  const load = (name: string) => tools.find((each) => each.name === name)?.load;
  expect(TOOLS.every((each) => load(each.name) === "always")).toBe(true);
  expect(ATTENTION_TOOLS.every((each) => load(each.name) === "search")).toBe(
    true,
  );
  expect(load("notes_add")).toBe("search");
  expect(sessionHint([tool("notes_add"), tool("tasks_create")])).toContain(
    "tools plugins add (notes_add, tasks_create)",
  );
});

it("marks only the tools that load up front for a harness with search", async () => {
  const added = [tool("notes_add")];
  const answer = (method: string, search: boolean) =>
    respond(undefined, {}, { id: 1, method }, added, search) as Promise<{
      result: {
        instructions?: string;
        tools?: { name: string; load?: unknown; _meta?: unknown }[];
      };
    }>;
  const marked = async (search: boolean) =>
    (await answer("tools/list", search)).result.tools
      ?.filter((each) => each._meta)
      .map((each) => each.name);
  // Claude loads the rest on search, and the server says what they are.
  expect(await marked(true)).toEqual(TOOLS.map((each) => each.name));
  expect((await answer("initialize", true)).result.instructions).toBe(
    sessionHint(added),
  );
  // goose loads every tool, so nothing is marked or said.
  expect(await marked(false)).toEqual([]);
  expect((await answer("initialize", false)).result.instructions).toBe(
    undefined,
  );
  const listed = (await answer("tools/list", true)).result.tools ?? [];
  expect(listed.some((each) => "load" in each)).toBe(false);
  expect(listed.find((each) => each.name === "send")?._meta).toEqual({
    "anthropic/alwaysLoad": true,
  });
});
