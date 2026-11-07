// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import type { CommunityRefusal } from "../relay/http-admission";
import { federatedFixture } from "./testing";
import { CommunityRefusalNotice } from "./CommunitySignIn";
afterEach(cleanup);

function mount(
  refusal: CommunityRefusal,
  identity?: ReturnType<typeof federatedFixture>["service"],
) {
  const retry = vi.fn();
  render(
    <ToastProvider>
      {/* The page behind the stack, where focus returns from a notice. */}
      <button type="button">Page</button>
      <CommunityRefusalNotice
        refusal={refusal}
        identity={identity}
        retry={retry}
        relay="wss://relay.example"
      />
    </ToastProvider>,
  );
  screen.getByRole("button", { name: "Page" }).focus();
  return retry;
}
const notice = (name: string) => screen.findByRole("dialog", { name });
const buttons = (dialog: HTMLElement) =>
  [...dialog.querySelectorAll("button")].map((button) => button.textContent);

it("offers only the community server's sign-in when signed out, then retries", async () => {
  const h = federatedFixture();
  const retry = mount("sign-in", h.service);
  const dialog = await notice("Sign in to open this community");
  expect(dialog).toHaveAccessibleDescription(
    "This community needs your builderlab.example sign-in.",
  );
  // Try again would repeat the same refused request.
  expect(buttons(dialog)).toEqual(["Sign in with builderlab.example"]);
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
  mount("sign-in", h.service);
  await notice("Sign in to open this community");
  h.publish({ status: "signing-in" });
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: "Cancel sign-in" }));
  expect(h.service.cancelSignIn).toHaveBeenCalledOnce();
});

// The relay rejected evidence from a session Buzz still holds: signing in
// again means signing out of that server first, whatever its status says.
it("signs in again when the refused session still looks signed in", async () => {
  const h = federatedFixture();
  h.publish({ status: "signed-in", email: "a@example.com" });
  const retry = mount("sign-in", h.service);
  const dialog = await notice("Sign in to open this community");
  expect(buttons(dialog)).toEqual(["Sign in again"]);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Sign in again" }));
  await waitFor(() => expect(retry).toHaveBeenCalledOnce());
  expect(h.service.signOut).toHaveBeenCalledOnce();
  expect(h.service.signIn).toHaveBeenCalledOnce();
});

it("says plainly when this device has no sign-in for the community", async () => {
  mount("sign-in");
  const dialog = await notice(
    "This community needs a sign-in Buzz doesn’t support yet",
  );
  expect(dialog).toHaveAccessibleDescription(
    "Ask the community’s admin which Buzz version or server to use.",
  );
  expect(buttons(dialog)).toEqual([]);
});

it("offers another account where the community refused this one, and Check again", async () => {
  const h = federatedFixture();
  h.publish({ status: "signed-in", email: "bob@personal.example" });
  const retry = mount("access", h.service);
  const dialog = await notice("You don’t have access to this community");
  expect(dialog).toHaveAccessibleDescription(
    "This community didn’t accept bob@personal.example.",
  );
  expect(buttons(dialog)).toEqual(["Switch account", "Check again"]);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Switch account" }));
  await waitFor(() => expect(retry).toHaveBeenCalledOnce());
  expect(h.service.signOut).toHaveBeenCalledOnce();
  expect(h.service.signIn).toHaveBeenCalledOnce();
});

it("leaves a key with no access to its admin, with Check again", async () => {
  const retry = mount("access");
  const dialog = await notice("You don’t have access to this community");
  expect(dialog).toHaveAccessibleDescription(
    "Ask the community’s admin to add you.",
  );
  expect(buttons(dialog)).toEqual(["Check again"]);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Check again" }));
  expect(retry).toHaveBeenCalledOnce();
});
