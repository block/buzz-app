// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Agents } from "../../features/agents/service";
import type { EventData } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { SharedAgentLinkPanel } from "./SharedAgentLinkPanel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const owner = "a".repeat(64);
const id = `${owner}:helper`;
const community = "https://relay.example";
const head = (patch: Partial<EventData> = {}): EventData => ({
  id: "c".repeat(64),
  pubkey: owner,
  kind: 30175,
  created_at: 1,
  tags: [
    ["d", "helper"],
    ["shared", "true"],
  ],
  content: JSON.stringify({
    display_name: "Same name",
    system_prompt: "The intended helper.",
  }),
  ...patch,
});
function fixture(
  read = vi.fn().mockResolvedValue([head()]),
  origin = community,
) {
  const profileSnapshot = new Map();
  const profiles = {
    snapshot: () => profileSnapshot,
    subscribe: () => () => {},
    ensure: async () => {},
  };
  const snapshot = {
    status: "ready",
    origin,
    generation: 1,
    session: { read, profiles, media: () => undefined },
  };
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RelayData;
  const agentSnapshot = { agents: [] };
  const agents = {
    types: () => [],
    snapshot: () => agentSnapshot,
    subscribe: () => () => {},
    port: vi.fn(),
  } as unknown as Agents;
  const props = {
    relay,
    agents,
    types: [],
    onImported: vi.fn(),
    community,
    id,
  };
  return { props, read, agents };
}

it("opens the exact publisher and slug without paging or importing, and copies its stable address", async () => {
  const wrongOwner = head({
    pubkey: "b".repeat(64),
    content: JSON.stringify({
      display_name: "Same name",
      system_prompt: "Wrong owner",
    }),
  });
  const wrongSlug = head({
    tags: [
      ["d", "other"],
      ["shared", "true"],
    ],
    content: JSON.stringify({
      display_name: "Same name",
      system_prompt: "Wrong slug",
    }),
  });
  const read = vi.fn().mockResolvedValue([wrongOwner, wrongSlug, head()]);
  const view = fixture(read);
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  render(<SharedAgentLinkPanel {...view.props} />);
  expect(await screen.findByText("The intended helper.")).toBeVisible();
  expect(screen.queryByText("Wrong owner")).not.toBeInTheDocument();
  expect(screen.queryByText("Wrong slug")).not.toBeInTheDocument();
  expect(read).toHaveBeenCalledExactlyOnceWith(
    [
      {
        kinds: [30175],
        authors: [owner],
        "#d": ["helper"],
        limit: 10,
        consistency: "strong",
      },
    ],
    { signal: expect.any(AbortSignal), fresh: true },
  );
  expect(view.agents.port).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  const link = new URL(writeText.mock.calls[0]?.[0]);
  expect(link.searchParams.get("route.shared")).toBe(id);
  expect(link.searchParams.get("route.community")).toBe(community);
});

it("refuses to look up the address in another community", () => {
  const { props, read } = fixture(undefined, "https://other.example");
  render(<SharedAgentLinkPanel {...props} />);
  expect(screen.getByText(/relay.example community selected/)).toBeVisible();
  expect(read).not.toHaveBeenCalled();
});

it("does not revive a shared revision after it was unshared, and allows retry", async () => {
  const view = fixture(
    vi
      .fn()
      .mockResolvedValueOnce([
        head(),
        head({ created_at: 2, tags: [["d", "helper"]] }),
      ])
      .mockResolvedValueOnce([
        head({
          created_at: 3,
          content: JSON.stringify({
            display_name: "Renamed",
            system_prompt: "Updated instructions",
          }),
        }),
      ]),
  );
  render(<SharedAgentLinkPanel {...view.props} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "no longer shared",
  );
  expect(
    screen.queryByRole("button", { name: "Import" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Updated instructions")).toBeVisible();
  expect(screen.getByRole("heading", { name: "Renamed" })).toBeVisible();
});

it("recovers from a read failure", async () => {
  const view = fixture(
    vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([head()]),
  );
  render(<SharedAgentLinkPanel {...view.props} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("The intended helper.")).toBeVisible();
});

it("aborts a replaced listing and discards its late result", async () => {
  let finish!: (events: EventData[]) => void;
  const pending = new Promise<EventData[]>((resolve) => {
    finish = resolve;
  });
  const first = fixture(vi.fn().mockReturnValue(pending));
  const view = render(<SharedAgentLinkPanel {...first.props} />);
  const signal = first.read.mock.calls[0]?.[1]?.signal as AbortSignal;
  const second = fixture(
    vi.fn().mockResolvedValue([
      head({
        content: JSON.stringify({
          display_name: "Replacement",
          system_prompt: "Fresh session",
        }),
      }),
    ]),
  );
  view.rerender(<SharedAgentLinkPanel {...second.props} />);
  expect(signal.aborted).toBe(true);
  expect(await screen.findByText("Fresh session")).toBeVisible();
  await act(async () => finish([head()]));
  expect(screen.queryByText("The intended helper.")).not.toBeInTheDocument();
  expect(screen.getByText("Fresh session")).toBeVisible();
});
