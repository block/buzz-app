// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { connectSignedTransport } from "../../features/relay/transport";
import { nativeSocket } from "../../features/relay/native-socket";
import { hostSigner } from "../../features/relay/testing";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import type { ClientSnapshot } from "../../features/communities/service";
import type { FederatedIdentity } from "../../features/federated-identity/service";
import { federatedFixture } from "../../features/federated-identity/testing";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { ConnectionNotices } from "./ConnectionNotices";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: vi.fn(),
}));
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
  vi.resetAllMocks();
});

const viewer = "c".repeat(64);
const client = { memberships: [] } as unknown as ClientSnapshot;

function fixture(
  session: ReturnType<typeof createRelaySession>["session"],
  initial: Omit<RelaySnapshot, "session" | "generation">,
  federatedIdentity?: FederatedIdentity,
) {
  let snapshot: RelaySnapshot = { ...initial, session, generation: 1 };
  const listeners = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry() {},
    tryAgain() {},
    disconnect() {},
    async clearCache() {},
  };
  render(
    <ToastProvider>
      <ConnectionNotices
        communities={{
          relay,
          subscribe: () => () => {},
          snapshot: () => client,
        }}
        federatedIdentity={federatedIdentity}
      />
    </ToastProvider>,
  );
  return {
    relay,
    connection(change: (current: RelaySnapshot) => RelaySnapshot) {
      act(() => {
        snapshot = change(snapshot);
        for (const listener of listeners) listener();
      });
    },
  };
}

/** A protected community whose transport was handed back before NIP-FI
 * admission, as native discovery and local-key restore do: the relay's
 * refusal arrives later, on the live socket. */
async function refusedLive(refusal: string) {
  let connects = 0;
  vi.mocked(invoke).mockImplementation((command) => {
    if (command !== "relay_socket_connect") return Promise.resolve();
    return ++connects === 1 ? Promise.reject(refusal) : new Promise(() => {});
  });
  const identity = federatedFixture();
  const transport = await connectSignedTransport(
    hostSigner(),
    "https://relay.test",
    "e".repeat(64),
    nativeSocket,
  );
  const owner = createRelaySession(transport);
  owners.push(owner);
  const f = fixture(
    owner.session,
    { status: "ready", scope: `https://relay.test:${viewer}`, viewer },
    identity.service,
  );
  await waitFor(() =>
    expect(owner.session.live.snapshot().status).toBe("error"),
  );
  return { f, session: owner.session, identity, connects: () => connects };
}

it("offers explicit sign-in when the live socket refuses a protected community", async () => {
  const h = await refusedLive("Federated sign-in is required");
  // Nothing signs in on its own.
  expect(
    await screen.findByText(
      "This community requires builderlab.example sign-in.",
    ),
  ).toBeVisible();
  expect(h.identity.service.signIn).not.toHaveBeenCalled();
  expect(h.connects()).toBe(1);
  await userEvent.setup().click(
    await screen.findByRole("button", {
      name: "Sign in with builderlab.example",
    }),
  );
  expect(h.identity.service.signIn).toHaveBeenCalledOnce();
  // A completed sign-in reconnects the live socket with the new session.
  await waitFor(() => expect(h.connects()).toBe(2));
});

/** Try again is the relay's person-initiated retry (it asks the issuer
 * again; see service.test.ts), which retries every failed source, the live
 * socket among them. */
async function tryAgainReconnects(h: Awaited<ReturnType<typeof refusedLive>>) {
  const tryAgain = vi
    .spyOn(h.f.relay, "tryAgain")
    .mockImplementation(() => h.session.recovery?.retryAll());
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Try again" }));
  expect(tryAgain).toHaveBeenCalledOnce();
  await waitFor(() => expect(h.connects()).toBe(2));
}

it.each([
  ["binding-mismatch", "identity link"],
  ["authorization-denied", "administrator"],
])("shows %s recovery from the live socket", async (refusal, text) => {
  const h = await refusedLive(refusal);
  expect(await screen.findByRole("alert")).toHaveTextContent(text);
  expect(
    screen.queryByRole("button", { name: "Sign in with builderlab.example" }),
  ).toBeNull();
  // An administrator may have fixed it since: nothing retries on its own.
  expect(h.connects()).toBe(1);
  await tryAgainReconnects(h);
});

it.each(["adapter-refused", "grant-refused", "invalid-response"])(
  "explains a %s issuer refusal and offers Try again, not sign-in",
  async (refusal) => {
    const h = await refusedLive(refusal);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Buzz couldn’t confirm your organization sign-in for this community. Try again. If it keeps happening, contact your administrator.",
    );
    expect(
      screen.queryByRole("button", { name: "Sign in with builderlab.example" }),
    ).toBeNull();
    expect(h.connects()).toBe(1);
    await tryAgainReconnects(h);
  },
);

it("offers no Try again for a live refusal that sign-in fixes", async () => {
  await refusedLive("Federated sign-in is required");
  expect(
    await screen.findByRole("button", {
      name: "Sign in with builderlab.example",
    }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

it("reports a community's refusal once it stops retrying, with Check again", async () => {
  const owner = createRelaySession(null);
  owners.push(owner);
  const f = fixture(owner.session, {
    status: "error",
    denied: true,
    retrying: true,
    refusal: "access",
  });
  const tryAgain = vi.spyOn(f.relay, "tryAgain");
  // A connection retrying by itself is still connecting.
  expect(screen.queryByText("You don’t have access to this community")).toBe(
    null,
  );
  f.connection(({ retrying: _, ...current }) => current);
  expect(
    await screen.findByText("You don’t have access to this community"),
  ).toBeVisible();
  fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
  expect(tryAgain).toHaveBeenCalledOnce();
  f.connection(({ denied: _, ...current }) => ({
    ...current,
    status: "connecting",
  }));
  await waitFor(() =>
    expect(
      screen.queryByText("You don’t have access to this community"),
    ).toBeNull(),
  );
});
