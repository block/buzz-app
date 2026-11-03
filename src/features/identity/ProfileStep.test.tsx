// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ProfileStep } from "./ProfileStep";

const found = {
  url: "https://relay.example.com",
  host: "relay.example.com",
};
const none = {
  existing: {},
  profile: { name: "", picture: "", about: "" },
  exists: false,
};
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function step(props: Partial<ComponentProps<typeof ProfileStep>> = {}) {
  const onContinue = vi.fn<ComponentProps<typeof ProfileStep>["onContinue"]>(
    () => Promise.resolve(),
  );
  const onBack = vi.fn<ComponentProps<typeof ProfileStep>["onBack"]>(() =>
    Promise.resolve(),
  );
  render(
    <ProfileStep
      found={found}
      read={none}
      defaultName="ada"
      onContinue={onContinue}
      onBack={onBack}
      {...props}
    />,
  );
  return { onContinue, onBack, user: userEvent.setup() };
}
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("suggests and focuses the default name, needs a name to continue, and hands the trimmed profile to Continue", async () => {
  const { onContinue, onBack, user } = step();
  const name = screen.getByRole("textbox", { name: "Display name" });
  expect(screen.getByText(found.url)).toBeVisible();
  expect(name).toHaveValue("ada");
  expect(name).toHaveFocus();
  await user.clear(name);
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  await user.type(name, " Ada ");
  expect(
    screen.queryByRole("textbox", { name: "Profile description (optional)" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(onContinue).toHaveBeenCalledExactlyOnceWith({
    name: "Ada",
    picture: "",
    about: "",
  });
  expect(onBack).not.toHaveBeenCalled();
});

it("prefills a relay profile and hands it to Continue as it is", async () => {
  const profile = { name: "Ada", picture: "", about: "Hi" };
  const { onContinue, user } = step({
    read: { existing: { name: "Ada", about: "Hi" }, profile, exists: true },
    defaultName: "ignored",
  });
  expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue(
    "Ada",
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(onContinue).toHaveBeenCalledExactlyOnceWith(profile);
});

it("holds both buttons while Continue runs, and a rejection stays on the step with the error inline and the draft kept", async () => {
  const gate = deferred();
  const { onContinue, onBack, user } = step();
  onContinue.mockReturnValueOnce(gate.promise);
  const name = screen.getByRole("textbox", { name: "Display name" });
  await user.clear(name);
  await user.type(name, "Ada{Enter}");
  expect(onContinue).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Go back" })).toBeDisabled();
  expect(name).toBeDisabled();
  gate.reject(
    new Error(
      "Your profile change is not current. Your edits are retained; try again.",
    ),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Your profile change is not current. Your edits are retained; try again.",
  );
  expect(name).toHaveValue("Ada");
  expect(name).toBeEnabled();
  expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Go back" })).toBeEnabled();
  expect(onBack).not.toHaveBeenCalled();
});

it("classifies a denied read, and Go back hands off without the draft and keeps the step when it fails", async () => {
  const { onContinue, onBack, user } = step();
  onContinue.mockRejectedValueOnce(
    Object.assign(new Error("Relay read failed (403)"), {}),
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "relay.example.com no longer admits this key. Go back and ask a community administrator.",
  );
  onBack.mockRejectedValueOnce(
    new Error("Could not save this community on this device. Try again."),
  );
  await user.click(screen.getByRole("button", { name: "Go back" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not save this community on this device. Try again.",
  );
  expect(onBack).toHaveBeenCalledExactlyOnceWith();
  expect(screen.getByRole("button", { name: "Go back" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Go back" }));
  expect(onBack).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});
