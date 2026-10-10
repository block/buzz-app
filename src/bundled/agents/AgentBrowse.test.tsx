// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentBrowse, sharedAgents } from "./AgentBrowse";
import { createRelayReader } from "../../features/relay/reader";
import type { ReadTransport } from "../../features/relay/transport";
import type { RelayEvent } from "../../features/relay/events";
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

it.each([
  {
    tags: [
      ["d", "helper"],
      ["shared", "true"],
      ["shared", "false"],
    ],
  },
  {
    tags: [
      ["d", "helper"],
      ["d", "other"],
      ["shared", "true"],
    ],
  },
  {
    tags: [
      ["d", "invalid slug"],
      ["shared", "true"],
    ],
  },
  { content: JSON.stringify({ display_name: "Hidden\u202ename" }) },
  {
    content: JSON.stringify({
      display_name: "Helper",
      system_prompt: "x".repeat(65537),
    }),
  },
])("rejects invalid catalog publications: %j", (invalid) => {
  expect(sharedAgents([{ ...shared, ...invalid }])).toEqual([]);
});
it("does not revive a valid publication behind an invalid newer head", () => {
  expect(
    sharedAgents([shared, { ...shared, created_at: 2, content: "invalid" }]),
  ).toEqual([]);
});

it("shrinks over-budget pages and preserves Load more and explicit retry", async () => {
  const events = Array.from({ length: 200 }, (_, index) => ({
    ...shared,
    id: index.toString(16).padStart(64, "0"),
    created_at: 200 - index,
    tags: [
      ["d", `helper-${index}`],
      ["shared", "true"],
    ],
    content: JSON.stringify({
      display_name: `Helper ${index}`,
      system_prompt: "x".repeat(48 * 1024),
    }),
  })) as RelayEvent[];
  let failNextPage = true;
  const query = vi.fn<ReadTransport["query"]>(async (filters) => {
    const filter = filters[0];
    if (!filter) throw new Error("Missing filter");
    if (filter.until !== undefined && failNextPage) {
      failNextPage = false;
      throw new Error("offline");
    }
    return events
      .filter(
        (event) =>
          filter.until === undefined || event.created_at < filter.until,
      )
      .slice(0, filter.limit);
  });
  const owned = createRelayReader({
    viewer: shared.pubkey,
    relayAuthor: "relay",
    media: () => undefined,
    query,
  });
  const view = render(
    <AgentBrowse
      connection={
        {
          status: "ready",
          session: { read: owned.reader.read, media: () => undefined },
        } as unknown as RelaySnapshot
      }
    />,
  );
  try {
    await screen.findByRole("heading", { name: "Helper 99", exact: true });
    expect(
      query.mock.calls.slice(0, 2).map(([filters]) => filters[0]?.limit),
    ).toEqual([200, 100]);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { name: "Helper 199", exact: true }),
    ).toBeVisible();
    expect(screen.getAllByRole("heading")).toHaveLength(200);
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
    expect(
      query.mock.calls.slice(2).map(([filters]) => filters[0]?.until),
    ).toEqual([101, 101]);
  } finally {
    view.unmount();
    owned.dispose();
  }
});
