// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createNavigationController } from "../../features/navigation/controller";
import { createMemoryHistory } from "../../features/navigation/history";
import { DirectorySidebar, sidebarDirectoryIntent } from "./DirectorySidebar";
import type {
  ChannelThreadDirectory,
  ChannelThreadSidebarProps,
} from "../../features/conversation/contracts";
import type { Contribution } from "../../plugins/contributions";
import type { RelaySession } from "../../features/relay/session";
import type { RelaySnapshot } from "../../features/relay/service";

afterEach(cleanup);
const id = "a".repeat(64);
function fixture() {
  let commands!: ChannelThreadSidebarProps;
  const entry: Contribution<ChannelThreadDirectory> = {
    id: "x",
    title: "X",
    key: "plugin/x",
    revision: "1",
    pluginId: "plugin",
    component: () => null,
    sidebar: (props) => {
      commands = props;
      return null;
    },
  };
  let entries = [entry];
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const emit = () => {
    for (const listener of listeners) listener();
  };
  let members = ["viewer"],
    epoch = 0,
    current = true;
  let live = { status: "connected" };
  const session = {
    viewer: "viewer",
    channels: {
      retainedEpoch: () => epoch,
      subscribeRetained: subscribe,
      list: () => ({
        status: "ready",
        channels: [{ id: "c", name: "C", channelType: "stream", members }],
      }),
      subscribeList: subscribe,
    },
    live: { snapshot: () => live, subscribe },
  } as unknown as RelaySession;
  let connection = {
    session,
    scope: "s",
    generation: 1,
    status: "ready",
    viewer: "viewer",
  } as RelaySnapshot;
  const relay = {
    snapshot: () => connection,
    subscribe,
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  const open = vi.fn(() => true);
  const registry = { snapshot: () => entries, subscribe };
  const view = render(
    <DirectorySidebar
      entry={entry}
      registry={registry}
      relay={relay}
      session={session}
      scope="s"
      channelId="c"
      channelName="C"
      isCurrent={() => current}
      open={open}
      directorySelected={false}
    />,
    { reactStrictMode: true },
  );
  return {
    session,
    relay,
    registry,
    entry,
    open,
    commands: () => commands,
    view,
    change(kind: string) {
      act(() => {
        if (kind === "registration") entries = [{ ...entry }];
        if (kind === "connection")
          connection = { ...connection, generation: 2 };
        if (kind === "navigation") current = false;
        if (kind === "access") {
          members = [];
          emit();
          members = ["viewer"];
        }
        if (kind === "disconnect") {
          live = { status: "retrying" };
          emit();
          live = { status: "connected" };
        }
        if (kind === "cache") epoch++;
        emit();
      });
    },
  };
}
it("leases exact root and directory commands without a reader; rejects invalid roots and unmount", () => {
  const f = fixture(),
    saved = f.commands();
  expect(saved.openThread("not-a-root")).toBe(false);
  expect(saved.openThread(id)).toBe(true);
  expect(saved.openDirectory()).toBe(true);
  expect(f.open.mock.calls.map((call) => call.slice(1))).toEqual([
    ["c", id],
    ["c"],
  ]);
  f.view.unmount();
  expect(saved.openThread(id)).toBe(false);
  expect(saved.openDirectory()).toBe(false);
});
it.each([
  "registration",
  "connection",
  "navigation",
  "access",
  "disconnect",
  "cache",
])("old callbacks cannot revive after %s changes", (kind) => {
  const f = fixture(),
    saved = f.commands();
  f.change(kind);
  expect(saved.openThread(id)).toBe(false);
  expect(saved.openDirectory()).toBe(false);
  expect(f.open).not.toHaveBeenCalled();
});

it.each([
  "registration",
  "connection",
  "access",
  "disconnect",
  "cache",
  "attempt",
  "dispose",
])(
  "one pending sidebar intent latches %s retirement and cannot replay",
  (kind) => {
    const f = fixture();
    const host = createNavigationController(createMemoryHistory());
    const intent = sidebarDirectoryIntent(
      {
        session: f.session,
        scope: "s",
        channelId: "c",
        entry: f.entry,
        rootId: id,
      },
      f.registry,
      f.relay,
      host.navigation,
    );
    const destination = {
      session: f.session,
      scope: "s",
      channelId: "c",
      entryId: host.navigation.snapshot().entry.id,
    };
    expect(intent.matches(destination)).toBe(true);
    expect(intent.matches({ ...destination, scope: "other" })).toBe(false);
    expect(intent.matches({ ...destination, entryId: "another-visit" })).toBe(
      false,
    );
    expect(intent.valid()).toBe(true);
    if (kind === "attempt") void host.navigation.retry();
    else if (kind === "dispose") intent.dispose();
    else f.change(kind);
    expect(intent.valid()).toBe(false);
    intent.dispose();
    host.dispose();
  },
);
