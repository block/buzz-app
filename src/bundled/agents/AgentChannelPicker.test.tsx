// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentChannelPicker } from "./AgentChannelPicker";
import { controlFixture } from "../../features/agents/control-testing";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import type { ChannelList } from "../../features/relay/contracts";
import {
  createNavigationController,
  type OpenResult,
} from "../../features/navigation/controller";
import { createMemoryHistory } from "../../features/navigation/history";
import { readView, writeView } from "../../shared/view-state";

const dispose: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const fn of dispose.splice(0)) fn();
  localStorage.clear();
});
function setup() {
  const { agent } = controlFixture();
  const viewer = "de".repeat(32);
  const scope = `https://relay.example.test:${viewer}`;
  const owned = createRelaySession(null);
  dispose.push(owned.dispose);
  const listeners = new Set<() => void>();
  let list: ChannelList = {
    status: "ready",
    channels: [
      {
        id: "shared",
        name: "shared",
        members: [viewer, agent.pubkey],
        channelType: "stream",
      },
      { id: "unknown", name: "unknown" },
      { id: "namesake", name: "namesake", members: [viewer, "cd".repeat(32)] },
      { id: "not-mine", name: "not-mine", members: [agent.pubkey] },
      {
        id: "archived",
        name: "archived",
        members: [viewer, agent.pubkey],
        archived: true,
      },
      {
        id: "dm",
        name: "dm",
        members: [viewer, agent.pubkey],
        channelType: "dm",
      },
    ],
  };
  const refresh = vi.fn();
  const connection: RelaySnapshot = {
    status: "ready",
    viewer,
    scope,
    generation: 1,
    session: {
      ...owned.session,
      channels: {
        ...owned.session.channels,
        list: () => list,
        ensureList() {},
        refreshList: refresh,
        subscribeList(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    },
  };
  let current = connection;
  const relay: RelayData = {
    snapshot: () => current,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const nav = createNavigationController(createMemoryHistory());
  dispose.push(() => nav.dispose());
  const open = vi.fn(async (): Promise<OpenResult> => ({ status: "opened" }));
  render(
    <AgentChannelPicker
      agent={agent}
      connection={connection}
      relay={relay}
      navigator={{ ...nav.navigation, open }}
    />,
  );
  return {
    agent,
    open,
    refresh,
    scope,
    setList(value: ChannelList, notify = true) {
      list = value;
      if (notify) for (const listener of listeners) listener();
    },
    changeScope() {
      current = { ...connection, scope: "another", generation: 2 };
    },
  };
}
it("lists only known shared memberships and opens the exact community with preserved draft", async () => {
  const f = setup();
  expect(screen.getAllByRole("button").map((item) => item.textContent)).toEqual(
    ["#shared", "Refresh channels"],
  );
  writeView(f.scope, "draft:shared", "Existing draft");
  fireEvent.click(screen.getByRole("button", { name: "#shared" }));
  await act(async () => {});
  expect(f.open).toHaveBeenCalledWith({
    version: 1,
    kind: "conversation",
    channelId: "shared",
    scope: {
      viewer: "de".repeat(32),
      communityOrigin: "https://relay.example.test",
    },
  });
  expect(readView(f.scope, "draft:shared", null)).toMatchObject({
    text: "Existing draft @Fixture agent ",
    recipients: [
      { name: f.agent.name, pubkey: f.agent.pubkey, start: 15, end: 29 },
    ],
  });
});
for (const change of ["scope", "membership", "status"] as const)
  it(`rechecks ${change} at intent before touching draft or navigation`, () => {
    const f = setup();
    writeView(f.scope, "draft:shared", "Keep");
    if (change === "scope") f.changeScope();
    else
      f.setList(
        { status: change === "status" ? "error" : "ready", channels: [] },
        false,
      );
    fireEvent.click(screen.getByRole("button", { name: "#shared" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/changed/);
    expect(f.open).not.toHaveBeenCalled();
    expect(readView(f.scope, "draft:shared", null)).toBe("Keep");
  });
it("holds selection during navigation and surfaces failure without erasing prepared intent", async () => {
  const f = setup();
  let release!: (result: OpenResult) => void;
  f.open.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "#shared" }));
  try {
    expect(screen.getByRole("button", { name: "#shared" })).toBeDisabled();
  } finally {
    await act(async () => release({ status: "failed", reason: "denied" }));
  }
  expect(screen.getByRole("alert")).toHaveTextContent(/did not open/);
  expect(readView(f.scope, "draft:shared", null)).toMatchObject({
    recipients: [{ pubkey: f.agent.pubkey }],
  });
  expect(screen.getByRole("button", { name: "#shared" })).toBeEnabled();
});
it("offers retry for unavailable channel evidence instead of a false loading spinner", () => {
  const f = setup();
  act(() => f.setList({ status: "unavailable", channels: [] }));
  expect(screen.getByRole("status")).toHaveTextContent(/unavailable/);
  fireEvent.click(screen.getByRole("button", { name: "Refresh channels" }));
  expect(f.refresh).toHaveBeenCalledOnce();
});
