// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentControl } from "../../features/agents/control";
import type { ChannelList } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { ProfileAddChannel } from "./ProfileAddChannel";

const pubkey = "a".repeat(64);
const viewer = "b".repeat(64);
const scope = `https://relay.example.test:${viewer}`;
const rows: ChannelList = {
  status: "ready",
  channels: [
    { id: "one", name: "One", channelType: "stream", members: [viewer] },
    {
      id: "joined",
      name: "Joined",
      channelType: "forum",
      members: [pubkey, viewer],
    },
    { id: "dm", name: "DM", channelType: "dm", members: [viewer] },
    { id: "unknown", name: "Unknown", members: [viewer] },
  ],
};
function fixture(managed = true) {
  let finishRefresh: (() => void) | undefined;
  let holdRefresh = false;
  let currentRows = rows;
  let currentNative = true;
  const unavailable = { status: "error" };
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const addAgents = vi.fn(
    (_id: string, _keys: readonly string[], _active?: () => boolean) =>
      new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      }),
  );
  const identities = { identities: [{ pubkey, managed }] };
  const native = {
    status: "ready",
    data: { agents: [{ pubkey, relayUrl: "https://relay.example.test" }] },
  };
  const session = {
    scope,
    channels: { list: () => currentRows },
    workSessions: { available: true, addAgents },
    agentChoices: {
      snapshot: () => identities,
      subscribe: () => () => {},
    },
  } as unknown as RelaySession;
  const control = {
    snapshot: () => (currentNative ? native : unavailable),
    subscribe: () => () => {},
    refresh: vi.fn(() =>
      holdRefresh
        ? new Promise<void>((resolve) => {
            finishRefresh = resolve;
          })
        : Promise.resolve(),
    ),
  } as unknown as AgentControl;
  return {
    session,
    control,
    addAgents,
    holdRefresh: () => {
      holdRefresh = true;
    },
    releaseRefresh: () => finishRefresh?.(),
    loseNative: () => {
      currentNative = false;
    },
    switchScope: () => {
      (session as { scope: string }).scope =
        `https://other.example.test:${viewer}`;
    },
    hideChannel: () => {
      currentRows = {
        ...rows,
        channels: rows.channels.map((row) =>
          row.id === "one" ? { ...row, hidden: true } : row,
        ),
      };
    },
    resolve: () => resolve(),
    reject: (message: string) => reject(new Error(message)),
  };
}
function show(f = fixture()) {
  render(
    <ProfileAddChannel
      session={f.session}
      control={f.control}
      pubkey={pubkey}
      scope={scope}
      list={rows}
    />,
  );
  return f;
}
afterEach(cleanup);
it("offers only classified nonmember channels and waits for confirmed admission", async () => {
  const f = show();
  fireEvent.click(screen.getByRole("button", { name: /Add to channel/ }));
  const dialog = screen.getByRole("dialog");
  const select = screen.getByRole("combobox", { name: "Channel" });
  expect(select.textContent).toContain("#One");
  expect(select.textContent).not.toMatch(/Joined|DM|Unknown/);
  fireEvent.change(select, { target: { value: "one" } });
  fireEvent.click(screen.getByRole("button", { name: "Add to channel" }));
  await waitFor(() => expect(f.addAgents).toHaveBeenCalledOnce());
  expect(f.addAgents.mock.calls[0]?.slice(0, 2)).toEqual(["one", [pubkey]]);
  expect(
    screen.getByRole("button", { name: "Adding…" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(dialog).toBeTruthy();
  await act(async () => f.resolve());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
it("keeps the dialog open with a relay error and permits retry", async () => {
  const f = show();
  fireEvent.click(screen.getByRole("button", { name: /Add to channel/ }));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "one" } });
  fireEvent.click(screen.getByRole("button", { name: "Add to channel" }));
  await waitFor(() => expect(f.addAgents).toHaveBeenCalledOnce());
  await act(async () => f.reject("Membership denied"));
  expect(screen.getByRole("alert").textContent).toBe("Membership denied");
  fireEvent.click(screen.getByRole("button", { name: "Add to channel" }));
  await waitFor(() => expect(f.addAgents).toHaveBeenCalledTimes(2));
  await act(async () => f.resolve());
});
it("does not offer a write action without native and session agent evidence", () => {
  show(fixture(false));
  expect(screen.queryByRole("button", { name: /Add to channel/ })).toBeNull();
});

function submit() {
  fireEvent.click(screen.getByRole("button", { name: /Add to channel/ }));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "one" } });
  fireEvent.click(screen.getByRole("button", { name: "Add to channel" }));
}
it.each(["native", "channel", "unmount"])(
  "does not start admission when %s changes during native refresh",
  async (change) => {
    const f = fixture();
    f.holdRefresh();
    const view = render(
      <ProfileAddChannel
        session={f.session}
        control={f.control}
        pubkey={pubkey}
        scope={scope}
        list={rows}
      />,
    );
    submit();
    await waitFor(() => expect(f.control.refresh).toHaveBeenCalledOnce());
    if (change === "native") f.loseNative();
    else if (change === "channel") f.hideChannel();
    else view.unmount();
    await act(async () => f.releaseRefresh());
    expect(f.addAgents).not.toHaveBeenCalled();
  },
);
it("passes current native, session, and channel eligibility into admission", async () => {
  const f = show();
  submit();
  await waitFor(() => expect(f.addAgents).toHaveBeenCalledOnce());
  const active = f.addAgents.mock.calls[0]?.[2] as unknown as () => boolean;
  expect(active()).toBe(true);
  f.hideChannel();
  expect(active()).toBe(false);
  await act(async () => f.resolve());
});

it("invalidates an in-flight gate after the session scope changes", async () => {
  const f = show();
  submit();
  await waitFor(() => expect(f.addAgents).toHaveBeenCalledOnce());
  const active = f.addAgents.mock.calls[0]?.[2] as unknown as () => boolean;
  f.switchScope();
  expect(active()).toBe(false);
  await act(async () => f.resolve());
});
