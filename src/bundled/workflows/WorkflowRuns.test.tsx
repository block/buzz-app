// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { WorkflowRuns } from "./WorkflowRuns";
import {
  createWorkflowFixture,
  fixtureDefinition,
  fixtureRun,
  fixtureView,
} from "./fixtures";

afterEach(cleanup);
it("labels each status and shows a step only while awaiting approval or failed", async () => {
  const fixture = createWorkflowFixture();
  let nextId = 0;
  const run = (status: (typeof fixtureRun)["status"], currentStep: number) => ({
    ...fixtureRun,
    id: `${fixtureRun.id.slice(0, -1)}${nextId++}`,
    status,
    currentStep,
  });
  const runs = fixtureView({
    runs: [
      run("pending", 0),
      run("running", 2),
      run("waiting_approval", 3),
      run("failed", 0),
      run("cancelled", 5),
      run("completed", 6),
    ],
    next: null,
  });
  runs.update({ status: "ready", data: runs.view.snapshot().data });
  render(
    <WorkflowRuns
      capability={{ ...fixture.capability, runs: () => runs.view }}
      workflow={fixtureDefinition}
    />,
  );
  for (const label of [
    "Pending",
    "Running",
    "Waiting for approval",
    "Failed",
    "Cancelled",
    "Completed",
  ])
    expect(await screen.findByText(label)).toBeVisible();
  // The relay never updates currentStep while a run is running, so only the
  // waiting_approval run and the failed run that started show a step, numbered
  // from 1.
  expect(
    screen.getAllByText(/^Current step:/).map((line) => line.textContent),
  ).toEqual(["Current step: 4"]);
  expect(
    screen.getAllByText(/^Step \d+$/).map((line) => line.textContent),
  ).toEqual(["Step 1"]);
});

it("claims no step for a run the relay rejected before it started", async () => {
  const fixture = createWorkflowFixture();
  // What the relay stores for a run turned away at its concurrency limit:
  // failed on step 0 with no trace, like a first-step failure, but never started.
  const runs = fixtureView({
    runs: [
      {
        ...fixtureRun,
        status: "failed" as const,
        currentStep: 0,
        trace: [],
        startedAt: null,
        errorCode: "capacity_exceeded",
        errorMessage: "capacity exceeded",
      },
    ],
    next: null,
  });
  runs.update({ status: "ready", data: runs.view.snapshot().data });
  render(
    <WorkflowRuns
      capability={{ ...fixture.capability, runs: () => runs.view }}
      workflow={fixtureDefinition}
    />,
  );
  expect(await screen.findByText("Failed")).toBeVisible();
  expect(
    screen.getByText("capacity_exceeded: capacity exceeded"),
  ).toBeVisible();
  expect(screen.queryByText(/^Step \d+$/)).toBeNull();
});

it("says a workflow has no runs yet", async () => {
  const fixture = createWorkflowFixture();
  const runs = fixtureView({ runs: [], next: null });
  runs.update({ status: "ready", data: { runs: [], next: null } });
  render(
    <WorkflowRuns
      capability={{ ...fixture.capability, runs: () => runs.view }}
      workflow={fixtureDefinition}
    />,
  );
  expect(await screen.findByText("No runs yet.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Load older runs" })).toBeNull();
});

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
  await screen.findByText("Completed");
  act(() => runs.update({ status: "loading", data }));
  expect(screen.getByText("Completed")).toBeVisible();
  expect(screen.queryByText("Reading runs…")).toBeNull();
  // The list rereads itself, so only a failure offers a refresh.
  expect(screen.queryByRole("button", { name: "Refresh runs" })).toBeNull();
  act(() => runs.update({ status: "error", error: "Read failed", data }));
  expect(screen.getByRole("alert")).toHaveTextContent("Read failed");
  expect(screen.getByRole("button", { name: "Refresh runs" })).toBeEnabled();
});
