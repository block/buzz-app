// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ClientSnapshot,
  Communities,
} from "../features/communities/service";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import { ManageCommunitiesSettings } from "./ManageCommunitiesSettings";

const primary = { id: "https://primary.example", name: "Primary" };
const secondary = {
  id: "https://unreachable.example",
  name: "Offline",
  localName: "My offline community",
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(selected: string | null = primary.id) {
  let snapshot = {
    viewer: "viewer",
    selected,
    memberships: [primary, secondary],
  } as ClientSnapshot;
  const listeners = new Set<() => void>();
  const leave = vi.fn(async (id: string) => {
    snapshot = {
      ...snapshot,
      selected: snapshot.selected === id ? null : snapshot.selected,
      memberships: snapshot.memberships.filter((m) => m.id !== id),
    };
    for (const listener of listeners) listener();
    return [];
  });
  const communities = {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    leave,
  } as unknown as Communities;
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(
    <ToastProvider>
      <ManageCommunitiesSettings communities={communities} />
    </ToastProvider>,
  );
  return { user: userEvent.setup(), communities, leave, fetch };
}
const removeButton = (name = "Primary") =>
  screen.getByRole("button", {
    name:
      name === "Primary"
        ? "Remove Primary — https://primary.example from this device"
        : "Remove Offline (shown as My offline community on this device) — https://unreachable.example from this device",
  });
const confirm = () =>
  within(screen.getByRole("alertdialog")).getByRole("button", {
    name: "Remove from this device",
  });
it.each([primary.id, null])(
  "removes an unreachable saved community without a relay request, preserving selection %s",
  async (selected) => {
    const h = setup(selected);
    expect(
      screen.queryByRole("button", { name: /Remove Personal space/ }),
    ).toBeNull();
    expect(screen.getByText("Personal space")).toBeVisible();
    await h.user.click(removeButton("My offline community"));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "saved drafts or data",
    );
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "Your membership won’t change.",
    );
    await h.user.click(confirm());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(h.leave).toHaveBeenCalledWith(secondary.id, { purge: true });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.communities.snapshot().selected).toBe(selected);
    expect(screen.queryByText("My offline community")).toBeNull();
    await waitFor(() => expect(removeButton()).toHaveFocus());
  },
);
it("removes the active community and keeps the list available in Personal space", async () => {
  const h = setup();
  await h.user.click(removeButton());
  await h.user.click(confirm());
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(h.communities.snapshot().selected).toBeNull();
  expect(h.fetch).not.toHaveBeenCalled();
  expect(removeButton("My offline community")).toBeEnabled();
});
it("cancels without cleanup and restores the exact row action", async () => {
  const h = setup();
  const trigger = removeButton();
  await h.user.click(trigger);
  const cancel = within(screen.getByRole("alertdialog")).getByRole("button", {
    name: "Cancel",
  });
  await waitFor(() => expect(cancel).toHaveFocus());
  await h.user.keyboard("{Enter}");
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(h.leave).not.toHaveBeenCalled();
});
it("blocks repeated removal and dismissal while pending, then permits retry after a device failure", async () => {
  const h = setup();
  let reject!: (error: Error) => void;
  h.leave.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const trigger = removeButton();
  await h.user.click(trigger);
  await h.user.click(confirm());
  expect(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Cancel",
    }),
  ).toBeDisabled();
  await h.user.keyboard("{Enter}{Escape}");
  expect(screen.getByRole("alertdialog")).toBeVisible();
  expect(h.leave).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error("Device storage unavailable")));
  await screen.findByText(
    /Couldn’t remove Primary.*Device storage unavailable/,
  );
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(trigger).toBeEnabled();
  await h.user.click(trigger);
  await h.user.click(confirm());
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(h.leave).toHaveBeenCalledTimes(2);
});
