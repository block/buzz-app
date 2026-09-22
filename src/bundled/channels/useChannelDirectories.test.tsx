// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useLayoutEffect } from "react";
import { useChannelDirectories } from "./useChannelDirectories";
import type {
  ChannelThreadDirectory,
  ChannelThreadDirectoryProps,
  ChannelThreadDraftProps,
} from "../../features/conversation/contracts";
import type { Contribution } from "../../plugins/contributions";
import type { RelaySession } from "../../features/relay/session";
import type { RelaySnapshot } from "../../features/relay/service";
afterEach(cleanup);
const rootId = "a".repeat(64);
function harness(creation = false) {
  let draftCommands: ChannelThreadDraftProps | undefined;
  let commands!: ChannelThreadDirectoryProps;
  let throws = false;
  function Directory(props: ChannelThreadDirectoryProps) {
    useLayoutEffect(() => {
      commands = props;
    });
    if (throws) throw new Error("broken fixture directory");
    return (
      <button type="button" onClick={() => props.openThread(rootId)}>
        Open fixture root
      </button>
    );
  }
  const entry: Contribution<ChannelThreadDirectory> = {
    id: "sessions",
    title: "Sessions",
    key: "fixture/sessions",
    pluginId: "fixture",
    revision: "one",
    component: Directory,
    ...(creation
      ? {
          create: {
            title: "New session",
            component: (props: ChannelThreadDraftProps) => {
              draftCommands = props;
              return (
                <button type="button" onClick={props.back}>
                  Back to Sessions
                </button>
              );
            },
          },
        }
      : {}),
  };
  let entries = [entry];
  const registryListeners = new Set<() => void>();
  const registry = {
    snapshot: () => entries,
    subscribe(listener: () => void) {
      registryListeners.add(listener);
      return () => {
        registryListeners.delete(listener);
      };
    },
  };
  const accessListeners = new Set<() => void>();
  const liveListeners = new Set<() => void>();
  let members: string[] | undefined = ["viewer"];
  let status = "connected";
  let listed = true;
  let channelType: string | undefined = "stream";
  const session = {
    channels: {
      list: () => ({
        status: "ready",
        channels: listed ? [{ id: "c", name: "C", channelType, members }] : [],
      }),
      subscribeList(listener: () => void) {
        accessListeners.add(listener);
        return () => {
          accessListeners.delete(listener);
        };
      },
    },
    live: {
      snapshot: () => ({ status }),
      subscribe(listener: () => void) {
        liveListeners.add(listener);
        return () => {
          liveListeners.delete(listener);
        };
      },
    },
  } as unknown as RelaySession;
  let connection = {
    status: "ready",
    generation: 1,
    viewer: "viewer",
    scope: "s",
    session,
  } as RelaySnapshot;
  const relayListeners = new Set<() => void>();
  const relay = {
    snapshot: () => connection,
    subscribe(listener: () => void) {
      relayListeners.add(listener);
      return () => {
        relayListeners.delete(listener);
      };
    },
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  let current = true;
  const controller = new AbortController();
  let destination: Parameters<typeof useChannelDirectories>[0]["destination"] =
    {
      session,
      scope: "s",
      channelId: "c",
      isCurrent: () => current,
      signal: controller.signal,
    };
  const dispose = vi.fn();
  const append = vi.fn<(rootId: string, title: string) => string | undefined>(
    () => undefined,
  );
  let share: (title: string) => string | undefined = () => "unmounted";
  function Detail({ close }: { close(): void }) {
    useLayoutEffect(() => dispose, []);
    return (
      <button type="button" onClick={close}>
        Close detail
      </button>
    );
  }
  let withRegistry = true;
  function Host() {
    const view = useChannelDirectories({
      registry: withRegistry ? registry : undefined,
      relay,
      destination,
      channelName: "C",
      onSelect() {},
      shareReference: append,
      renderThread: (_id, close, command) => {
        share = command;
        return <Detail close={close} />;
      },
    });
    return (
      <>
        {view.launchers}
        {view.tabs}
        {view.selected ? view.content : <p>Channel body</p>}
      </>
    );
  }
  const view = render(<Host />, { reactStrictMode: true });
  const emit = (listeners: Set<() => void>) => {
    for (const listener of listeners) listener();
  };
  return {
    view,
    entry,
    registryListeners,
    accessListeners,
    relayListeners,
    liveListeners,
    dispose,
    append,
    share: () => share,
    command: () => commands.openThread,
    draftCommands: () => draftCommands,
    select: () =>
      fireEvent.click(screen.getByRole("tab", { name: "Sessions" })),
    entries(next: typeof entries) {
      entries = next;
    },
    publish: () => emit(registryListeners),
    access(next: string[] | undefined = []) {
      members = next;
      emit(accessListeners);
    },
    disconnect() {
      status = "reconnecting";
      emit(liveListeners);
      status = "connected";
      emit(liveListeners);
    },
    replace() {
      connection = { ...connection, generation: 2 };
      emit(relayListeners);
    },
    beginNavigation() {
      current = false;
    },
    abort() {
      controller.abort();
    },
    unknown() {
      members = undefined;
      emit(accessListeners);
    },
    absent() {
      listed = false;
      emit(accessListeners);
    },
    type(value: string | undefined) {
      channelType = value;
      emit(accessListeners);
    },
    noViewer() {
      const { viewer: _viewer, ...rest } = connection;
      connection = rest;
      emit(relayListeners);
    },
    removeDestination() {
      destination = undefined;
      view.rerender(<Host />);
    },
    removeRegistry() {
      withRegistry = false;
      view.rerender(<Host />);
    },
    navigate() {
      if (!destination) throw new Error("Missing fixture destination");
      destination = { ...destination, channelId: "other" };
      view.rerender(<Host />);
    },
    fail() {
      throws = true;
      view.rerender(<Host />);
    },
  };
}
it("validates bounded roots and never creates detail until accepted selection", () => {
  const h = harness();
  h.select();
  const command = h.command();
  for (const invalid of ["", "a".repeat(63), "A".repeat(64), "a".repeat(65)])
    expect(command(invalid)).toBe(false);
  expect(screen.queryByText("Channel body")).not.toBeInTheDocument();
  act(() => {
    expect(command(rootId)).toBe(true);
  });
  expect(screen.getByText("Close detail")).toBeInTheDocument();
  expect(command(rootId)).toBe(false);
  fireEvent.click(screen.getByText("Close detail"));
  expect(screen.getByText("Open fixture root")).toBeInTheDocument();
});
it.each(["directory", "detail"])(
  "removal/replacement of selected %s is explicit, rejects before commit and never resurrects",
  (surface) => {
    const h = harness();
    h.select();
    const stale = h.command();
    if (surface === "detail")
      fireEvent.click(screen.getByText("Open fixture root"));
    act(() => {
      h.entries([]);
      expect(stale(rootId)).toBe(false);
      h.publish();
    });
    expect(screen.getByText(/Sessions unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("Close detail")).not.toBeInTheDocument();
    act(() => {
      h.entries([{ ...h.entry }]);
      h.publish();
    });
    expect(screen.getByText(/Sessions unavailable/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Return to Channel"));
    h.select();
    expect(screen.getByText("Open fixture root")).toBeInTheDocument();
    expect(stale(rootId)).toBe(false);
  },
);
it.each(["access", "disconnect", "replace"] as const)(
  "fences %s generation even if evidence recovers before React renders",
  (change) => {
    const h = harness();
    h.select();
    const stale = h.command();
    act(() => h[change]());
    expect(stale(rootId)).toBe(false);
    expect(screen.getByText(/Sessions unavailable/)).toBeInTheDocument();
  },
);
it("cleans old destination commands and every subscription on unmount", () => {
  const h = harness();
  h.select();
  const stale = h.command();
  h.navigate();
  expect(stale(rootId)).toBe(false);
  expect(screen.getByText("Channel body")).toBeInTheDocument();
  h.view.unmount();
  for (const set of [
    h.registryListeners,
    h.accessListeners,
    h.relayListeners,
    h.liveListeners,
  ])
    expect(set.size).toBe(0);
});
it("isolates a throwing directory, retires its command and provides an exit", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const h = harness();
    h.select();
    const stale = h.command();
    h.fail();
    expect(screen.getByText(/Sessions unavailable/)).toBeInTheDocument();
    expect(stale(rootId)).toBe(false);
    fireEvent.click(screen.getByText("Return to Channel"));
    expect(screen.getByText("Channel body")).toBeInTheDocument();
  } finally {
    error.mockRestore();
  }
});

it("orders contributions by key and retires direct same-id replacement", () => {
  const h = harness();
  act(() => {
    h.entries([
      { ...h.entry, key: "z/sessions", title: "Last" },
      h.entry,
      { ...h.entry, key: "a/sessions", title: "First" },
    ]);
    h.publish();
  });
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
    "Channel",
    "First",
    "Sessions",
    "Last",
  ]);
  h.select();
  const old = h.command();
  act(() => {
    h.entries([{ ...h.entry, revision: "two" }]);
    expect(old(rootId)).toBe(false);
    h.publish();
  });
  expect(screen.getByText(/Sessions unavailable/)).toBeInTheDocument();
  expect(screen.queryByText("Open fixture root")).not.toBeInTheDocument();
});

it("rejects destination changes before React commits and aborts exact routed leases", () => {
  const h = harness();
  h.select();
  const command = h.command();
  h.beginNavigation();
  expect(command(rootId)).toBe(false);
  act(() => h.abort());
  expect(screen.getByText(/Sessions unavailable/)).toBeInTheDocument();
});

it.each([[[]], [["someone-else"]]])(
  "denied retained roster %j cannot issue a new lease; regrant needs fresh selection",
  (members) => {
    const h = harness();
    h.select();
    const stale = h.command();
    act(() => h.access(members));
    fireEvent.click(screen.getByText("Return to Channel"));
    h.select();
    expect(screen.getByText("Channel body")).toBeInTheDocument();
    expect(screen.queryByText("Open fixture root")).not.toBeInTheDocument();
    expect(stale(rootId)).toBe(false);
    act(() => h.access(["viewer"]));
    expect(screen.getByText("Channel body")).toBeInTheDocument();
    h.select();
    expect(screen.getByText("Open fixture root")).toBeInTheDocument();
    expect(stale(rootId)).toBe(false);
    act(() => expect(h.command()(rootId)).toBe(true));
  },
);

it.each(["absent", "noViewer"] as const)(
  "%s cannot issue a directory lease",
  (change) => {
    const h = harness();
    act(() => h[change]());
    h.select();
    expect(screen.getByText("Channel body")).toBeInTheDocument();
  },
);
it("preserves listed unknown-roster visibility without treating it as a grant", () => {
  const h = harness();
  act(() => h.unknown());
  h.select();
  expect(screen.getByText("Open fixture root")).toBeInTheDocument();
  const stale = h.command();
  act(() => h.access([]));
  expect(stale(rootId)).toBe(false);
  expect(screen.getByText(/Sessions unavailable/)).toBeInTheDocument();
  fireEvent.click(screen.getByText("Return to Channel"));
  h.select();
  expect(screen.getByText("Channel body")).toBeInTheDocument();
});
it.each(["removeDestination", "removeRegistry"] as const)(
  "%s retires commands and releases destination subscriptions",
  (change) => {
    const h = harness();
    h.select();
    const stale = h.command();
    h[change]();
    expect(stale(rootId)).toBe(false);
    expect(screen.getByText("Channel body")).toBeInTheDocument();
    for (const set of [h.accessListeners, h.liveListeners, h.relayListeners])
      expect(set.size).toBe(0);
    h.view.unmount();
    expect(h.registryListeners.size).toBe(0);
    expect(stale(rootId)).toBe(false);
  },
);

it.each(["dm", "session", undefined])(
  "metadata changing to %s retires commands before render and cannot revive on return",
  (type) => {
    const h = harness();
    h.select();
    const stale = h.command();
    act(() => {
      h.type(type);
      expect(stale(rootId)).toBe(false);
      h.type("stream");
    });
    expect(screen.getByText(/Sessions unavailable/)).toBeInTheDocument();
    expect(stale(rootId)).toBe(false);
  },
);

it("optional creation selects a distinct draft and back retires both commands before returning to the directory", () => {
  const h = harness(true);
  fireEvent.click(screen.getByRole("button", { name: "New session" }));
  expect(screen.getByRole("tab", { name: "Sessions" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.queryByText("Open fixture root")).not.toBeInTheDocument();
  const stale = h.draftCommands();
  fireEvent.click(screen.getByRole("button", { name: "Back to Sessions" }));
  expect(screen.getByText("Open fixture root")).toBeInTheDocument();
  expect(stale?.openThread(rootId)).toBe(false);
  expect(stale?.back()).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "New session" }));
  const next = h.draftCommands();
  act(() => expect(next?.openThread(rootId)).toBe(true));
  expect(
    screen.getByRole("button", { name: "Close detail" }),
  ).toBeInTheDocument();
  expect(next?.back()).toBe(false);
});
it("draft navigation is revoked synchronously by exact plugin removal", () => {
  const h = harness(true);
  fireEvent.click(screen.getByRole("button", { name: "New session" }));
  const stale = h.draftCommands();
  act(() => {
    h.entries([]);
    expect(stale?.openThread(rootId)).toBe(false);
    expect(stale?.back()).toBe(false);
    h.publish();
  });
  expect(screen.getByText(/Sessions unavailable/)).toBeInTheDocument();
});

it("shares synchronously before switching views, keeps failures in detail and consumes each callback at most once", () => {
  const h = harness();
  h.select();
  fireEvent.click(screen.getByRole("button", { name: "Open fixture root" }));
  h.append.mockReturnValueOnce("The channel draft changed in another window.");
  const share = h.share();
  act(() => expect(share("Actual title")).toMatch(/another window/));
  expect(screen.getByText("Close detail")).toBeVisible();
  h.append.mockImplementation(() => {
    expect(screen.getByText("Close detail")).toBeVisible();
    return undefined;
  });
  act(() => {
    expect(share("Actual title")).toBeUndefined();
    expect(share("Actual title")).toMatch(/no longer available/);
  });
  expect(h.append).toHaveBeenCalledTimes(2);
  expect(h.append).toHaveBeenLastCalledWith(rootId, "Actual title");
  expect(screen.getByText("Channel body")).toBeVisible();
});

it.each(["plugin", "access", "session", "channel", "disconnect", "unmount"])(
  "revokes sharing after %s without touching the draft",
  (boundary) => {
    const h = harness();
    h.select();
    fireEvent.click(screen.getByRole("button", { name: "Open fixture root" }));
    const share = h.share();
    act(() => {
      if (boundary === "plugin") {
        h.entries([]);
        h.publish();
      }
      if (boundary === "access") h.access();
      if (boundary === "session") h.replace();
      if (boundary === "channel") h.beginNavigation();
      if (boundary === "disconnect") h.disconnect();
      if (boundary === "unmount") h.view.unmount();
      expect(share("Actual title")).toMatch(/no longer available/);
    });
    expect(h.append).not.toHaveBeenCalled();
  },
);
