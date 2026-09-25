// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import { WorkflowCommunity } from "./WorkflowsPage";
import {
  createWorkflowFixture,
  fixtureChannel,
  fixtureViewer,
  fixtureYaml,
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
  const list = {
    status: "ready",
    coverage: "complete",
    channels: [{ id: fixtureChannel, name: "Fixture channel" }],
  };
  const session = {
    workflows: fixture.capability,
    channels: {
      list: () => list,
      ensureList: () => {},
      subscribeList: () => () => {},
    },
  } as unknown as RelaySession;
  render(<WorkflowCommunity session={session} viewer={fixtureViewer} />);
  return fixture;
}

it("delivers a late webhook secret on the landing page after confirmed navigation", async () => {
  const fixture = mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Open Message helper" }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Workflow YAML" }), {
    target: { value: fixtureYaml.replace("message_posted", "webhook") },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(fixture.calls.save).toBe(1);
  expect(fixture.capability.operations.snapshot()[0]?.outcome).toBe("pending");
  fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
  const confirm = await screen.findByRole("alertdialog", {
    name: "Leave this draft?",
  });
  fireEvent.click(within(confirm).getByRole("button", { name: "Leave draft" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Workflow editor" }),
    ).toBeNull(),
  );
  await act(async () => {
    fixture.finish("succeeded", true, "DISPOSABLE-NAVIGATION-SECRET");
  });
  expect(screen.getByRole("dialog", { name: "Webhook ready" })).toBeVisible();
  expect(screen.getByTestId("webhook-secret")).toHaveTextContent(
    "•".repeat(24),
  );
  expect(fixture.calls.take).toBe(1);
  expect(document.body.textContent).not.toContain(
    "DISPOSABLE-NAVIGATION-SECRET",
  );
});

it("labels landing controls as configuration and retains the runtime caveat in detail", async () => {
  mount();
  expect(
    await screen.findByRole("switch", {
      name: "Enabled in configuration: Message helper",
    }),
  ).not.toBeChecked();
  expect(
    screen.getByText(/Saving a disabled configuration does not confirm/),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Open Message helper" }));
  expect(
    await screen.findByRole("region", { name: "Workflow editor" }),
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Workflow settings & activity" }),
  );
  expect(
    within(screen.getByRole("dialog", { name: "Edit workflow" })).getByText(
      /Saving a disabled configuration does not confirm/,
    ),
  ).toBeVisible();
});

it("keeps the editor mounted through exact readback beneath the one-time secret", async () => {
  const fixture = mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Open Message helper" }),
  );
  const editor = screen.getByRole("dialog", { name: "Edit workflow" });
  fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Workflow YAML" }), {
    target: { value: fixtureYaml.replace("message_posted", "webhook") },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await act(async () => {
    fixture.finish("succeeded", true, "DISPOSABLE-SAVE-SECRET");
  });
  expect(editor).toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "Webhook ready" })).toBeVisible();
  expect(fixture.calls.take).toBe(1);
  expect(document.body.textContent).not.toContain("DISPOSABLE-SAVE-SECRET");
  fireEvent.click(
    screen.getByRole("button", { name: "Reveal webhook secret" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByRole("dialog", { name: "Edit workflow" })).toBe(editor);
  expect(screen.getByRole("textbox", { name: "Workflow YAML" })).toHaveValue(
    fixtureYaml.replace("message_posted", "webhook"),
  );
});
