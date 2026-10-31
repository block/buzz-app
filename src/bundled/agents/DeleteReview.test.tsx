// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Agents, AgentDeleteRequest } from "../../features/agents/service";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { DeleteReview } from "./DeleteReview";

afterEach(cleanup);

const child = "c".repeat(64);

function fixture(
  change: Partial<AgentDeleteRequest> = {},
  communities = 1,
  approve?: (id: string, progress?: (step: string) => void) => Promise<void>,
) {
  let requests: readonly AgentDeleteRequest[] = [
    {
      id: "draft",
      requester: "a".repeat(64),
      requesterName: "Parent",
      owner: "b".repeat(64),
      community: "https://relay.example",
      agent: child,
      agentName: "Child",
      ...change,
    },
  ];
  const listeners = new Set<() => void>();
  const clear = () => {
    requests = [];
    for (const listener of listeners) listener();
  };
  const agents = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    deleteRequests: () => requests,
    memberships: () => Array.from({ length: communities }),
    approveDelete: vi.fn(
      approve ??
        (async () => {
          clear();
        }),
    ),
    dismissDelete: vi.fn(clear),
  };
  render(<DeleteReview agents={agents as unknown as Agents} />, {
    wrapper: ToastProvider,
  });
  return { agents, clear };
}

const openOnDelete = async (user: ReturnType<typeof userEvent.setup>) => {
  await screen.findByRole("alertdialog", { name: "Delete Child?" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(),
  );
  await user.tab();
  return screen.getByRole("button", { name: "Delete" });
};

const gate = () => {
  let release!: () => void;
  let fail!: (reason: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
};

it("opens on Cancel so Enter dismisses without deleting", async () => {
  const user = userEvent.setup();
  const { agents } = fixture();
  const dialog = await screen.findByRole("alertdialog", {
    name: "Delete Child?",
  });
  expect(dialog).toHaveAccessibleDescription(/Parent asked to delete it\./);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(),
  );
  await user.keyboard("{Enter}");
  expect(agents.dismissDelete).toHaveBeenCalledWith("draft");
  expect(agents.approveDelete).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

it("deletes only on the owner's Delete, shows progress, and cannot be dismissed meanwhile", async () => {
  const user = userEvent.setup();
  const held = gate();
  let progress: ((step: string) => void) | undefined;
  const { agents, clear } = fixture({}, 1, async (_, report) => {
    progress = report;
    await held.promise;
    clear();
  });
  const remove = await openOnDelete(user);
  expect(remove).toHaveFocus();
  expect(agents.approveDelete).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(agents.approveDelete).toHaveBeenCalledWith(
      "draft",
      expect.any(Function),
    ),
  );
  expect(remove).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  act(() => progress?.("Leaving relay.example"));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Leaving relay.example…",
  );
  await user.keyboard("{Escape}");
  expect(agents.dismissDelete).not.toHaveBeenCalled();
  expect(screen.getByRole("alertdialog")).toBeVisible();
  await user.keyboard("{Enter}");
  expect(agents.approveDelete).toHaveBeenCalledOnce();
  held.release();
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(await screen.findByText("Deleted Child")).toBeVisible();
  expect(agents.dismissDelete).not.toHaveBeenCalled();
});

it("keeps the dialog open on failure, then finishes on another Delete with Space", async () => {
  const user = userEvent.setup();
  const first = gate();
  let calls = 0;
  const { agents, clear } = fixture({}, 1, async () => {
    calls += 1;
    if (calls === 1) return first.promise;
    clear();
  });
  await openOnDelete(user);
  await user.keyboard("{Enter}");
  await waitFor(() => expect(calls).toBe(1));
  first.fail(
    new Error(
      "Child isn't deleted yet and may still be in some channels. It stays stopped; Delete it again to finish.",
    ),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Child isn't deleted yet",
  );
  expect(screen.getByRole("alertdialog")).toBeVisible();
  const remove = screen.getByRole("button", { name: "Delete" });
  expect(remove).toBeEnabled();
  expect(remove).not.toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  expect(screen.queryByRole("status")).toBeNull();
  remove.focus();
  await user.keyboard(" ");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(agents.approveDelete).toHaveBeenCalledTimes(2);
  expect(await screen.findByText("Deleted Child")).toBeVisible();
});

it("dismisses a failed review with Escape", async () => {
  const user = userEvent.setup();
  const { agents } = fixture({}, 1, async () => {
    throw new Error("Its community isn't connected.");
  });
  await openOnDelete(user);
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("isn't connected");
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(agents.dismissDelete).toHaveBeenCalledWith("draft"),
  );
});

it.each([
  [{}, 1, /Parent asked to delete it\. It stops, leaves every channel/],
  [{ requester: child }, 1, /It asked to be deleted\. It stops, leaves/],
  [{}, 2, /It stops in every community it's in\./],
])(
  "tells the owner who asked and what Delete reaches (%j, %i)",
  async (change, communities, text) => {
    fixture(change, communities);
    expect(
      await screen.findByRole("alertdialog", { name: "Delete Child?" }),
    ).toHaveAccessibleDescription(text);
  },
);
