// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { LiveCallbacks } from "../../features/relay/live";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import type { MemoryReader, MemoryListing } from "../../features/agents/memory";
import { keypair } from "../../features/relay/testing";
import { profileTarget } from "../../features/profiles/target";
import { ProfilePanel } from "./ProfilePanel";
import { ProfileMemories } from "./ProfileMemories";
const viewer = keypair(),
  agent = keypair();
const memoryBody = '<script>alert("private")</script>';
const listing: MemoryListing = {
  entries: [
    {
      slug: "core",
      body: memoryBody,
      eventId: "a".repeat(64),
      createdAt: 1,
    },
  ],
  partial: false,
};
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
});
function owner(read?: MemoryReader) {
  const instance = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: viewer.pubkey,
    media: () => undefined,
    query: async () => [],
    ...(read ? { readAgentMemories: read } : {}),
  });
  owners.push(instance);
  return instance;
}
it("mounts lazily through the actual profile tab, displays plain text and releases on leaving", async () => {
  const read = vi.fn<MemoryReader>().mockResolvedValue(listing),
    h = owner(read);
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    viewer: viewer.pubkey,
    scope: `https://one.example:${viewer.pubkey}`,
    session: h.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: h.clearCache,
  };
  const user = userEvent.setup();
  const page = render(
    <StrictMode>
      <ProfilePanel
        relay={relay}
        target={profileTarget(agent.pubkey) ?? ""}
        close={() => {}}
      />
    </StrictMode>,
  );
  await screen.findByRole("tab", { name: "Memories" });
  expect(read).not.toHaveBeenCalled();
  await user.click(screen.getByRole("tab", { name: "Memories" }));
  expect(await screen.findByText("Core memory")).toBeVisible();
  await user.click(screen.getByText("Core memory"));
  expect(screen.getByText(memoryBody)).toBeVisible();
  expect(page.container.querySelector("script")).toBeNull();
  await act(() => h.clearCache());
  expect(screen.queryByText(memoryBody)).toBeNull();
  await user.click(screen.getByRole("button", { name: "Refresh memories" }));
  await screen.findByText("Core memory");
  const calls = read.mock.calls.length;
  await user.click(screen.getByRole("tab", { name: "Info" }));
  expect(screen.queryByRole("region", { name: "Agent memories" })).toBeNull();
  await user.click(screen.getByRole("tab", { name: "Memories" }));
  await screen.findByText("Core memory");
  expect(read.mock.calls.length).toBeGreaterThan(calls);
});
it("held reads show loading, reject late completions after target/session switches and unmount", async () => {
  const pending: {
    resolve(value: MemoryListing): void;
    signal: AbortSignal;
  }[] = [];
  const read: MemoryReader = (_agent, signal) =>
    new Promise((resolve) => pending.push({ resolve, signal }));
  const first = owner(read),
    second = owner(async () => ({ entries: [], partial: false }));
  const page = render(
    <StrictMode>
      <ProfileMemories session={first.session} pubkey={agent.pubkey} />
    </StrictMode>,
  );
  await waitFor(() => expect(pending.length).toBeGreaterThan(0));
  expect(screen.getByRole("status")).toHaveTextContent("Loading memories");
  expect(
    screen.getByRole("button", { name: "Refresh memories" }),
  ).toBeDisabled();
  page.rerender(
    <StrictMode>
      <ProfileMemories session={second.session} pubkey={agent.pubkey} />
    </StrictMode>,
  );
  await screen.findByText(
    "No memories were returned for your account in this community.",
  );
  expect(pending.every(({ signal }) => signal.aborted)).toBe(true);
  await act(async () => {
    for (const held of pending) held.resolve(listing);
  });
  expect(screen.queryByText("Core memory")).toBeNull();
  page.rerender(
    <StrictMode>
      <ProfileMemories session={first.session} pubkey={agent.pubkey} />
    </StrictMode>,
  );
  await waitFor(() => expect(pending.at(-1)?.signal.aborted).toBe(false));
  page.rerender(
    <StrictMode>
      <ProfileMemories session={first.session} pubkey={viewer.pubkey} />
    </StrictMode>,
  );
  await screen.findByText(/Memory reads are unavailable/);
  expect(pending.every(({ signal }) => signal.aborted)).toBe(true);
  await act(async () => {
    for (const held of pending) held.resolve(listing);
  });
  expect(screen.queryByText("Core memory")).toBeNull();
  page.rerender(
    <StrictMode>
      <ProfileMemories session={first.session} pubkey={agent.pubkey} />
    </StrictMode>,
  );
  await waitFor(() => expect(pending.at(-1)?.signal.aborted).toBe(false));
  page.unmount();
  expect(pending.every(({ signal }) => signal.aborted)).toBe(true);
  await act(async () => {
    for (const held of pending) held.resolve(listing);
  });
});
it("distinguishes denial, error, partial and successful empty and retries without stale plaintext", async () => {
  const denied = new Error("private error details");
  denied.name = "MemoryDenied";
  const read = vi
    .fn<MemoryReader>()
    .mockRejectedValueOnce(denied)
    .mockRejectedValueOnce(new Error("private details"))
    .mockResolvedValueOnce({ entries: [], partial: true })
    .mockResolvedValueOnce({ entries: [], partial: false });
  const h = owner(read),
    user = userEvent.setup();
  render(<ProfileMemories session={h.session} pubkey={agent.pubkey} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "You don’t have access",
  );
  await user.click(screen.getByRole("button", { name: "Retry memories" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t load memories",
  );
  await user.click(screen.getByRole("button", { name: "Retry memories" }));
  await screen.findByText("No readable entries in this partial snapshot.");
  expect(screen.getByRole("status")).toHaveTextContent("may be incomplete");
  await user.click(screen.getByRole("button", { name: "Refresh memories" }));
  await screen.findByText(
    "No memories were returned for your account in this community.",
  );
  expect(screen.queryByRole("status")).toBeNull();
});
it("unsupported and self profiles never issue reads", async () => {
  const read = vi.fn<MemoryReader>().mockResolvedValue(listing),
    h = owner(read);
  const page = render(
    <ProfileMemories session={h.session} pubkey={viewer.pubkey} />,
  );
  await screen.findByText(/Memory reads are unavailable/);
  expect(read).not.toHaveBeenCalled();
  const unsupported = owner();
  page.rerender(
    <ProfileMemories session={unsupported.session} pubkey={agent.pubkey} />,
  );
  await screen.findByText(/Memory reads are unavailable/);
  expect(screen.queryByRole("button")).toBeNull();
});
it("equal-generation scope/viewer changes reset tab intent and clear old output", async () => {
  const first = owner(async () => listing),
    second = owner(async () => ({ entries: [], partial: false }));
  let snapshot: RelaySnapshot = {
    status: "ready",
    generation: 1,
    viewer: viewer.pubkey,
    scope: `https://one.example:${viewer.pubkey}`,
    session: first.session,
  };
  let changed = () => {};
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe(listener) {
      changed = listener;
      return () => {};
    },
    retry() {},
    disconnect() {},
    clearCache: first.clearCache,
  };
  const user = userEvent.setup();
  render(
    <ProfilePanel
      relay={relay}
      target={profileTarget(agent.pubkey) ?? ""}
      close={() => {}}
    />,
  );
  await user.click(screen.getByRole("tab", { name: "Memories" }));
  await screen.findByText("Core memory");
  act(() => {
    snapshot = {
      ...snapshot,
      viewer: agent.pubkey,
      scope: `https://two.example:${agent.pubkey}`,
      session: second.session,
    };
    changed();
  });
  expect(screen.getByRole("tab", { name: "Info" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.queryByText("Core memory")).toBeNull();
});

it("explains live admission before connection and during retry without claiming HTTP failure", async () => {
  let live!: LiveCallbacks;
  const read = vi.fn<MemoryReader>().mockResolvedValue(listing);
  const h = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: viewer.pubkey,
    media: () => undefined,
    query: async () => [],
    readAgentMemories: read,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(h);
  const snapshot: RelaySnapshot = {
    status: "ready",
    generation: 1,
    viewer: viewer.pubkey,
    scope: `https://one.example:${viewer.pubkey}`,
    session: h.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: h.clearCache,
  };
  const user = userEvent.setup();
  render(
    <ProfilePanel
      relay={relay}
      target={profileTarget(agent.pubkey) ?? ""}
      close={() => {}}
    />,
  );
  await user.click(screen.getByRole("tab", { name: "Memories" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Memory reads are paused",
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(read).not.toHaveBeenCalled();
  act(() => live.state({ status: "connected", routes: [] }));
  expect(read).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Retry memories" }));
  await screen.findByText("Core memory");
  act(() => live.state({ status: "retrying", routes: [] }));
  expect(screen.queryByText(memoryBody)).toBeNull();
  await user.click(screen.getByRole("button", { name: "Refresh memories" }));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Memory reads are paused",
  );
  expect(read).toHaveBeenCalledTimes(1);
  act(() => live.state({ status: "connected", routes: [] }));
  expect(read).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Retry memories" }));
  await screen.findByText("Core memory");
  expect(read).toHaveBeenCalledTimes(2);
});
