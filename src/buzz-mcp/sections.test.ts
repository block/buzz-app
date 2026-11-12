import { expect, it, vi } from "vitest";
import type { BuzzClient, SidebarSections } from "./client";
import { respond } from "./rpc";
import { SECTIONS_TOOLS } from "./sections";
import { BUZZ_SESSION, sessionTools } from "./session-tools";

function withSections() {
  const sections = {
    list: vi.fn(async () => ({
      sections: [
        { id: "s1", name: "Team", channels: [{ id: "c1", name: "dev" }] },
      ],
      starred: [],
    })),
    create: vi.fn(async (name: string) => ({ id: "s2", name })),
    rename: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    assign: vi.fn(async () => {}),
  } satisfies SidebarSections;
  return { client: { sections } as unknown as BuzzClient, sections };
}

const call = async (
  client: BuzzClient | undefined,
  name: string,
  args: unknown = {},
) =>
  (
    (await respond(
      client,
      {},
      { id: 1, method: "tools/call", params: { name, arguments: args } },
    )) as { result: { content: { text: string }[]; isError?: boolean } }
  ).result;
const names = async (client: BuzzClient | undefined) =>
  (
    (await respond(client, {}, { id: 1, method: "tools/list" })) as {
      result: { tools: { name: string }[] };
    }
  ).result.tools.map(({ name }) => name);
const sectionNames = SECTIONS_TOOLS.map(({ name }) => name);

it("lists, creates, renames, removes and assigns through the host", async () => {
  const { client, sections } = withSections();
  const listed = await call(client, "sections_list");
  expect(JSON.parse(listed.content[0]?.text ?? "")).toEqual({
    sections: [
      { id: "s1", name: "Team", channels: [{ id: "c1", name: "dev" }] },
    ],
    starred: [],
  });
  const created = await call(client, "section_create", { name: "Projects" });
  expect(JSON.parse(created.content[0]?.text ?? "")).toEqual({
    id: "s2",
    name: "Projects",
  });
  expect(
    (await call(client, "section_rename", { id: "s2", name: "P" })).content[0]
      ?.text,
  ).toBe("renamed");
  expect(sections.rename).toHaveBeenCalledWith("s2", "P");
  expect(
    (await call(client, "section_assign", { channel: "dev", section: "s2" }))
      .content[0]?.text,
  ).toBe("moved");
  expect(sections.assign).toHaveBeenLastCalledWith("dev", "s2");
  expect(
    (await call(client, "section_assign", { channel: "dev" })).content[0]?.text,
  ).toBe("moved to Channels");
  expect(sections.assign).toHaveBeenLastCalledWith("dev", undefined);
  expect(
    (await call(client, "section_remove", { id: "s2" })).content[0]?.text,
  ).toBe("removed");
  expect(sections.remove).toHaveBeenCalledWith("s2");
});

it("rejects unknown and empty arguments without writing", async () => {
  const { client, sections } = withSections();
  const extra = await call(client, "section_remove", { id: "s1", force: true });
  expect(extra.isError).toBe(true);
  expect(extra.content[0]?.text).toContain("force cannot be used");
  const empty = await call(client, "section_create", { name: "" });
  expect(empty.isError).toBe(true);
  expect(sections.create).not.toHaveBeenCalled();
  expect(sections.remove).not.toHaveBeenCalled();
});

it("lists the tools only to a client that can change sections, on search", async () => {
  expect(BUZZ_SESSION.tools.map(({ name }) => name)).toEqual(
    expect.arrayContaining(sectionNames),
  );
  expect(
    sessionTools()
      .filter(({ name }) => sectionNames.includes(name))
      .every(({ load }) => load === "search"),
  ).toBe(true);
  expect(await names(withSections().client)).toEqual(
    expect.arrayContaining(sectionNames),
  );
  const without = await names({} as BuzzClient);
  expect(without.filter((name) => sectionNames.includes(name))).toEqual([]);
  const refused = await call({} as BuzzClient, "sections_list");
  expect(refused.isError).toBe(true);
});

it("gives a plugin's tool the agent's client without its sections", async () => {
  const { client } = withSections();
  const seen = vi.fn<(client: BuzzClient) => void>();
  await respond(
    client,
    {},
    { id: 1, method: "tools/call", params: { name: "plugin_tool" } },
    [
      {
        name: "plugin_tool",
        description: "A plugin's tool.",
        inputSchema: { type: "object" },
        call: async (given: BuzzClient) => {
          seen(given);
          return "done";
        },
      },
    ],
  );
  expect(seen).toHaveBeenCalledOnce();
  expect(seen.mock.calls[0]?.[0]).not.toHaveProperty("sections");
});
