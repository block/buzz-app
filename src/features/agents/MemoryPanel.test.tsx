// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentMemories, type MemoryListing } from "./memory";
import { MemoryPanel } from "./MemoryPanel";
import type { Agent } from "./service";

afterEach(cleanup);

const pubkey = "a".repeat(64);
const agent = { pubkey, name: "Ada" } as Agent;
const entry = (slug: string, body: string, createdAt = 1_700_000_000) => ({
  slug,
  body,
  eventId: "b".repeat(64),
  createdAt,
});

function setup(read: () => Promise<MemoryListing>) {
  const memories = createAgentMemories(vi.fn(read), "c".repeat(64), () => true);
  return {
    memories: memories.capability,
    ...render(<MemoryPanel agent={agent} memories={memories.capability} />),
  };
}

it("shows core first, then the agent's other memories", async () => {
  setup(async () => ({
    entries: [
      entry("mem/notes", "Cold detail."),
      entry("core", "I am Ada.\nKeep it short."),
    ],
    partial: false,
  }));
  const core = await screen.findByRole("region", { name: "Core" });
  expect(within(core).getByText(/I am Ada\./)).toBeInTheDocument();
  const other = screen.getByRole("region", { name: "Other memories" });
  expect(within(other).getByText("mem/notes")).toBeInTheDocument();
  expect(within(other).getByText("Cold detail.")).toBeInTheDocument();
  expect(within(other).queryByText("core")).not.toBeInTheDocument();
});

it("says when the agent has no memory yet", async () => {
  setup(async () => ({ entries: [], partial: false }));
  expect(await screen.findByText(/No core memory yet/)).toBeInTheDocument();
  expect(screen.getByText("No other memories.")).toBeInTheDocument();
});

it("reports a failed read and reads again on refresh", async () => {
  const user = userEvent.setup();
  let fail = true;
  setup(async () => {
    if (fail) throw new Error("offline");
    return { entries: [entry("core", "Back.")], partial: false };
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Memory couldn't be read.",
  );
  fail = false;
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText("Back.")).toBeInTheDocument();
});

it("shows nothing to read without a session", () => {
  render(<MemoryPanel agent={agent} memories={undefined} />);
  expect(screen.getByText("Memory isn't available here.")).toBeInTheDocument();
});

it("holds no memory view once it has read", async () => {
  const { memories } = setup(async () => ({
    entries: [entry("core", "I am Ada.")],
    partial: false,
  }));
  await screen.findByText("I am Ada.");
  // The session allows four views at once; the open panel holds none.
  const views = Array.from({ length: 4 }, () => memories.open(pubkey));
  expect(views).toHaveLength(4);
  for (const view of views) view.dispose();
});
