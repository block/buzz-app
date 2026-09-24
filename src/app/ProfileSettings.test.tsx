// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { npubEncode } from "nostr-tools/nip19";
import { afterEach, expect, it, vi } from "vitest";
import type { Communities } from "../features/communities/service";
import { ToastProvider } from "../shared/design-system/ui/Toast";
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
  render(<ProfileSettings communities={service} />, { wrapper: ToastProvider });

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

it("previews draft profile content and the shared avatar crop before saving", async () => {
  const service = communities();
  const user = userEvent.setup();
  render(<ProfileSettings communities={service} />, { wrapper: ToastProvider });

  const preview = screen.getByRole("region", { name: "Profile preview" });
  expect(preview).toHaveTextContent("Buzz User");
  expect(preview.querySelector('[data-avatar-shape="circle"]')).toBeVisible();

  await user.clear(screen.getByLabelText("Display name"));
  await user.type(screen.getByLabelText("Display name"), "Clay");
  await user.type(
    screen.getByLabelText("Profile description (optional)"),
    "Building with Buzz",
  );
  await user.type(
    screen.getByLabelText("Picture URL (optional)"),
    "https://example.test/profile.png",
  );

  expect(preview).toHaveTextContent("Clay");
  expect(preview).toHaveTextContent("Building with Buzz");
  expect(preview.querySelector("img")).toHaveAttribute(
    "src",
    "https://example.test/profile.png",
  );
});

it("edits and trims the profile description with a visible limit", async () => {
  const service = communities();
  const user = userEvent.setup();
  render(<ProfileSettings communities={service} />, { wrapper: ToastProvider });

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
  expect(screen.getByText("Profile updated")).toBeVisible();
});

it("rejects profile image URLs with embedded credentials", async () => {
  const service = communities();
  const user = userEvent.setup();
  render(<ProfileSettings communities={service} />, { wrapper: ToastProvider });

  await user.type(
    screen.getByLabelText("Picture URL (optional)"),
    "https://user:secret@example.test/profile.png",
  );

  expect(
    screen.getByText("Enter an HTTPS image URL without embedded credentials."),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
});

it("shows exact public identity formats and copies either value", async () => {
  const writeText = vi.fn(async () => {});
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<ProfileSettings communities={communities()} />, {
    wrapper: ToastProvider,
  });

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

it("keeps copy feedback bound to the latest identity action", async () => {
  let finishPublicKey: (() => void) | undefined;
  const publicKeyWrite = new Promise<void>((resolve) => {
    finishPublicKey = resolve;
  });
  const writeText = vi
    .fn()
    .mockReturnValueOnce(publicKeyWrite)
    .mockResolvedValueOnce(undefined);
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<ProfileSettings communities={communities()} />, {
    wrapper: ToastProvider,
  });

  await user.click(screen.getByRole("button", { name: "Copy public key" }));
  await user.click(screen.getByRole("button", { name: "Copy nostr address" }));
  expect(screen.getByText("Nostr address copied.")).toBeVisible();

  finishPublicKey?.();
  await publicKeyWrite;
  expect(screen.getByText("Nostr address copied.")).toBeVisible();
  expect(screen.queryByText("Public key copied.")).not.toBeInTheDocument();
});

it("keeps the identity selectable and explains manual recovery when copy fails", async () => {
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async () => Promise.reject(new Error("denied"))),
    },
  });
  render(<ProfileSettings communities={communities()} />, {
    wrapper: ToastProvider,
  });

  const publicKey = screen.getByLabelText("Public key (hex)");
  await user.click(screen.getByRole("button", { name: "Copy public key" }));
  expect(screen.getByText(/Select it and copy manually\./)).toBeVisible();

  await user.click(publicKey);
  expect((publicKey as HTMLInputElement).selectionStart).toBe(0);
  expect((publicKey as HTMLInputElement).selectionEnd).toBe(viewer.length);
});
