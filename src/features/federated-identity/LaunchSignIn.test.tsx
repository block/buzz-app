// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LaunchSignIn } from "./LaunchSignIn";
import type { SessionSnapshot } from "./service";
import { federatedFixture } from "./testing";
afterEach(cleanup);

function launchFixture(organization: string | null = "Block") {
  const h = federatedFixture();
  const authority = h.service.snapshot().authority;
  if (!authority) throw new Error("Fixture authority required");
  h.publish({
    status: "restoring",
    authority: { ...authority, signIn: "at-launch", organization },
  });
  // Native moves to signing-in and stays there until the browser returns.
  vi.mocked(h.service.signIn).mockImplementation(async () => {
    h.publish({ status: "signing-in", revision: crypto.randomUUID() });
    return h.service.snapshot();
  });
  const set = (next: Partial<SessionSnapshot>) => act(() => h.publish(next));
  return { ...h, set };
}

const mounts = vi.fn();
function Workspace() {
  useEffect(() => {
    mounts();
  }, []);
  return <textarea aria-label="Draft" />;
}

it("leaves on-demand builds alone", () => {
  const h = federatedFixture();
  render(
    <LaunchSignIn identity={h.service}>
      <Workspace />
    </LaunchSignIn>,
  );
  expect(screen.getByLabelText("Draft")).toBeVisible();
  expect(h.service.signIn).not.toHaveBeenCalled();
});

it("signs in before the app opens, then opens it", async () => {
  const h = launchFixture();
  render(
    <LaunchSignIn identity={h.service}>
      <Workspace />
    </LaunchSignIn>,
  );
  // The saved session is still being checked: nothing to show yet.
  expect(screen.queryByLabelText("Draft")).not.toBeInTheDocument();
  expect(screen.queryByRole("heading")).not.toBeInTheDocument();

  h.set({ status: "signed-out" });
  expect(h.service.signIn).toHaveBeenCalledOnce();
  expect(
    await screen.findByRole("heading", { name: "Signing you in to Block" }),
  ).toBeVisible();
  expect(screen.queryByLabelText("Draft")).not.toBeInTheDocument();

  h.set({ status: "signed-in", email: "a@example.com" });
  expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Draft")).toBeVisible();
  expect(h.service.signIn).toHaveBeenCalledOnce();
});

it("opens straight away with a restored session", () => {
  const h = launchFixture();
  render(
    <LaunchSignIn identity={h.service}>
      <Workspace />
    </LaunchSignIn>,
  );
  h.set({ status: "signed-in" });
  expect(screen.getByLabelText("Draft")).toBeVisible();
  expect(h.service.signIn).not.toHaveBeenCalled();
});

it("leaves the choice to the person after a cancel, and lets them continue", async () => {
  const user = userEvent.setup();
  const h = launchFixture();
  render(
    <LaunchSignIn identity={h.service}>
      <Workspace />
    </LaunchSignIn>,
  );
  h.set({ status: "signed-out" });
  await user.click(await screen.findByRole("button", { name: "Cancel" }));
  expect(
    await screen.findByRole("heading", { name: "Sign in to Block" }),
  ).toBeVisible();
  expect(h.service.signIn).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("button", { name: "Sign in with Block" }),
  ).toHaveFocus();

  await user.click(screen.getByRole("button", { name: "Not now" }));
  expect(screen.getByLabelText("Draft")).toBeVisible();
  expect(h.service.signIn).toHaveBeenCalledOnce();
});

it("signs in again when a session ends, keeping the app and its focus", async () => {
  const user = userEvent.setup();
  mounts.mockClear();
  const h = launchFixture(null);
  render(
    <LaunchSignIn identity={h.service}>
      <Workspace />
    </LaunchSignIn>,
  );
  h.set({ status: "signed-in" });
  const draft = screen.getByLabelText("Draft");
  await user.type(draft, "half a thought");

  h.set({ status: "reauthentication-required" });
  expect(h.service.signIn).toHaveBeenCalledOnce();
  expect(
    await screen.findByRole("heading", {
      name: "Signing you in to your organization",
    }),
  ).toBeVisible();
  expect(draft).not.toBeVisible();

  h.set({ status: "signed-in" });
  expect(draft).toBeVisible();
  expect(draft).toHaveValue("half a thought");
  expect(draft).toHaveFocus();
  expect(mounts).toHaveBeenCalledOnce();
});

it("asks without opening the browser after an explicit sign-out", async () => {
  const h = launchFixture();
  render(
    <LaunchSignIn identity={h.service}>
      <Workspace />
    </LaunchSignIn>,
  );
  h.set({ status: "signed-in" });
  h.set({ status: "signed-out" });
  expect(
    await screen.findByRole("heading", { name: "Sign in to Block" }),
  ).toBeVisible();
  expect(h.service.signIn).not.toHaveBeenCalled();
});

it("explains a failed sign-in without exposing its code", async () => {
  const h = launchFixture();
  render(
    <LaunchSignIn identity={h.service}>
      <Workspace />
    </LaunchSignIn>,
  );
  h.set({ status: "signed-out" });
  h.set({ status: "signed-out", failure: "callback-refused" });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Sign-in did not finish. Try again.",
  );
  expect(h.service.signIn).toHaveBeenCalledOnce();
});

it("offers a retry when the saved sign-in can't be checked", async () => {
  const user = userEvent.setup();
  const h = launchFixture();
  render(
    <LaunchSignIn identity={h.service}>
      <Workspace />
    </LaunchSignIn>,
  );
  h.set({ status: "unavailable", failure: "network-unavailable" });
  expect(
    await screen.findByRole("heading", {
      name: "Couldn’t reach Block sign-in",
    }),
  ).toBeVisible();
  expect(h.service.signIn).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(h.service.signIn).toHaveBeenCalledOnce();
});
