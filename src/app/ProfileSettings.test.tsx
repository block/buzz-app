// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { npubEncode } from "nostr-tools/nip19";
import { afterEach, expect, it, vi } from "vitest";
import type { Communities } from "../features/communities/service";
import { ProfileSettings } from "./ProfileSettings";

const viewer = "ab".repeat(32);

function communities(): Communities {
  const state = {
    status: "ready" as const,
    viewer,
    profile: { name: "Buzz User", picture: "" },
    memberships: [],
    selected: null,
  };
  const snapshot = () => state;
  return {
    snapshot,
    subscribe: () => () => {},
    saveProfile: vi.fn(),
  } as unknown as Communities;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("enables profile actions only while the draft differs from the saved profile", async () => {
  const service = communities();
  const user = userEvent.setup();
  render(<ProfileSettings communities={service} />);

  const description = screen.getByLabelText("Profile description (optional)");
  const save = screen.getByRole("button", { name: "Save profile" });
  const cancel = screen.getByRole("button", { name: "Cancel" });
  expect(save).toBeDisabled();
  expect(cancel).toBeDisabled();

  await user.type(description, "Draft");
  expect(save).toBeEnabled();
  expect(cancel).toBeEnabled();

  await user.clear(description);
  expect(save).toBeDisabled();
  expect(cancel).toBeDisabled();

  await user.type(description, "Discard me");
  await user.click(cancel);
  expect(description).toHaveValue("");
  expect(save).toBeDisabled();
  expect(cancel).toBeDisabled();
  expect(service.saveProfile).not.toHaveBeenCalled();
});

it("edits and trims the profile description with a visible limit", async () => {
  const service = communities();
  const user = userEvent.setup();
  render(<ProfileSettings communities={service} />);

  const description = screen.getByLabelText("Profile description (optional)");
  expect(screen.getByText("0 of 500 characters")).toBeVisible();
  await user.type(description, "  Building with Buzz  ");
  expect(screen.getByText("22 of 500 characters")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Save profile" }));

  expect(service.saveProfile).toHaveBeenCalledWith({
    name: "Buzz User",
    picture: "",
    about: "Building with Buzz",
  });
});

it("shows exact public identity formats and copies either value", async () => {
  const writeText = vi.fn(async () => {});
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<ProfileSettings communities={communities()} />);

  expect(screen.getByLabelText("Public key (hex)")).toHaveValue(viewer);
  expect(screen.getByLabelText("Nostr address (npub)")).toHaveValue(
    npubEncode(viewer),
  );

  await user.click(screen.getByRole("button", { name: "Copy public key" }));
  expect(writeText).toHaveBeenLastCalledWith(viewer);
  expect(screen.getByText("Public key copied.")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Copy nostr address" }));
  expect(writeText).toHaveBeenLastCalledWith(npubEncode(viewer));
  expect(screen.getByText("Nostr address copied.")).toBeVisible();
});

it("keeps the identity selectable and explains manual recovery when copy fails", async () => {
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async () => Promise.reject(new Error("denied"))),
    },
  });
  render(<ProfileSettings communities={communities()} />);

  const publicKey = screen.getByLabelText("Public key (hex)");
  await user.click(screen.getByRole("button", { name: "Copy public key" }));
  expect(screen.getByText(/Select it and copy manually\./)).toBeVisible();

  await user.click(publicKey);
  expect((publicKey as HTMLInputElement).selectionStart).toBe(0);
  expect((publicKey as HTMLInputElement).selectionEnd).toBe(viewer.length);
});
