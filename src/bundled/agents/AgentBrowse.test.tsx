// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { EventData, RelayEvent } from "../../features/relay/events";
import { createRelayReader } from "../../features/relay/reader";
import type { RelayData } from "../../features/relay/service";
import type { ReadTransport } from "../../features/relay/transport";
import { AgentBrowse } from "./AgentBrowse";

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

/** A ready community whose session reads through `read`. */
const community = (read: unknown) => {
  const snapshot = {
    status: "ready",
    generation: 1,
    origin: "https://relay.example",
    session: { read, media: () => undefined },
  };
  return {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RelayData;
};

it("browses shared agents and opens read-only details", async () => {
  const read = vi.fn().mockResolvedValue([shared]);
  render(<AgentBrowse relay={community(read)} />);
  expect(await screen.findByText("Shared helper")).toBeVisible();
  expect(screen.getByText("test-model")).toBeVisible();
  expect(read).toHaveBeenCalledWith([{ kinds: [30175], limit: 200 }], {
    signal: expect.any(AbortSignal),
  });
  fireEvent.click(screen.getByRole("button", { name: "View details" }));
  expect(
    await screen.findByRole("dialog", { name: "Shared helper" }),
  ).toBeVisible();
  expect(screen.getByText("Help with tasks.")).toBeVisible();
  expect(screen.getByText(/Shared by npub…/)).toBeVisible();
});

it("asks to connect while no community is ready", () => {
  const snapshot = { status: "disconnected", generation: 0 };
  render(
    <AgentBrowse
      relay={
        {
          snapshot: () => snapshot,
          subscribe: () => () => {},
        } as unknown as RelayData
      }
    />,
  );
  expect(
    screen.getByText("Connect to a community to browse shared agents."),
  ).toBeVisible();
});

it("allows retrying a failed read without claiming the community is empty", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce([]);
  render(<AgentBrowse relay={community(read)} />);
  expect(
    screen.queryByText("No shared agents found in this community yet."),
  ).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  expect(
    await screen.findByText("No shared agents found in this community yet."),
  ).toBeVisible();
});

it("shrinks over-budget pages and preserves Load more and explicit retry", async () => {
  const events = Array.from({ length: 200 }, (_, index) => ({
    ...shared,
    id: index.toString(16).padStart(64, "0"),
    created_at: 200 - index,
    tags: [
      ["d", `helper-${Math.floor(index / 100)}`],
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
  const view = render(<AgentBrowse relay={community(owned.reader.read)} />);
  try {
    await screen.findByText("Helper 0");
    expect(
      query.mock.calls.slice(0, 2).map(([filters]) => filters[0]?.limit),
    ).toEqual([200, 100]);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Helper 100")).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: "View details" }),
    ).toHaveLength(2);
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
