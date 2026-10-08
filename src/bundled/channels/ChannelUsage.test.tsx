// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { ArchiveHost, ArchivePage } from "../../features/archive/types";
import { ChannelUsage } from "./ChannelUsage";
import {
  setChannelUsagePreference,
  useChannelUsagePreference,
} from "../../features/agents/channel-usage-preference";
const key = (n: number) => n.toString(16).padStart(64, "0");
const frame = (
  agent: number,
  session: string,
  turn: number,
  total?: number,
): ArchivePage["records"][number] => ({
  id: key(agent * 100 + turn + (session === "b" ? 50 : 0)),
  agent: key(agent),
  createdAt: turn,
  receivedAt: turn,
  plaintext: JSON.stringify({
    harness: "goose",
    model: "model",
    timestamp: new Date((turn + 1) * 1000).toISOString(),
    channelId: "channel",
    sessionId: session,
    turnId: `turn-${turn}`,
    turnSeq: turn,
    turn: { inputTokens: 0, costUsd: 0 },
    cumulative: { inputTokens: 10, totalTokens: total ?? null, costUsd: 0 },
  }),
});
const host = (records: ArchivePage["records"]): ArchiveHost => ({
  location: "device",
  settings: vi.fn(async () => ({
    observer: true,
    metrics: true,
    observerDays: 30,
    revision: 1,
    location: "device" as const,
    path: "isolated",
    bytes: 0,
  })),
  read: vi.fn(async () => ({
    records,
    before: null,
    agents: [],
    skipped: 0,
    revision: 1,
  })),
  configure: vi.fn(),
  clear: vi.fn(),
});
function fixture(records: ArchivePage["records"]) {
  const archive = host(records);
  let access = true;
  const listeners = new Set<() => void>();
  const list = {
    status: "ready",
    channels: [{ id: "channel", name: "Channel", members: [key(9)] }],
  };
  const empty = { status: "ready", channels: [] };
  const session = {
    viewer: key(9),
    agentActivity: { archive },
    channels: {
      list: () => (access ? list : empty),
      subscribeList: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as RelaySession;
  return {
    session,
    archive,
    revoke: () =>
      act(() => {
        access = false;
        for (const listener of listeners) listener();
      }),
  };
}
afterEach(cleanup);
it("opens the selected agent, requires explicit multi-session selection, and expands zero-valued turn details", async () => {
  const records = [
    frame(1, "a", 1, 0),
    frame(1, "b", 2, 20),
    frame(2, "a", 1, 30),
  ];
  const { session } = fixture(records);
  render(<ChannelUsage session={session} channelId="channel" />);
  expect(await screen.findByText(/2 sessions/)).toBeTruthy();
  expect(screen.getByText(/30 tokens/)).toBeTruthy();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /2 sessions/ }));
  expect(
    screen.getByText("Session totals may include other threads."),
  ).toBeTruthy();
  expect(screen.queryByText("Latest reported session counters")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Session 1" }));
  expect(screen.getByText("Latest reported session counters")).toBeTruthy();
  const list = screen.getByRole("region", { name: /recorded turns/ });
  await user.click(within(list).getByRole("button", { name: /Show turn/ }));
  expect(within(list).getByText("Input")).toBeTruthy();
  expect(within(list).getAllByText("$0.00").length).toBeGreaterThan(0);
  await user.click(screen.getByRole("button", { name: "Session 2" }));
  expect(
    within(screen.getByRole("region", { name: /recorded turns/ })).queryByText(
      "Input",
    ),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(
    screen.queryByRole("region", { name: "Session usage details" }),
  ).toBeNull();
});
it("hides decoded usage when the authorized channel disappears", async () => {
  const { session, revoke } = fixture([frame(1, "a", 1, 10)]);
  render(<ChannelUsage session={session} channelId="channel" />);
  expect(await screen.findByText(/10 tokens/)).toBeTruthy();
  revoke();
  expect(screen.queryByText(/10 tokens/)).toBeNull();
  expect(screen.queryByText("Channel session usage")).toBeNull();
});
function PreferredUsage({ session }: { session: RelaySession }) {
  return useChannelUsagePreference() ? (
    <ChannelUsage session={session} channelId="channel" />
  ) : null;
}
it("unmounts archive reader when usage display is disabled and reloads on enable", async () => {
  localStorage.clear();
  const { session, archive } = fixture([frame(1, "a", 1, 10)]);
  render(<PreferredUsage session={session} />);
  expect(await screen.findByText(/10 tokens/)).toBeTruthy();
  const reads = vi.mocked(archive.read);
  const before = reads.mock.calls.length;
  act(() => {
    setChannelUsagePreference(false);
  });
  expect(screen.queryByText("Channel session usage")).toBeNull();
  expect(reads).toHaveBeenCalledTimes(before);
  act(() => {
    setChannelUsagePreference(true);
  });
  expect(await screen.findByText(/10 tokens/)).toBeTruthy();
  expect(reads).toHaveBeenCalledTimes(before + 1);
});
