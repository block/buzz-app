// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAccountConnection,
  type ExistingAccount,
} from "./account-connection";
import { ExistingAccountDialog } from "./ExistingAccountDialog";
import { CommunityRail } from "./CommunityRail";
import type { Communities } from "./service";
afterEach(cleanup);
const viewer = "a".repeat(64);
const verified: ExistingAccount = {
  viewer,
  origin: "https://relay.example",
  relayAuthor: "b".repeat(64),
  archiveAuthority: null,
  lease: "11111111-1111-4111-8111-111111111111",
};
function setup(rail = false, status = "unavailable") {
  const host = {
    begin: vi.fn(async () => "ticket"),
    run: vi.fn(async () => verified),
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const connection = createAccountConnection(host),
    close = vi.fn(),
    select = vi.fn();
  const state = {
    status,
    profile: { name: "", picture: "" },
    memberships: [],
    selected: null,
  };
  const communities = {
    accountConnection: connection,
    snapshot: () => state,
    subscribe: () => () => {},
    select,
  } as unknown as Communities;
  const view = render(
    rail ? (
      <CommunityRail communities={communities} />
    ) : (
      <ExistingAccountDialog connection={connection} close={close} />
    ),
    { reactStrictMode: true },
  );
  return { host, connection, close, view, select, user: userEvent.setup() };
}
it("rail exposes explicit prerequisite without startup calls or fake connected membership", async () => {
  const h = setup(true);
  expect(h.host.begin).not.toHaveBeenCalled();
  await h.user.click(
    screen.getByRole("button", { name: "Connect existing account" }),
  );
  expect(
    screen.getByRole("heading", { name: "Use an existing Buzz account" }),
  ).toBeVisible();
  expect(h.host.begin).not.toHaveBeenCalled();
  await h.user.type(screen.getByLabelText("Expected public key"), viewer);
  await h.user.type(screen.getByLabelText("Relay URL"), "wss://relay.example");
  expect(h.host.begin).not.toHaveBeenCalled();
  await h.user.click(
    screen.getByRole("button", { name: "Connect existing account" }),
  );
  expect(
    await screen.findByText("Native connection open for this session."),
  ).toBeVisible();
  expect(screen.getByText(/Membership is checked by the relay/)).toBeVisible();
  expect(h.select).not.toHaveBeenCalled();
  await h.user.click(screen.getByRole("button", { name: "Close" }));
  expect(
    screen.queryByRole("heading", { name: "Use an existing Buzz account" }),
  ).toBeNull();
  expect(h.connection.snapshot().status).toBe("connected");
  expect(h.host.close).not.toHaveBeenCalled();
});
it("keeps a cancellable pending operation and fences completion after close", async () => {
  const h = setup();
  const held = deferred<ExistingAccount>();
  const entered = deferred<void>();
  h.host.run.mockImplementation(() => {
    entered.resolve(undefined);
    return held.promise;
  });
  await h.user.type(screen.getByLabelText("Expected public key"), viewer);
  await h.user.type(screen.getByLabelText("Relay URL"), verified.origin);
  try {
    await h.user.click(
      screen.getByRole("button", { name: "Connect existing account" }),
    );
    await entered.promise;
    expect(
      screen.getByRole("button", { name: "Connect existing account" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel check" })).toBeEnabled();
    await h.user.click(screen.getByRole("button", { name: "Close" }));
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.host.cancel).toHaveBeenCalledWith("ticket");
  } finally {
    await act(async () => held.resolve(verified));
  }
  expect(
    screen.queryByText("Native connection open for this session."),
  ).toBeNull();
  h.view.unmount();
  expect(h.connection.snapshot().status).toBe("idle");
});
it("preserves entered input on failure and explicit retry, but never runs automatically", async () => {
  const h = setup();
  h.host.run.mockRejectedValueOnce("denied");
  await h.user.type(screen.getByLabelText("Expected public key"), viewer);
  await h.user.type(screen.getByLabelText("Relay URL"), verified.origin);
  await h.user.click(
    screen.getByRole("button", { name: "Connect existing account" }),
  );
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Expected public key")).toHaveValue(viewer);
  expect(screen.getByLabelText("Relay URL")).toHaveValue(verified.origin);
  expect(h.host.begin).toHaveBeenCalledTimes(1);
  await h.user.click(
    screen.getByRole("button", { name: "Connect existing account" }),
  );
  await waitFor(() => expect(h.connection.snapshot().status).toBe("connected"));
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

it("explicit native capability cannot be bypassed by incidental client readiness", async () => {
  const h = setup(true, "ready");
  await h.user.click(
    screen.getByRole("button", { name: "Connect existing account" }),
  );
  expect(
    screen.getByRole("heading", { name: "Use an existing Buzz account" }),
  ).toBeVisible();
  expect(h.host.begin).not.toHaveBeenCalled();
});

it("disconnect failure keeps its retry control and does not falsely report a released account", async () => {
  const h = setup();
  await act(() => h.connection.check(viewer, verified.origin));
  h.host.close.mockRejectedValueOnce(new Error("IPC unavailable"));
  await h.user.click(
    screen.getByRole("button", { name: "Disconnect native account" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Disconnect was not confirmed",
  );
  expect(h.connection.snapshot().account).toEqual(verified);
  await h.user.click(
    screen.getByRole("button", { name: "Disconnect native account" }),
  );
  expect(
    await screen.findByRole("button", { name: "Connect existing account" }),
  ).toBeEnabled();
  expect(h.connection.snapshot().account).toBeUndefined();
});
