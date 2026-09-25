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
import { afterEach, expect, it } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import { WorkflowCommunity } from "./WorkflowsPage";
import {
  createWorkflowFixture,
  fixtureChannel,
  fixtureViewer,
  fixtureYaml,
} from "./fixtures";
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
  fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
  expect(fixture.calls.save).toBe(1);
  expect(fixture.capability.operations.snapshot()[0]?.outcome).toBe("pending");
  fireEvent.click(screen.getByRole("button", { name: "All workflows" }));
  const confirm = await screen.findByRole("alertdialog", {
    name: "Change channel?",
  });
  fireEvent.click(
    within(confirm).getByRole("button", { name: "Change channel" }),
  );
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
  expect(screen.getByText("Configured disabled")).toBeVisible();
  expect(
    screen.getByText(/Saving a disabled configuration does not confirm/),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Open Message helper" }));
  expect(
    await screen.findByRole("region", { name: "Workflow editor" }),
  ).toBeVisible();
  expect(
    screen.getByText(/Saving a disabled configuration does not confirm/),
  ).toBeVisible();
});
