// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  WorkflowRun,
  WorkflowRunPage,
} from "../../features/workflows/types";
import { WorkflowRuns } from "./WorkflowRuns";
import {
  createWorkflowFixture,
  fixtureDefinition,
  fixtureRun,
  fixtureView,
} from "./fixtures";

afterEach(cleanup);
it("keeps loaded runs visible without a refresh banner and retains failures", async () => {
  const fixture = createWorkflowFixture();
  const data = { runs: [fixtureRun], next: null };
  const runs = fixtureView(data);
  render(
    <WorkflowRuns
      capability={{ ...fixture.capability, runs: () => runs.view }}
      workflow={fixtureDefinition}
    />,
  );
  await screen.findByText("completed");
  act(() => runs.update({ status: "loading", data }));
  expect(screen.getByText("completed")).toBeVisible();
  expect(screen.queryByText("Reading runs…")).toBeNull();
  expect(screen.getByRole("button", { name: "Refresh runs" })).toBeDisabled();
  act(() => runs.update({ status: "error", error: "Read failed", data }));
  expect(screen.getByRole("alert")).toHaveTextContent("Read failed");
  expect(screen.getByRole("button", { name: "Refresh runs" })).toBeEnabled();
});

it("reports an unfinished run only from a page it can vouch for", async () => {
  const fixture = createWorkflowFixture();
  const page = (status: WorkflowRun["status"]): WorkflowRunPage => ({
    runs: [{ ...fixtureRun, status }],
    next: null,
  });
  const runs = fixtureView(page("running"));
  const report = vi.fn();
  const { unmount } = render(
    <WorkflowRuns
      capability={{ ...fixture.capability, runs: () => runs.view }}
      workflow={fixtureDefinition}
      onInProgressChange={report}
    />,
  );
  await screen.findByText("running");
  expect(report).toHaveBeenLastCalledWith(true);
  // A refresh keeps the rows it is replacing on screen.
  act(() => runs.update({ status: "loading", data: page("running") }));
  expect(report).toHaveBeenLastCalledWith(true);
  for (const status of ["error", "idle", "unavailable"] as const) {
    act(() => runs.update({ status, data: page("running") }));
    expect(report).toHaveBeenLastCalledWith(false);
    act(() => runs.update({ status: "ready", data: page("running") }));
    expect(report).toHaveBeenLastCalledWith(true);
  }
  for (const [status, inProgress] of [
    ["completed", false],
    ["pending", true],
    ["failed", false],
    ["waiting_approval", true],
    ["cancelled", false],
    ["running", true],
  ] as const) {
    act(() => runs.update({ status: "ready", data: page(status) }));
    expect(report).toHaveBeenLastCalledWith(inProgress);
  }
  unmount();
  expect(report).toHaveBeenLastCalledWith(false);
});

it("reports nothing in progress when the host has no run history", () => {
  const fixture = createWorkflowFixture();
  const report = vi.fn();
  render(
    <WorkflowRuns
      capability={{
        ...fixture.capability,
        availability: { ...fixture.capability.availability, history: false },
      }}
      workflow={fixtureDefinition}
      onInProgressChange={report}
    />,
  );
  expect(
    screen.getByText("Run history is unavailable from this host."),
  ).toBeVisible();
  expect(report).not.toHaveBeenCalledWith(true);
  expect(fixture.calls.runs).toBe(0);
});
