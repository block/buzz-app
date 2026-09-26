// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { UpdateNotice } from "./UpdateNotice";
import { createUpdates, type Updates } from "./updates";

let updates: Updates | undefined;
afterEach(() => {
  cleanup();
  updates?.dispose();
});

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function readyUpdate() {
  const download = deferred();
  const install = deferred();
  const update = {
    version: "1.2.3",
    download: () => download.promise,
    install: vi.fn(() => install.promise),
    close: vi.fn(async () => {}),
  };
  const checks = [update, null, update];
  const relaunch = vi.fn(async () => {});
  updates = createUpdates({
    desktop: true,
    check: async () => checks.shift() ?? null,
    relaunch,
  });
  render(
    <ToastProvider>
      <UpdateNotice updates={updates} />
    </ToastProvider>,
  );
  await waitFor(() => expect(updates?.snapshot().state).toBe("downloading"));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  download.resolve();
  await screen.findByRole("dialog", { name: "Ready to update!" });
  return { updates, update, install, relaunch };
}

it("offers update and restart once the download is ready", async () => {
  const { update, install, relaunch } = await readyUpdate();
  expect(screen.getByText("Click to update")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  expect(await screen.findByText("Updating")).toBeVisible();
  expect(screen.getByRole("button", { name: "Update now" })).toBeDisabled();
  expect(update.install).toHaveBeenCalledOnce();
  install.resolve();
  await waitFor(() => expect(relaunch).toHaveBeenCalledOnce());
});

it("clears the notice when installing fails so settings can retry", async () => {
  const { updates, install } = await readyUpdate();
  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  install.reject(new Error("signature mismatch"));
  await waitFor(() => expect(updates.snapshot().state).toBe("error"));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

it("stays dismissed until the update leaves the ready state", async () => {
  const { updates } = await readyUpdate();
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss update notification" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(updates.snapshot().state).toBe("ready");

  await updates.checkForUpdate();
  expect(updates.snapshot().state).toBe("up-to-date");
  void updates.checkForUpdate();
  expect(
    await screen.findByRole("dialog", { name: "Ready to update!" }),
  ).toBeVisible();
});
