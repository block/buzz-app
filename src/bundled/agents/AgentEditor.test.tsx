// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { agentDraft } from "./agent-edit";
import { AgentEditor } from "./AgentEditor";

afterEach(cleanup);

it("reviews a requested model update before saving it", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const state = control.snapshot();
  const onSaved = vi.fn();
  render(
    <AgentEditor
      agent={fixture.agent}
      control={control}
      state={state}
      initialDraft={{ ...agentDraft(fixture.agent), model: "gpt-6-sol" }}
      notice="Requested by an agent. Review every field before saving."
      onClose={() => {}}
      onSaved={onSaved}
    />,
  );

  expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue(
    "gpt-6-sol",
  );
  expect(screen.getByText(/Requested by an agent/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() =>
    expect(fixture.calls.at(-1)).toMatchObject({
      action: "save",
      payload: { edit: { harness: { model: "gpt-6-sol" } } },
    }),
  );
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  control.dispose();
});

it("keeps a requested update open with its edits when save fails", async () => {
  const fixture = controlFixture();
  fixture.failSave(true);
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const onSaved = vi.fn();
  render(
    <AgentEditor
      agent={fixture.agent}
      control={control}
      state={control.snapshot()}
      initialDraft={{ ...agentDraft(fixture.agent), model: "gpt-6-sol" }}
      notice="Requested by an agent. Review every field before saving."
      onClose={() => {}}
      onSaved={onSaved}
    />,
  );

  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The host could not save settings.",
  );
  expect(onSaved).not.toHaveBeenCalled();
  expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue(
    "gpt-6-sol",
  );
  control.dispose();
});
