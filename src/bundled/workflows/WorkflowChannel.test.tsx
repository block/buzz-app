// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowChannel } from "./WorkflowChannel";
import {
  createWorkflowFixture,
  fixtureChannel,
  fixtureDefinition,
  fixtureViewer,
} from "./fixtures";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
afterEach(cleanup);

function mount() {
  const fixture = createWorkflowFixture();
  const onClose = vi.fn();
  render(
    <WorkflowChannel
      capability={fixture.capability}
      channelId={fixtureChannel}
      channelName="Fixture channel"
      viewer={fixtureViewer}
      initialSelection={fixtureDefinition}
      initialAction="delete"
      onClose={onClose}
    />,
  );
  return { ...fixture, onClose };
}

it("shows a destructive confirmation, keeps submission errors visible, and labels pending deletion", async () => {
  const fixture = mount();
  const user = userEvent.setup();
  const remove = vi
    .spyOn(fixture.capability, "delete")
    .mockImplementationOnce(() => {
      throw "unavailable";
    });
  const confirm = await screen.findByRole("alertdialog", {
    name: "Delete this workflow?",
  });
  const button = within(confirm).getByRole("button", {
    name: "Delete workflow",
  });
  expect(button).toHaveAttribute("data-variant", "destructive");
  expect(confirm).toHaveTextContent("Work already running may continue.");
  await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
  expect(remove).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Workflow actions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete workflow" }),
  );
  const retryDialog = await screen.findByRole("alertdialog", {
    name: "Delete this workflow?",
  });
  await user.click(
    within(retryDialog).getByRole("button", { name: "Delete workflow" }),
  );
  expect(within(retryDialog).getByRole("alert")).toHaveTextContent(
    "Couldn't start deletion. Your draft is kept.",
  );
  await user.click(
    within(retryDialog).getByRole("button", { name: "Delete workflow" }),
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByRole("button", { name: "Deleting…" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await user.click(screen.getByRole("button", { name: "Deleting…" }));
  expect(fixture.calls.save).toBe(0);
  expect(screen.queryByRole("button", { name: "Saving…" })).toBeNull();
  expect(fixture.calls.delete).toBe(1);
});

it("keeps retained deletion recoverable, reflects a check in progress, and closes only after complete removal", async () => {
  const fixture = mount();
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Delete workflow",
    }),
  );
  await act(async () => {
    fixture.finish("succeeded");
  });
  const activity = screen.getByRole("region", { name: "Workflow operations" });
  expect(within(activity).getByRole("status")).toHaveTextContent(
    "This workflow is still in saved configuration.",
  );
  expect(
    screen.getByRole("button", { name: "Delete workflow" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(fixture.onClose).not.toHaveBeenCalled();
  act(() =>
    fixture.definitions.update({
      status: "loading",
      data: { items: [fixtureDefinition], partial: false },
    }),
  );
  expect(within(activity).getByRole("status")).toHaveTextContent(
    "Checking deletion…",
  );
  expect(
    within(activity).getByRole("button", { name: "Check saved configuration" }),
  ).toBeDisabled();
  act(() =>
    fixture.definitions.update({
      status: "ready",
      data: { items: [], partial: true },
    }),
  );
  expect(within(activity).getByRole("status")).toHaveTextContent(
    "Couldn't confirm deletion.",
  );
  expect(fixture.onClose).not.toHaveBeenCalled();
  act(() =>
    fixture.definitions.update({
      status: "ready",
      data: { items: [], partial: false },
    }),
  );
  expect(fixture.onClose).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog", { name: "Edit workflow" })).toBeNull();
  expect(
    screen.queryByRole("alertdialog", { name: "Leave this draft?" }),
  ).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Saved workflow deleted. Work already running may continue.",
  );
  expect(fixture.calls.delete).toBe(1);
});

it("keeps rejection details disclosed and lets the user resume their draft", async () => {
  const fixture = mount();
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Delete workflow",
    }),
  );
  await act(async () => {
    fixture.finish("rejected");
  });
  const activity = screen.getByRole("region", { name: "Workflow operations" });
  expect(within(activity).getByRole("status")).toHaveTextContent(
    "Couldn't delete this workflow. Review the delivery details.",
  );
  const detail = within(activity).getByText("Fixture conflict");
  expect(detail.closest("details")).not.toHaveAttribute("open");
  fireEvent.click(screen.getByRole("button", { name: "Continue editing" }));
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  expect(fixture.calls.delete).toBe(1);
});
