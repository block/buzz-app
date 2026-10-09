// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentBrowse, sharedAgents } from "./AgentBrowse";
import type { EventData } from "../../features/relay/events";
import type { RelaySnapshot } from "../../features/relay/service";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
afterEach(cleanup);
const shared: EventData = {
  id: "ab".repeat(32),
  pubkey: "cd".repeat(32),
  created_at: 1,
  kind: 30175,
  tags: [
    ["d", "helper"],
    ["shared", "true"],
  ],
  content: JSON.stringify({
    display_name: "Shared helper",
    model: "test-model",
    system_prompt: "Help with tasks.",
  }),
};
it("only includes explicitly shared definitions and honors an unshared replacement", () => {
  expect(sharedAgents([shared])).toMatchObject([{ name: "Shared helper" }]);
  expect(
    sharedAgents([
      shared,
      {
        ...shared,
        id: "ef".repeat(32),
        created_at: 2,
        tags: [["d", "helper"]],
      },
    ]),
  ).toEqual([]);
  expect(
    sharedAgents([
      {
        ...shared,
        tags: [
          ["d", "helper"],
          ["shared", "false"],
        ],
      },
    ]),
  ).toEqual([]);
  expect(sharedAgents([{ ...shared, kind: 30177 }])).toEqual([]);
  expect(sharedAgents([{ ...shared, content: "invalid" }])).toEqual([]);
});
it("keeps definitions from distinct publishers separate and sanitizes artwork", () => {
  expect(
    sharedAgents([shared, { ...shared, pubkey: "ef".repeat(32) }]),
  ).toHaveLength(2);
  expect(
    sharedAgents([
      {
        ...shared,
        content: JSON.stringify({
          display_name: "Helper",
          avatar_url: "javascript:alert(1)",
        }),
      },
    ])[0]?.avatar,
  ).toBeUndefined();
});
it("browses shared relay definitions and opens read-only details", async () => {
  const read = vi.fn().mockResolvedValue([shared]);
  const connection = {
    status: "ready",
    session: { read, media: () => undefined },
  } as unknown as RelaySnapshot;
  render(<AgentBrowse connection={connection} />);
  expect(
    await screen.findByRole("heading", { name: "Shared helper" }),
  ).toBeVisible();
  expect(read).toHaveBeenCalledWith([{ kinds: [30175], limit: 200 }], {
    signal: expect.any(AbortSignal),
  });
  fireEvent.click(screen.getByRole("button", { name: "View details" }));
  expect(
    await screen.findByRole("dialog", { name: "Shared helper" }),
  ).toBeVisible();
  expect(screen.getByText("Help with tasks.")).toBeVisible();
  expect(screen.queryByText("No linked identity")).toBeNull();
});
it("allows retrying a failed read without claiming the community is empty", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce([]);
  render(
    <AgentBrowse
      connection={
        { status: "ready", session: { read } } as unknown as RelaySnapshot
      }
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  expect(
    await screen.findByText("No shared agents found in this community yet."),
  ).toBeVisible();
});
