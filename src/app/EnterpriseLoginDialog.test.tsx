// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Communities } from "../features/communities/service";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import {
  EnterpriseCleanupNotice,
  EnterpriseLoginDialog,
} from "./EnterpriseLoginDialog";

const communities = {} as Communities;
const communityId = "https://community.example";

afterEach(cleanup);

it("shows a failed cleanup without storage details", () => {
  render(
    <EnterpriseLoginDialog
      communities={communities}
      state={{
        communityId,
        status: "required",
        cleanup: { retained: true, unrecorded: true, unpruned: false },
      }}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Buzz couldn't remove your previous sign-in from secure storage or record that it was refused. Requests already under way may finish, but Buzz starts no new ones with it while it stays open. It may send it again after a restart.",
  );
  expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
});

it("waits for a sign-out to finish before signing in", () => {
  render(
    <EnterpriseLoginDialog
      communities={communities}
      state={{ communityId, status: "required", waiting: true }}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Finishing sign-out before you can sign in again.",
  );
  expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
});

it("shows every cleanup failure that applies", () => {
  render(
    <EnterpriseLoginDialog
      communities={communities}
      state={{
        communityId,
        status: "required",
        cleanup: { retained: true, unrecorded: false, unpruned: true },
      }}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Buzz couldn't remove your previous sign-in from secure storage. Requests already under way may finish, but Buzz starts no new ones with it and will retry removing it. Buzz couldn't remove an outdated sign-in record from this device.",
  );
});

it("notes a failed prune after a login once, as a toast", async () => {
  let notice: "unpruned" | undefined = "unpruned";
  const listeners = new Set<() => void>();
  const noticing = {
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    snapshot: () => ({ enterpriseNotice: notice }),
    dismissEnterpriseNotice: vi.fn(() => {
      notice = undefined;
      for (const fn of listeners) fn();
    }),
  } as unknown as Communities;
  render(
    <ToastProvider>
      <EnterpriseCleanupNotice communities={noticing} />
    </ToastProvider>,
  );
  expect(
    await screen.findByText(
      "Buzz couldn't remove an outdated sign-in record from this device.",
    ),
  ).toBeInTheDocument();
  await act(async () => {});
  expect(noticing.dismissEnterpriseNotice).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});
