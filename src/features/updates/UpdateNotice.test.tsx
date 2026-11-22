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
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { UpdateAction } from "./UpdateAction";
import { UpdateNotice } from "./UpdateNotice";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
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

const READY = "Update ready. Restart Buzz to install";

function UpdateSurfaces({ updates }: { updates: Updates }) {
  return (
    <ToastProvider>
      <UpdateAction updates={updates} />
      <UpdateNotice updates={updates} />
    </ToastProvider>
  );
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
  const view = render(<UpdateSurfaces updates={updates} />);
  await waitFor(() => expect(updates?.snapshot().state).toBe("downloading"));
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  download.resolve();
  await screen.findByRole("button", { name: READY });
  return { updates, update, install, relaunch, view };
}

it("offers restart from the top bar without a toast once the download is ready", async () => {
  const { update, install, relaunch } = await readyUpdate();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: READY })).toHaveTextContent(
    "Update",
  );

  fireEvent.click(screen.getByRole("button", { name: READY }));
  expect(
    await screen.findByRole("button", { name: "Updating Buzz" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(update.install).toHaveBeenCalledOnce();
  install.resolve();
  await waitFor(() => expect(relaunch).toHaveBeenCalledOnce());
});

it.each(["install", "restart"])(
  "keeps %s failure and retry reachable in the notice",
  async (failure) => {
    const { install, relaunch, view, updates } = await readyUpdate();
    if (failure === "restart")
      relaunch.mockRejectedValueOnce(new Error("shutdown refused"));
    fireEvent.click(screen.getByRole("button", { name: READY }));
    if (failure === "install") install.reject(new Error("read-only location"));
    else install.resolve();
    expect(
      await screen.findByRole("dialog", { name: "Update failed" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        failure === "install" ? "read-only location" : "shutdown refused",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: READY }),
    ).not.toBeInTheDocument();
    // App restoration may remount the notice; recovery belongs to the update owner.
    view.unmount();
    render(<UpdateSurfaces updates={updates} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText("You're on the latest version."),
    ).toBeVisible();
  },
);

it("reports a menu check after a failed install in a toast, not the recovery notice", async () => {
  const { install } = await readyUpdate();
  fireEvent.click(screen.getByRole("button", { name: READY }));
  install.reject(new Error("read-only location"));
  await screen.findByRole("dialog", { name: "Update failed" });

  // The next check finds nothing.
  await act(async () => {
    window.dispatchEvent(new Event("buzz:check-for-updates"));
  });
  expect(
    await screen.findByText("You're on the latest version."),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
});

it("does not surface background check failures", async () => {
  const check = vi.fn(async () => {
    throw new Error("offline");
  });
  updates = createUpdates({ desktop: true, check, relaunch: async () => {} });
  await act(async () => {});
  render(<UpdateSurfaces updates={updates} />);
  expect(check).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("a dismissed failure stays hidden across remounts and later checks", async () => {
  const { install, view, updates } = await readyUpdate();
  fireEvent.click(screen.getByRole("button", { name: READY }));
  install.reject(new Error("read-only location"));
  await screen.findByRole("dialog", { name: "Update failed" });
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss update notification" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );

  view.unmount();
  render(<UpdateSurfaces updates={updates} />);
  expect(updates.snapshot().state).toBe("error");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  await updates.checkForUpdate();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  void updates.checkForUpdate();
  expect(await screen.findByRole("button", { name: READY })).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it.each([
  ["up to date", async () => null, "You're on the latest version."],
  [
    "failed",
    async () => {
      throw new Error("offline");
    },
    "Couldn't check for updates: offline",
  ],
])("reports a %s menu check in a toast", async (_name, result, message) => {
  const background = deferred();
  const check = vi
    .fn<() => Promise<null>>()
    .mockReturnValueOnce(background.promise.then(() => null))
    .mockImplementation(result);
  updates = createUpdates({ desktop: true, check, relaunch: async () => {} });
  render(
    <ToastProvider>
      <UpdateNotice updates={updates} />
    </ToastProvider>,
  );
  // The menu request joins the background check in flight; its result shows.
  act(() => {
    window.dispatchEvent(new Event("buzz:check-for-updates"));
  });
  expect(updates.snapshot().state).toBe("checking");
  expect(screen.queryByText(message)).not.toBeInTheDocument();
  if (_name === "up to date") background.resolve();
  else background.reject(new Error("offline"));
  expect(await screen.findByText(message)).toBeVisible();
  expect(check).toHaveBeenCalledOnce();
});

it("reports repeated menu requests during one check once", async () => {
  const background = deferred();
  updates = createUpdates({
    desktop: true,
    check: () => background.promise.then(() => null),
    relaunch: async () => {},
  });
  render(
    <ToastProvider>
      <UpdateNotice updates={updates} />
    </ToastProvider>,
  );
  act(() => {
    window.dispatchEvent(new Event("buzz:check-for-updates"));
    window.dispatchEvent(new Event("buzz:check-for-updates"));
  });
  await act(async () => background.resolve());
  expect(
    await screen.findByText("You're on the latest version."),
  ).toBeVisible();
  // Both requests have settled by now; only one reported.
  await act(async () => {});
  expect(screen.getAllByText("You're on the latest version.")).toHaveLength(1);
});

it("follows a menu check's download with its progress, then hands off to the top bar", async () => {
  const download = deferred();
  let report!: (event: DownloadEvent) => void;
  const update = {
    version: "1.2.3",
    download: (onEvent: (event: DownloadEvent) => void) => {
      report = onEvent;
      return download.promise;
    },
    install: vi.fn(async () => {}),
    close: async () => {},
  };
  const check = vi
    .fn<() => Promise<typeof update | null>>()
    .mockResolvedValueOnce(null)
    .mockResolvedValue(update);
  const relaunch = vi.fn(async () => {});
  updates = createUpdates({ desktop: true, check, relaunch });
  await act(async () => {});
  render(<UpdateSurfaces updates={updates} />);
  act(() => {
    window.dispatchEvent(new Event("buzz:check-for-updates"));
  });
  const notice = await screen.findByRole("dialog", {
    name: "Update available",
  });
  expect(notice).toHaveTextContent("Downloading Buzz 1.2.3…");
  act(() => {
    report({ event: "Started", data: { contentLength: 200 } });
    report({ event: "Progress", data: { chunkLength: 84 } });
  });
  expect(await screen.findByText("Downloading Buzz 1.2.3… 42%")).toBeVisible();
  expect(screen.queryByRole("button", { name: READY })).not.toBeInTheDocument();
  download.resolve();
  fireEvent.click(await screen.findByRole("button", { name: READY }));
  await waitFor(() => expect(relaunch).toHaveBeenCalledOnce());
  expect(update.install).toHaveBeenCalledOnce();
  // The progress notice closed at readiness; no result toast was shown.
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByText("You're on the latest version.")).toBeNull();
});

it("keeps a dismissed download hidden through completion and remounts until asked again", async () => {
  const download = deferred();
  const update = {
    version: "1.2.3",
    download: () => download.promise,
    install: async () => {},
    close: async () => {},
  };
  updates = createUpdates({
    desktop: true,
    check: async () => update,
    relaunch: async () => {},
  });
  const view = render(<UpdateSurfaces updates={updates} />);
  await act(async () => {
    window.dispatchEvent(new Event("buzz:check-for-updates"));
  });
  await screen.findByRole("dialog", { name: "Update available" });
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss update notification" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );

  view.unmount();
  render(<UpdateSurfaces updates={updates} />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  await act(async () => {
    window.dispatchEvent(new Event("buzz:check-for-updates"));
  });
  expect(
    await screen.findByRole("dialog", { name: "Update available" }),
  ).toBeVisible();
  download.resolve();
  await screen.findByRole("button", { name: READY });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("menu checks preserve the active download through installation", async () => {
  const download = deferred();
  const install = deferred();
  const restart = deferred();
  const update = {
    version: "1.2.3",
    download: vi.fn(() => download.promise),
    install: vi.fn(() => install.promise),
    close: vi.fn(async () => {}),
  };
  // Native checks return a fresh handle, even for the same version.
  const replacement = { ...update, install: vi.fn(async () => {}) };
  const check = vi
    .fn()
    .mockResolvedValueOnce(update)
    .mockResolvedValue(replacement);
  const relaunch = vi.fn(() => restart.promise);
  updates = createUpdates({ desktop: true, check, relaunch });
  render(<UpdateSurfaces updates={updates} />);
  const request = () =>
    act(async () => {
      window.dispatchEvent(new Event("buzz:check-for-updates"));
    });
  try {
    await waitFor(() => expect(update.download).toHaveBeenCalledOnce());
    await request();
    expect(await screen.findByText("Downloading Buzz 1.2.3…")).toBeVisible();
    expect(check).toHaveBeenCalledOnce();
    await act(async () => download.resolve());
    await screen.findByRole("button", { name: READY });
    await request();
    expect(
      await screen.findByText("An update is ready. Restart Buzz to install."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: READY }));
    await screen.findByRole("button", { name: "Updating Buzz" });
    await request();
    await act(async () => install.resolve());
    expect(relaunch).toHaveBeenCalledOnce();
    await request();
    expect(check).toHaveBeenCalledOnce();
    expect(update.close).not.toHaveBeenCalled();
    expect(update.install).toHaveBeenCalledOnce();
    expect(replacement.install).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      download.resolve();
      install.resolve();
      restart.resolve();
    });
  }
});

it("reports a build without updates in a toast", async () => {
  updates = createUpdates({
    desktop: false,
    check: async () => null,
    relaunch: async () => {},
  });
  render(
    <ToastProvider>
      <UpdateNotice updates={updates} />
    </ToastProvider>,
  );
  act(() => {
    window.dispatchEvent(new Event("buzz:check-for-updates"));
  });
  expect(
    await screen.findByText(
      "Automatic updates aren't available on this build.",
    ),
  ).toBeVisible();
});
