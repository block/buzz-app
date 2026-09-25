// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UpdateSettings } from "./UpdateSettings";
import { createUpdates, type UpdatePlatform, type Updates } from "./updates";

let updates: Updates | undefined;
afterEach(() => {
  cleanup();
  updates?.dispose();
});

/** Reactions run in registration order, so the owner finishes its check first. */
async function afterBackgroundCheck(check: ReturnType<typeof vi.fn>) {
  await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
  await Promise.resolve(check.mock.results[0]?.value).catch(() => {});
}

function renderSettings(platform: Partial<UpdatePlatform>) {
  updates = createUpdates({
    desktop: true,
    check: async () => null,
    relaunch: async () => {},
    ...platform,
  });
  render(<UpdateSettings updates={updates} />);
  return updates;
}

it("checks on request and checks again from the latest version", async () => {
  const check = vi.fn(async () => null);
  renderSettings({ check });
  await afterBackgroundCheck(check);
  expect(
    screen.getByRole("heading", { name: "Software Updates" }),
  ).toBeVisible();
  expect(
    screen.getByText(
      "Keep Buzz up to date with the latest features and fixes.",
    ),
  ).toBeVisible();
  expect(
    screen.getByText("Check if a new version is available."),
  ).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Check for Updates" }));
  expect(
    await screen.findByText("You're on the latest version."),
  ).toBeVisible();
  expect(check).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Check Again" }));
  await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(3));
});

it("shows progress, then applies a downloaded update", async () => {
  let finishDownload!: () => void;
  const relaunch = vi.fn(async () => {});
  const update = {
    version: "1.2.3",
    download: () =>
      new Promise<void>((resolve) => {
        finishDownload = resolve;
      }),
    install: async () => {},
    close: async () => {},
  };
  renderSettings({ check: async () => update, relaunch });
  expect(await screen.findByText("Downloading update...")).toBeVisible();
  finishDownload();
  expect(
    await screen.findByText("Update downloaded. Click to apply."),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Update Now" }));
  await vi.waitFor(() => expect(relaunch).toHaveBeenCalledOnce());
});

it("reports failures and retries", async () => {
  const check = vi
    .fn<UpdatePlatform["check"]>()
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error("network down"))
    .mockResolvedValue(null);
  renderSettings({ check });
  await afterBackgroundCheck(check);
  fireEvent.click(screen.getByRole("button", { name: "Check for Updates" }));
  expect(await screen.findByText("Update failed: network down")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByText("You're on the latest version."),
  ).toBeVisible();
});

it("explains builds without automatic updates", async () => {
  renderSettings({ desktop: false });
  fireEvent.click(screen.getByRole("button", { name: "Check for Updates" }));
  expect(
    await screen.findByText(
      "Automatic updates aren't available on this build. Download the latest release manually.",
    ),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Check Again" })).toBeVisible();
});
