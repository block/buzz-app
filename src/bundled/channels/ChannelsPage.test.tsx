// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import {
  flush,
  keypair,
  roster,
  scriptedTransport,
} from "../../features/relay/testing";
import { createRelaySession } from "../../features/relay/session";
import type { Panels } from "../../features/panels/service";
import type { PagesReader } from "../../features/pages/service";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { ChannelsPage, mediaReviewForDestination } from "./ChannelsPage";

const empty: [] = [];
const pages: PagesReader = { subscribe: () => () => {}, snapshot: () => empty };
const panels: Panels = {
  subscribe: () => () => {},
  snapshot: () => empty,
  register: () => {},
  resolve: () => undefined,
};
const stores: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const store of stores.splice(0)) store.dispose();
  localStorage.clear();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
function owner() {
  const store = createRelaySession(null);
  stores.push(store);
  let snapshot: RelaySnapshot = {
    status: "connecting",
    scope: "community-a:viewer",
    viewer: "viewer",
    generation: 1,
    session: store.session,
    presentation: {
      channels: [{ id: "alpha", name: "Alpha" }],
      preferences: {
        sections: [{ id: "work", name: "Work", order: 0 }],
        assignments: { alpha: "work" },
        starred: [],
      },
    },
  };
  const listeners = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    retry: vi.fn(),
    disconnect: vi.fn(),
    clearCache: async () => {},
  };
  return {
    relay,
    update(patch: Partial<RelaySnapshot>) {
      snapshot = { ...snapshot, ...patch };
      for (const fn of listeners) fn();
    },
    replacement() {
      const next = createRelaySession(null);
      stores.push(next);
      return next.session;
    },
  };
}

it("never carries a media review across channel navigation or resurrects it on return", () => {
  const review = { channelId: "alpha", messageId: "root", entryId: "visit-a" };
  expect(mediaReviewForDestination(review, "alpha", "visit-a")).toBe(review);
  expect(mediaReviewForDestination(review, "beta", "visit-a")).toBeUndefined();
  expect(mediaReviewForDestination(review, "alpha", "visit-b")).toBeUndefined();
  expect(
    mediaReviewForDestination(undefined, "alpha", "visit-a"),
  ).toBeUndefined();
});

it("retains the sidebar viewport and collapse intent across readiness and session replacement, but resets session controls", () => {
  const h = owner();
  render(
    <ToastProvider>
      <ChannelsPage relay={h.relay} panels={panels} pages={pages} />
    </ToastProvider>,
  );
  const viewport = screen.getByRole("navigation", {
    name: "Subscribed channels",
  });
  const group = screen.getByText("Work").closest("details");
  expect(screen.getByRole("button", { name: "Alpha" })).toBeDisabled();
  fireEvent.click(screen.getByText("Work"));
  expect(group).not.toHaveAttribute("open");
  act(() => h.update({ status: "ready", session: h.replacement() }));
  expect(screen.getByRole("navigation", { name: "Subscribed channels" })).toBe(
    viewport,
  );
  expect(screen.getByText("Work").closest("details")).toBe(group);
  expect(group).not.toHaveAttribute("open");
  fireEvent.click(screen.getByRole("button", { name: "Channel settings" }));
  expect(
    screen.getByRole("button", { name: "Channel settings" }),
  ).toHaveAttribute("aria-expanded", "true");
  act(() => h.update({ session: h.replacement(), generation: 2 }));
  expect(
    screen.getByRole("button", { name: "Channel settings" }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("navigation", { name: "Subscribed channels" })).toBe(
    viewport,
  );
  expect(group).not.toHaveAttribute("open");
});

it("replaces the viewport and scoped intent on a community switch even at the same generation", () => {
  const h = owner();
  render(
    <ToastProvider>
      <ChannelsPage relay={h.relay} panels={panels} pages={pages} />
    </ToastProvider>,
  );
  const viewport = screen.getByRole("navigation", {
    name: "Subscribed channels",
  });
  fireEvent.click(screen.getByText("Work"));
  act(() =>
    h.update({ scope: "community-b:viewer", session: h.replacement() }),
  );
  expect(
    screen.getByRole("navigation", { name: "Subscribed channels" }),
  ).not.toBe(viewport);
  expect(screen.getByText("Work").closest("details")).toHaveAttribute("open");
});

it("binds rendered navigation to this session, never the reusable page authority", async () => {
  const { Context } = await import("@deepseek-ai/cordis");
  const { provideNavigation } = await import(
    "../../features/navigation/service"
  );
  const ctx = new Context();
  const host = provideNavigation(ctx);
  const h = owner();
  const relay = h.relay;
  const opening = host.navigation.open({
    version: 1,
    kind: "page",
    pluginId: "buzz.channels",
    pageId: "channels",
  });
  const parent = host.request(host.navigation.snapshot().attempt, {
    valid: () => true,
    subscribe: () => () => {},
  }).request;
  const forSession = vi.fn(parent.forSession);
  const observed = { ...parent, forSession };
  try {
    render(
      <ToastProvider>
        <ChannelsPage
          relay={relay}
          panels={panels}
          pages={pages}
          navigation={observed}
        />
      </ToastProvider>,
    );
    const old = forSession.mock.results[0]?.value;
    expect(old).toBeDefined();
    // Keep the visit pending: a disconnected page legitimately completes in
    // ChannelsPage's effect, so it cannot model a replacement still connecting.
    act(() => h.update({ session: h.replacement(), generation: 2 }));
    expect(old.signal.aborted).toBe(true);
    expect(old.complete({ status: "opened" })).toBe(false);
    expect(old.resolve({ version: 1, kind: "settings" })).toBe(false);
    expect(parent.signal.aborted).toBe(false);
    const next = forSession.mock.results.at(-1)?.value;
    expect(next).not.toBe(old);
    expect(next.complete({ status: "opened" })).toBe(true);
    expect(await opening).toEqual({ status: "opened" });
  } finally {
    cleanup();
    await ctx.fiber.dispose();
  }
});

it("keeps cached rows inert on failed connection and removes them on a verified empty roster", () => {
  const h = owner();
  render(
    <ToastProvider>
      <ChannelsPage relay={h.relay} panels={panels} pages={pages} />
    </ToastProvider>,
  );
  act(() => h.update({ status: "error", error: "Offline" }));
  expect(screen.getByRole("button", { name: "Alpha" })).toBeDisabled();
  expect(screen.queryByRole("textbox", { name: /Message #/ })).toBeNull();
  act(() =>
    h.update({
      status: "ready",
      rosterReady: true,
      session: h.replacement(),
      presentation: {
        channels: [],
        preferences: { sections: [], assignments: {}, starred: [] },
      },
    }),
  );
  expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: /Message #/ })).toBeNull();
});

it.each(["omitted", "failed", "filtered"])(
  "shows usable ID fallback after metadata %s, never while pending",
  async (outcome) => {
    const viewer = keypair(),
      relay = keypair();
    const transport = scriptedTransport(viewer.pubkey, relay.pubkey);
    const store = createRelaySession(transport.transport);
    stores.push(store);
    const h = owner();
    h.update({
      status: "ready",
      rosterReady: true,
      presentationPending: false,
      session: store.session,
      presentation: {
        channels:
          outcome === "filtered"
            ? [{ id: "alpha", name: "Alpha", archived: true }]
            : [],
        preferences: { sections: [], assignments: {}, starred: [] },
      },
    });
    render(
      <ToastProvider>
        <ChannelsPage relay={h.relay} panels={panels} pages={pages} />
      </ToastProvider>,
    );
    await act(async () => {
      transport.next().respond([roster(relay, "alpha", [viewer.pubkey])]);
      await flush();
    });
    expect(screen.queryByRole("button", { name: "alpha" })).toBeNull();
    expect(screen.getByText("Loading your channels…")).toBeInTheDocument();
    const metadata = transport.pending.find((read) =>
      read.filters.some((filter) => filter.kinds?.includes(39000)),
    );
    expect(metadata).toBeDefined();
    await act(async () => {
      if (outcome !== "failed") metadata?.respond([]);
      else metadata?.fail(new Error("Metadata unavailable"));
      await flush();
    });
    if (outcome === "filtered") {
      expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull();
      expect(screen.getByText("No channels yet.")).toBeInTheDocument();
    } else expect(screen.getByRole("button", { name: "alpha" })).toBeEnabled();
    expect(screen.queryByText("Loading your channels…")).toBeNull();
  },
);
