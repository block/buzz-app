// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import type { RelayData, RelaySnapshot } from "../relay/service";
import type { ChannelList } from "../relay/contracts";
import type { Navigation } from "../navigation/controller";
import { ChannelSidebar } from "./ChannelSidebar";
import { ChannelNavigationProvider } from "./ChannelNavigationState";

const { rowRender } = vi.hoisted(() => ({ rowRender: vi.fn() }));
// Observe the real row below ChannelSidebarItem's production memo boundary.
// React hooks, the parent, the item and the row implementation remain real.
vi.mock("../../bundled/channels/ChannelSidebarRow", async (original) => {
  const actual =
    await original<typeof import("../../bundled/channels/ChannelSidebarRow")>();
  return {
    ...actual,
    ChannelSidebarRow: (
      props: Parameters<typeof actual.ChannelSidebarRow>[0],
    ) => {
      rowRender(props);
      return <actual.ChannelSidebarRow {...props} />;
    },
  };
});
beforeEach(() => {
  // jsdom has no layout; browser journeys own geometry. Only supply the API.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const providers = {
  snapshot: () => [],
  subscribe: () => () => {},
  register: () => {},
};

function fixture() {
  const owner = createRelaySession(null);
  owners.push(owner);
  const list: ChannelList = {
    status: "ready",
    channels: ["alpha", "beta", "gamma"].map((id) => ({
      id,
      name: id,
      channelType: "stream",
    })),
  };
  const session = {
    ...owner.session,
    channels: { ...owner.session.channels, list: () => list, ensureList() {} },
  };
  const snapshot: RelaySnapshot = {
    status: "ready",
    scope: "https://relay.test:viewer",
    viewer: "viewer",
    generation: 1,
    session,
  };
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    async clearCache() {},
  } satisfies RelayData;
  const navigator = { open: vi.fn() } as unknown as Navigation;
  const view = (id: string, sessionsEnabled = true) => (
    <ChannelNavigationProvider relay={relay}>
      <ChannelSidebar
        relay={relay}
        navigator={navigator}
        providers={providers}
        target={{
          version: 1,
          kind: "conversation",
          channelId: id,
          scope: { viewer: "viewer", communityOrigin: "https://relay.test" },
        }}
        sessionsEnabled={sessionsEnabled}
      >
        {null}
      </ChannelSidebar>
    </ChannelNavigationProvider>
  );
  return { view, navigator, snapshot, list };
}

it("does not rebuild unchanged rows on channel switches and refreshes session action eligibility", async () => {
  const h = fixture();
  const mounted = render(h.view("alpha"));
  await screen.findByRole("button", { name: "gamma" });
  rowRender.mockClear();
  mounted.rerender(h.view("beta"));
  expect(rowRender.mock.calls.map(([props]) => props.channel.id)).not.toContain(
    "gamma",
  );
  expect(screen.getByRole("button", { name: "beta" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(screen.getByRole("button", { name: "alpha" })).not.toHaveAttribute(
    "aria-current",
  );
  const alpha = rowRender.mock.calls.find(
    ([props]) => props.channel.id === "alpha",
  )?.[0];
  expect(alpha).toBeDefined();
  // Disable session creation without changing selection: the callback must update.
  rowRender.mockClear();
  mounted.rerender(h.view("beta", false));
  const disabled = rowRender.mock.calls.find(
    ([props]) => props.channel.id === "alpha",
  )?.[0];
  expect(disabled.onNewSession).not.toBe(alpha.onNewSession);
  disabled.onNewSession("alpha");
  expect(h.navigator.open).not.toHaveBeenCalled();
  // Ordinary selection still uses the current session and navigator.
  fireEvent.click(screen.getByRole("button", { name: "gamma" }));
  expect(h.navigator.open).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "conversation", channelId: "gamma" }),
  );
});
