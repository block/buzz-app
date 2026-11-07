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
import { UpdateNotice } from "./UpdateNotice";
import { type AgentWork, createUpdates, type Updates } from "./updates";

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

async function readyUpdate(work?: AgentWork) {
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
  updates = createUpdates(
    {
      desktop: true,
      check: async () => checks.shift() ?? null,
      relaunch,
    },
    work,
  );
  const view = render(
    <ToastProvider>
      <UpdateNotice updates={updates} />
    </ToastProvider>,
  );
  await waitFor(() => expect(updates?.snapshot().state).toBe("downloading"));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  download.resolve();
  await screen.findByRole("dialog", { name: "Ready to update!" });
  return { updates, update, install, relaunch, view };
}

it("offers update and restart once the download is ready", async () => {
  const { update, install, relaunch } = await readyUpdate();
  expect(screen.getByText("Click to update")).toBeVisible();
  // An app without agents has nothing to wait for.
  expect(
    screen.queryByRole("button", { name: "Update when agents are idle" }),
  ).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  expect(await screen.findByText("Updating")).toBeVisible();
  expect(screen.getByRole("button", { name: "Update now" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
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
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
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
    // App restoration may remount the notice; recovery belongs to the update owner.
    view.unmount();
    render(
      <ToastProvider>
        <UpdateNotice updates={updates} />
      </ToastProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText("You're on the latest version."),
    ).toBeVisible();
  },
);

it("does not surface background check failures", async () => {
  const check = vi.fn(async () => {
    throw new Error("offline");
  });
  updates = createUpdates({ desktop: true, check, relaunch: async () => {} });
  await act(async () => {});
  render(
    <ToastProvider>
      <UpdateNotice updates={updates} />
    </ToastProvider>,
  );
  expect(check).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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

it("stays dismissed when the notice remounts, e.g. during community restoration", async () => {
  const { updates, view } = await readyUpdate();
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss update notification" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );

  view.unmount();
  render(
    <ToastProvider>
      <UpdateNotice updates={updates} />
    </ToastProvider>,
  );
  expect(updates.snapshot().state).toBe("ready");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  await updates.checkForUpdate();
  void updates.checkForUpdate();
  expect(
    await screen.findByRole("dialog", { name: "Ready to update!" }),
  ).toBeVisible();
});

/** Local agents with `count` working. */
function agentWork(count: number) {
  const listeners = new Set<() => void>();
  return {
    isWorking: () => count > 0,
    workingCount: () => count,
    subscribeWorking(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set(next: number) {
      count = next;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

it("prefers updating once agents are idle while they work, and says what Update now interrupts", async () => {
  const work = agentWork(2);
  await readyUpdate(work);
  expect(
    screen.getByText("2 agents are working. Updating now interrupts them."),
  ).toBeVisible();
  const idle = screen.getByRole("button", {
    name: "Update when agents are idle",
  });
  expect(idle).toHaveAttribute("data-variant", "prominent");
  expect(screen.getByRole("button", { name: "Update now" })).toHaveAttribute(
    "data-variant",
    "subtle",
  );

  work.set(1);
  expect(
    screen.getByText("1 agent is working. Updating now interrupts it."),
  ).toBeVisible();
  work.set(0);
  expect(screen.getByText("Click to update")).toBeVisible();
  expect(screen.getByRole("button", { name: "Update now" })).toHaveAttribute(
    "data-variant",
    "prominent",
  );
});

it("schedules the update, and keeps Update now and Cancel reachable", async () => {
  const { updates, update } = await readyUpdate(agentWork(1));
  fireEvent.click(
    screen.getByRole("button", { name: "Update when agents are idle" }),
  );
  expect(
    await screen.findByRole("dialog", { name: "Update scheduled" }),
  ).toBeVisible();
  expect(
    screen.getByText(
      "Buzz restarts once agents finish their work. 1 working now.",
    ),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Update when agents are idle" }),
  ).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    await screen.findByRole("dialog", { name: "Ready to update!" }),
  ).toBeVisible();
  expect(updates.snapshot().state).toBe("ready");

  fireEvent.click(
    screen.getByRole("button", { name: "Update when agents are idle" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Update now" }));
  expect(update.install).toHaveBeenCalledOnce();
});

it("keeps the schedule when its notice is dismissed", async () => {
  const { updates } = await readyUpdate(agentWork(1));
  fireEvent.click(
    screen.getByRole("button", { name: "Update when agents are idle" }),
  );
  await screen.findByRole("dialog", { name: "Update scheduled" });
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss update notification" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(updates.snapshot().state).toBe("scheduled");
});
