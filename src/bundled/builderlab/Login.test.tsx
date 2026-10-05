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
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Login } from "./Login";
import { createSession } from "./session";
import type { Account } from "./api";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
const account: Account = {
  email: "dev@example.com",
  name: "Dev",
  expiresAt: null,
  profile: "default",
  serviceUrl: "https://block.builderlab.xyz/api/goose",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let stored: Account | null;
let loginResult: ReturnType<typeof deferred<Account>>;
let signOutResult: ReturnType<typeof deferred<void>> | undefined;
beforeEach(() => {
  stored = null;
  loginResult = deferred<Account>();
  signOutResult = undefined;
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command) => {
      switch (command) {
        case "plugin:builderlab|auth":
          return stored;
        case "plugin:builderlab|login":
          return loginResult.promise;
        case "plugin:builderlab|cancel":
          loginResult.reject("Builderlab authentication canceled");
          return;
        case "plugin:builderlab|sign_out":
          if (signOutResult) await signOutResult.promise;
          stored = null;
          return;
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    });
});
afterEach(cleanup);
function card() {
  const session = createSession();
  const active = vi.fn(() => true);
  return {
    session,
    active,
    ...render(<Login session={session} active={active} />),
  };
}

it("restores the CLI session, refreshes external changes, and awaits sign-out", async () => {
  stored = account;
  card();
  expect(
    await screen.findByText("Signed in as dev@example.com."),
  ).toBeVisible();
  expect(screen.getByText(/Profile: default/)).toHaveTextContent(
    account.serviceUrl,
  );
  expect(screen.getByText(/When both use the same profile/)).toBeVisible();
  stored = { ...account, email: "rotated@example.com" };
  fireEvent.click(screen.getByRole("button", { name: "Refresh session" }));
  await screen.findByText("Signed in as rotated@example.com.");
  signOutResult = deferred<void>();
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("plugin:builderlab|sign_out"),
  );
  expect(screen.getByRole("button", { name: "Sign out" })).toBeDisabled();
  try {
    expect(screen.getByRole("status")).toHaveTextContent("Signing out…");
  } finally {
    signOutResult.resolve();
  }
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Sign in with Builderlab" }),
    ).toBeEnabled(),
  );
  expect(invoke).not.toHaveBeenCalledWith("plugin:builderlab|login");
});

it("drives browser login to the account and does not fetch community actions", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  card();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Sign in with Builderlab" }),
    ).toBeEnabled(),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("plugin:builderlab|login"),
  );
  try {
    expect(screen.getByRole("status")).toHaveTextContent(
      "Finish sign-in in your browser",
    );
    expect(
      screen.getByRole("button", { name: "Refresh session" }),
    ).toBeDisabled();
  } finally {
    loginResult.resolve(account);
  }
  await screen.findByText("Signed in as dev@example.com.");
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

it("cancels pending login, permits retry, and detaches cancellation after completion", async () => {
  const { session, unmount } = card();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Sign in with Builderlab" }),
    ).toBeEnabled(),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel sign-in" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Sign in with Builderlab" }),
    ).toBeEnabled(),
  );
  expect(invoke).toHaveBeenCalledWith("plugin:builderlab|cancel");
  expect(screen.queryByRole("alert")).toBeNull();
  loginResult = deferred<Account>();
  fireEvent.click(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  );
  loginResult.resolve(account);
  await screen.findByText("Signed in as dev@example.com.");
  vi.mocked(invoke).mockClear();
  unmount();
  session.dispose();
  expect(invoke).not.toHaveBeenCalled();
});

it("shows Keychain errors, retries reads, and fences inactive or disposed UI", async () => {
  vi.mocked(invoke).mockRejectedValueOnce(
    "Keychain access was denied. Allow Buzz and retry.",
  );
  const { active, session } = card();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Keychain access was denied.",
  );
  stored = account;
  fireEvent.click(screen.getByRole("button", { name: "Refresh session" }));
  await screen.findByText("Signed in as dev@example.com.");
  active.mockReturnValue(false);
  vi.mocked(invoke).mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(invoke).not.toHaveBeenCalled();
  session.dispose();
  await session.signOut();
  expect(invoke).not.toHaveBeenCalled();
});

it("disable cancels a pending attempt and never adopts its late result", async () => {
  const { session } = card();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Sign in with Builderlab" }),
    ).toBeEnabled(),
  );
  // The native exchange may already be in flight; cancellation returns promptly
  // while native cleanup later persists or revokes it according to its fence.
  vi.mocked(invoke)
    .mockImplementationOnce(() => loginResult.promise)
    .mockImplementationOnce(async () => undefined);
  fireEvent.click(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  );
  session.dispose();
  expect(invoke).toHaveBeenCalledWith("plugin:builderlab|cancel");
  await act(async () => {
    loginResult.resolve(account);
    await loginResult.promise;
  });
  expect(session.snapshot().account).toBeNull();
});

it("a failed sign-out stays retryable without pretending the saved account disappeared", async () => {
  stored = account;
  card();
  await screen.findByText("Signed in as dev@example.com.");
  vi.mocked(invoke).mockRejectedValueOnce(
    "The Builderlab session store could not be updated.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "could not be updated",
  );
  expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Sign in with Builderlab" }),
    ).toBeEnabled(),
  );
});

it("does not start a new store read after disabling during sign-out", async () => {
  stored = account;
  const { session } = card();
  await screen.findByText("Signed in as dev@example.com.");
  signOutResult = deferred<void>();
  let finished!: Promise<void>;
  act(() => {
    finished = session.signOut();
  });
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("plugin:builderlab|sign_out"),
  );
  session.dispose();
  vi.mocked(invoke).mockClear();
  await act(async () => {
    signOutResult?.resolve();
    await finished;
  });
  expect(invoke).not.toHaveBeenCalled();
});
