// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayData } from "../../features/relay/service";
import type { Navigation } from "../../features/navigation/controller";
import { AgentMessageButton } from "./AgentMessageButton";
afterEach(cleanup);
function setup(
  agentChoices: object = {
    snapshot: () => ({ identities: [{ pubkey: "agent", managed: true }] }),
  },
) {
  const open = vi.fn(
    async (_keys: string[], _signal: AbortSignal) => "dm-agent",
  );
  const navigate = vi.fn(async () => ({ status: "opened" }));
  const snapshot = {
    status: "ready",
    generation: 1,
    viewer: "owner",
    origin: "https://community.example",
    session: {
      directMessages: { available: true, open },
      agentChoices,
    },
  };
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RelayData;
  const current = { kind: "agent" };
  const navigator = {
    open: navigate,
    snapshot: () => ({ entry: { target: current } }),
  } as unknown as Navigation;
  return { open, navigate, relay, navigator, current };
}
it("opens the agent conversation in the current community without sending a message", async () => {
  const user = userEvent.setup();
  const f = setup();
  render(<AgentMessageButton {...f} pubkey="agent" navigation={undefined} />);
  await user.click(screen.getByRole("button", { name: "Message" }));
  expect(f.open).toHaveBeenCalledWith(["agent"], expect.any(AbortSignal));
  expect(f.navigate).toHaveBeenCalledWith({
    version: 1,
    kind: "conversation",
    channelId: "dm-agent",
    scope: { viewer: "owner", communityOrigin: "https://community.example" },
  });
});
it.each([true, false])(
  "waits for agents still loading before deciding: managed=%s",
  async (managed) => {
    const user = userEvent.setup();
    let loaded = false;
    let finish!: () => void;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            loaded = true;
            resolve();
          };
        }),
    );
    const f = setup({
      snapshot: () => ({
        identities: loaded && managed ? [{ pubkey: "agent", managed }] : [],
        managedPending: !loaded,
      }),
      refresh,
    });
    render(<AgentMessageButton {...f} pubkey="agent" navigation={undefined} />);
    await user.click(screen.getByRole("button", { name: "Message" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledExactlyOnceWith(false));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(f.open).not.toHaveBeenCalled();
    await act(async () => finish());
    if (managed) await waitFor(() => expect(f.navigate).toHaveBeenCalledOnce());
    else {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "This agent is not ready to message in this community.",
      );
      expect(f.open).not.toHaveBeenCalled();
    }
  },
);
it("does not wait for the agent library, which cannot control an agent", async () => {
  const user = userEvent.setup();
  const refresh = vi.fn(async () => {});
  const f = setup({
    snapshot: () => ({ identities: [], pending: true, managedPending: false }),
    refresh,
  });
  render(<AgentMessageButton {...f} pubkey="agent" navigation={undefined} />);
  await user.click(screen.getByRole("button", { name: "Message" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This agent is not ready to message in this community.",
  );
  expect(refresh).not.toHaveBeenCalled();
  expect(f.open).not.toHaveBeenCalled();
});
it("shows an opening error and allows retry", async () => {
  const user = userEvent.setup();
  const f = setup();
  f.open.mockRejectedValueOnce(new Error("Could not open chat"));
  render(<AgentMessageButton {...f} pubkey="agent" navigation={undefined} />);
  await user.click(screen.getByRole("button", { name: "Message" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not open chat",
  );
  await user.click(screen.getByRole("button", { name: "Message" }));
  await waitFor(() => expect(f.navigate).toHaveBeenCalledOnce());
});
it("cancels an opening when the profile is closed", async () => {
  const user = userEvent.setup();
  const f = setup();
  let finish!: (channel: string) => void;
  f.open.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(
    <AgentMessageButton {...f} pubkey="agent" navigation={undefined} />,
  );
  await user.click(screen.getByRole("button", { name: "Message" }));
  view.unmount();
  expect(f.open.mock.calls[0]?.[1].aborted).toBe(true);
  await act(async () => finish("dm-agent"));
  expect(f.navigate).not.toHaveBeenCalled();
});
it("leaves Settings in place when an opening finishes behind it", async () => {
  const user = userEvent.setup();
  const f = setup();
  let finish!: (channel: string) => void;
  f.open.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<AgentMessageButton {...f} pubkey="agent" navigation={undefined} />);
  await user.click(screen.getByRole("button", { name: "Message" }));
  f.current.kind = "settings";
  await act(async () => finish("dm-agent"));
  expect(f.navigate).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Message" })).toBeEnabled();
});
