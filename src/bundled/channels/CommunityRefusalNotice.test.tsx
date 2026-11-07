// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { federatedFixture } from "../../features/federated-identity/testing";
import { CommunityRefusalNotice } from "./CommunityRefusalNotice";
afterEach(cleanup);

// Native refuses a read it would send without a token with "Federated sign-in
// is required", which the connection reports as a sign-in refusal. Signed out
// of the community's server, that is a sign-in to start, not Try again.
it("offers the server's sign-in, once, when it refused a missing sign-in", async () => {
  const h = federatedFixture();
  const retry = vi.fn();
  render(
    <CommunityRefusalNotice
      refusal="sign-in"
      identity={h.service}
      retry={retry}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "Sign in to open this community" }),
  ).toBeVisible();
  expect(
    screen.getByText("This community needs your builderlab.example sign-in."),
  ).toBeVisible();
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  await userEvent
    .setup()
    .click(
      screen.getByRole("button", { name: "Sign in with builderlab.example" }),
    );
  expect(h.service.signIn).toHaveBeenCalledOnce();
  expect(retry).toHaveBeenCalledOnce();
});

it("asks an expired sign-in the same way, and a sign-in in progress can be canceled", async () => {
  const h = federatedFixture();
  h.publish({ status: "reauthentication-required" });
  render(
    <CommunityRefusalNotice
      refusal="sign-in"
      identity={h.service}
      retry={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "Sign in to open this community" }),
  ).toBeVisible();
  expect(
    screen.getByText("This community needs your builderlab.example sign-in."),
  ).toBeVisible();
  h.publish({ status: "signing-in" });
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: "Cancel sign-in" }));
  expect(h.service.cancelSignIn).toHaveBeenCalledOnce();
});

// Without a sign-in to renew here (no server for it, or already signed in),
// signing in is not this device's to offer: the same prompt, with Try again.
it.each([
  ["no sign-in server", undefined],
  ["a signed-in session", "signed-in"],
] as const)(
  "falls back to Try again for a sign-in refusal with %s",
  async (_case, status) => {
    const h = federatedFixture();
    if (status) h.publish({ status });
    const retry = vi.fn();
    render(
      <CommunityRefusalNotice
        refusal="sign-in"
        identity={status ? h.service : undefined}
        retry={retry}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Sign in to open this community" }),
    ).toBeVisible();
    expect(
      screen.getByText("This community needs you to sign in."),
    ).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(h.service.signIn).not.toHaveBeenCalled();
  },
);

it("never offers sign-in for an account the community does not admit", () => {
  const h = federatedFixture();
  render(
    <CommunityRefusalNotice
      refusal="access"
      identity={h.service}
      retry={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("heading", {
      name: "You don’t have access to this community",
    }),
  ).toBeVisible();
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
});
