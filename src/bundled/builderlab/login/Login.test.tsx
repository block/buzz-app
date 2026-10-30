// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { Login } from "./Login";
import { createOAuthSession } from "../oauth/session";
import type { Credential } from "../oauth/browser";
import { deferred } from "../test-helpers";

afterEach(cleanup);
const credential: Credential = {
  value: "private-token",
  account: {
    subject: "user",
    email: "a@example.com",
    canUseRemoteAgents: true,
  },
};
it("shows a desktop requirement in the browser", () => {
  const acquire = vi.fn();
  render(
    <Login
      session={createOAuthSession(acquire)}
      available={false}
      active={() => true}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("desktop app");
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(acquire).not.toHaveBeenCalled();
});
it("sign-out clears the credential and restores the sign-in action", async () => {
  const session = createOAuthSession(async () => credential);
  render(
    <StrictMode>
      <Login session={session} available active={() => true} />
    </StrictMode>,
  );
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  );
  expect(await screen.findByRole("button", { name: "Sign out" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  expect(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  ).toBeEnabled();
  expect(() => session.credential()).toThrow("Sign in");
});
it("shows a signed-in confirmation when email is unavailable", async () => {
  const session = createOAuthSession(async () => ({
    value: "private-token",
    account: { subject: "user", email: "", canUseRemoteAgents: true },
  }));
  render(<Login session={session} available active={() => true} />);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Sign in with Builderlab" }));
  expect(await screen.findByRole("button", { name: "Sign out" })).toBeEnabled();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Signed in to Builderlab.",
  );
});
it("Cancel sign-in aborts a pending sign-in and rejects its late credential", async () => {
  const release = deferred<Credential>();
  let signal: AbortSignal | undefined;
  const acquire = vi.fn(async (current: AbortSignal) => {
    signal = current;
    return release.promise;
  });
  const session = createOAuthSession(acquire);
  render(
    <StrictMode>
      <Login session={session} available active={() => true} />
    </StrictMode>,
  );
  const user = userEvent.setup();
  try {
    await user.click(
      screen.getByRole("button", { name: "Sign in with Builderlab" }),
    );
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Finish sign-in in your browser",
    );
    expect(
      screen.queryByRole("button", { name: "Sign in with Builderlab" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(signal?.aborted).toBe(true);
  } finally {
    await act(async () => {
      release.resolve(credential);
      await release.promise;
    });
  }
  expect(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  ).toBeEnabled();
  expect(() => session.credential()).toThrow("Sign in");
});
it.each(["before", "after"])(
  "preserves sign-in when the view reopens %s browser completion",
  async (reopen) => {
    const release = deferred<Credential>();
    const acquire = vi.fn(() => release.promise);
    const session = createOAuthSession(acquire);
    const showLogin = () =>
      render(
        <StrictMode>
          <Login session={session} available active={() => true} />
        </StrictMode>,
      );
    const mounted = showLogin();
    try {
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Sign in with Builderlab" }));
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("button", { name: "Cancel sign-in" }),
      ).toBeEnabled();
      mounted.unmount();
      if (reopen === "before") {
        showLogin();
        expect(
          screen.getByRole("button", { name: "Cancel sign-in" }),
        ).toBeEnabled();
      }
      await act(async () => {
        release.resolve(credential);
        await release.promise;
      });
      if (reopen === "after") showLogin();
      expect(
        await screen.findByRole("button", { name: "Sign out" }),
      ).toBeEnabled();
      expect(screen.getByRole("status")).toHaveTextContent("a@example.com");
      expect(session.credential()).toBe(credential);
      expect(acquire).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        release.resolve(credential);
        await release.promise;
        session.dispose();
      });
    }
  },
);
it("shows failures and permits retry; inactive contributions cannot start sign-in", async () => {
  const acquire = vi
    .fn()
    .mockRejectedValueOnce(new Error("Browser could not open."))
    .mockResolvedValueOnce(credential);
  const session = createOAuthSession(acquire);
  let active = false;
  render(<Login session={session} available active={() => active} />);
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  );
  expect(acquire).not.toHaveBeenCalled();
  active = true;
  await user.click(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Browser could not open",
  );
  await user.click(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  );
  expect(
    await screen.findByRole("button", { name: "Sign out" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
