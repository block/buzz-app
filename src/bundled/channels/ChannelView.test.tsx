// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { provideNavigation } from "../../features/navigation/service";
import type {
  ChannelView,
  ChannelViewProps,
} from "../../features/conversation/contracts";
import { createNavigationController } from "../../features/navigation/controller";
import { createMemoryHistory } from "../../features/navigation/history";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { Contribution } from "../../plugins/contributions";
import { SelectedChannelView, useChannelView } from "./ChannelView";

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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("uses deterministic active ownership and skips a throwing matcher", () => {
  const channel = { id: "alpha", name: "Alpha" };
  const entry = (
    key: string,
    matches: ChannelView["matches"],
  ): Contribution<ChannelView> => ({
    id: "main",
    key,
    pluginId: key,
    revision: "one",
    title: "Board",
    component: () => null,
    matches,
  });
  let entries = [
    entry("z/main", () => true),
    entry("a/main", () => true),
    entry("broken/main", () => {
      throw new Error("bad matcher");
    }),
  ];
  const listeners = new Set<() => void>();
  const registry = {
    snapshot: () => entries,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const hook = renderHook(() => useChannelView(registry, channel));
  expect(hook.result.current?.key).toBe("a/main");
  act(() => {
    entries = entries.filter((entry) => entry.key !== "a/main");
    for (const listener of listeners) listener();
  });
  expect(hook.result.current?.key).toBe("z/main");
});

it("isolates a failed view, retries it and revokes callbacks on navigation, session replacement and unmount", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const navigator = createNavigationController(
    createMemoryHistory(),
  ).navigation;
  const scope = {
    viewer: "a".repeat(64),
    communityOrigin: "https://relay.example",
  };
  void navigator.open({
    version: 1,
    kind: "conversation",
    channelId: "alpha",
    scope,
  });
  const session = {} as RelaySession;
  let currentSession = session;
  const relay = { snapshot: () => ({ session: currentSession }) } as RelayData;
  let broken = true;
  const callbacks: (() => boolean)[] = [];
  const entry: Contribution<ChannelView> = {
    key: "example.board/main",
    pluginId: "example.board",
    revision: "one",
    id: "main",
    title: "Board",
    matches: () => true,
    component: ({ active, channel, companion }: ChannelViewProps) => {
      callbacks.push(active);
      if (broken) throw new Error("Broken view");
      return (
        <>
          <p>Board for {channel.name}</p>
          {companion}
        </>
      );
    },
  };
  const entries = [entry];
  const registry = { snapshot: () => entries, subscribe: () => () => {} };
  const mounted = render(
    <SelectedChannelView
      entry={entry}
      registry={registry}
      channel={{ id: "alpha", name: "Alpha" }}
      session={session}
      relay={relay}
      navigator={navigator}
      companion={<p>Independent companion</p>}
    />,
  );
  expect(screen.getByText("Channel view unavailable")).toBeInTheDocument();
  expect(screen.getByText("Independent companion")).toBeVisible();
  mounted.rerender(
    <SelectedChannelView
      entry={entry}
      registry={registry}
      channel={{ id: "alpha", name: "Alpha" }}
      session={session}
      relay={relay}
      navigator={navigator}
      companion={<p>New companion</p>}
    />,
  );
  expect(screen.getByText("New companion")).toBeVisible();
  expect(screen.queryByText("Independent companion")).toBeNull();
  broken = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Board for Alpha");
  expect(screen.getByText("New companion")).toBeVisible();
  const active = callbacks.at(-1);
  expect(active?.()).toBe(true);
  currentSession = {} as RelaySession;
  expect(active?.()).toBe(false);
  currentSession = session;
  expect(active?.()).toBe(true);
  void navigator.open({
    version: 1,
    kind: "conversation",
    channelId: "beta",
    scope,
  });
  expect(active?.()).toBe(false);
  mounted.unmount();
  expect(active?.()).toBe(false);
});

it("leaves a default page attempt pending until its channel destination is resolved", async () => {
  const host = provideNavigation(new Context());
  const scope = {
    viewer: "a".repeat(64),
    communityOrigin: "https://relay.example",
  };
  const opening = host.navigation.open({
    version: 1,
    kind: "page",
    pluginId: "channels",
    pageId: "main",
    scope,
  });
  const request = () =>
    host.request(host.navigation.snapshot().attempt, {
      valid: () => true,
      subscribe: () => () => {},
    }).request;
  const session = {} as RelaySession;
  const relay = { snapshot: () => ({ session }) } as RelayData;
  let active: (() => boolean) | undefined;
  const entry: Contribution<ChannelView> = {
    key: "example.board/main",
    pluginId: "example.board",
    revision: "one",
    id: "main",
    title: "Board",
    matches: () => true,
    component: (props) => {
      active = props.active;
      return <p>Board</p>;
    },
  };
  const entries = [entry],
    registry = { snapshot: () => entries, subscribe: () => () => {} };
  const props = {
    entry,
    registry,
    session,
    relay,
    navigator: host.navigation,
    channel: { id: "alpha", name: "Alpha" },
  };
  const defaultRequest = request();
  const mounted = render(
    <SelectedChannelView {...props} navigation={defaultRequest} />,
  );
  expect(host.navigation.snapshot().status).toBe("opening");
  expect(
    defaultRequest.resolve({
      version: 1,
      kind: "conversation",
      channelId: "alpha",
      scope,
    }),
  ).toBe(true);
  mounted.rerender(<SelectedChannelView {...props} navigation={request()} />);
  await expect(opening).resolves.toMatchObject({ status: "opened" });
  expect(active?.()).toBe(true);
  mounted.unmount();
  host.dispose();
});
