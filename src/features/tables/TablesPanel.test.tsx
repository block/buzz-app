// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import type { BuzzClient } from "../../buzz-mcp/client";
import { callTool } from "../../buzz-mcp/tools";
import { createAgentMemories, type MemoryEntry } from "../agents/memory";
import type { Agent } from "../agents/service";
import { TablesPanel } from "./TablesPanel";

afterEach(cleanup);

const owner = "c".repeat(64);
const agent = { pubkey: "a".repeat(64), name: "Ada" } as Agent;
let clock = 1_800_000_000;
const id = () => crypto.randomUUID().replaceAll("-", "").repeat(2);

/** One community's records for this pair: what the agent signed, and what
 * its owner proposed to it. */
function community() {
  const signed = new Map<string, MemoryEntry>();
  const proposed = new Map<string, MemoryEntry>();
  const listing = (entries: Map<string, MemoryEntry>, slug?: string) => ({
    entries: [...entries.values()].filter(
      (entry) => !slug || entry.slug === slug,
    ),
    partial: false,
  });
  const owners = createAgentMemories(
    async () => listing(signed),
    owner,
    () => true,
    undefined,
    {
      read: async () => listing(proposed),
      async propose(_, table, schema, after) {
        const slug = `mem/proposals/tables/${table}`;
        const entry = {
          slug,
          body: schema,
          eventId: id(),
          createdAt: Math.max(++clock, after + 1),
        };
        proposed.set(slug, entry);
        return entry;
      },
    },
  );
  const tools = {
    memories: async (slug?: string) => listing(signed, slug),
    async remember(slug: string, body: string | null) {
      if (body !== null)
        signed.set(slug, { slug, body, eventId: id(), createdAt: ++clock });
    },
    proposals: async (slug?: string) =>
      listing(proposed, slug).entries.map((entry) => ({
        ...entry,
        author: owner,
      })),
  } as unknown as BuzzClient;
  return { owners, tools };
}

it("a person defines Goals, the agent discovers and fills a row, and reopening shows it", async () => {
  const user = userEvent.setup();
  const { owners, tools } = community();
  const panel = () => (
    <TablesPanel agent={agent} memories={owners.capability} />
  );
  const { unmount } = render(panel());

  await user.click(await screen.findByRole("button", { name: "New table" }));
  const form = screen.getByRole("form", { name: "New table" });
  await user.type(within(form).getByLabelText("Name"), "Goals");
  const first = within(form).getByRole("group", { name: "Field 1" });
  await user.type(within(first).getByLabelText("Label"), "Title");
  await user.click(within(form).getByRole("button", { name: "Add field" }));
  const second = within(form).getByRole("group", { name: "Field 2" });
  await user.type(within(second).getByLabelText("Label"), "Target date");
  await user.click(within(second).getByRole("combobox", { name: "Type" }));
  await user.click(await screen.findByRole("option", { name: "Date" }));
  await user.click(within(form).getByRole("button", { name: "Save table" }));
  expect(
    await screen.findByText("Waiting for the agent to adopt this table."),
  ).toBeInTheDocument();

  await expect(callTool(tools, {}, "tables_list", {})).resolves.toBe(
    'goals "Goals" proposed by your owner; adopt it with table_adopt',
  );
  await callTool(tools, {}, "table_adopt", { table: "goals" });
  await expect(
    callTool(tools, {}, "table_read", { table: "goals" }),
  ).resolves.toContain("- target_date (date) Target date");
  await callTool(tools, {}, "table_row_set", {
    table: "goals",
    values: { title: "Publish the synthetic demo", target_date: "2027-03-31" },
  });

  unmount();
  // Reopening repeatedly reads through a fresh view each time, and the last
  // one shows the agent's row.
  for (let open = 0; open < 5; open++) {
    const view = render(panel());
    expect(
      await screen.findByRole("cell", { name: "Publish the synthetic demo" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("cell", { name: "2027-03-31" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Waiting for the agent/)).toBeNull();
    view.unmount();
  }
});
