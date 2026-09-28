// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { createAgentControl, savedMessage } from "../features/agents/control";
import { controlFixture } from "../features/agents/control-testing";
import { AgentDefaultsCard } from "./AgentDefaultsCard";
import { useSyncExternalStore } from "react";

const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
});

function setup(restarted = 0) {
  const fixture = controlFixture();
  fixture.data.defaultSettings = {
    harness: "buzz-agent",
    provider: "databricks_v2",
    model: "old-model",
    effort: "high",
    environmentKeys: ["SAVED_TOKEN"],
  };
  const saveDefaults = fixture.host.saveDefaults;
  if (!saveDefaults) throw Error("Missing fixture");
  fixture.host.saveDefaults = async (edit) => ({
    ...(await saveDefaults(edit)),
    restarted,
  });
  const control = createAgentControl(fixture.host);
  disposals.push(() => control.dispose());
  function Card() {
    const state = useSyncExternalStore(control.subscribe, control.snapshot);
    return <AgentDefaultsCard control={control} state={state} />;
  }
  render(<Card />);
  return { fixture, control };
}

it("words save results by restart count", () => {
  expect(savedMessage(0)).toBe("Saved.");
  expect(savedMessage(undefined)).toBe("Saved.");
  expect(savedMessage(1)).toBe("Saved. Restarted 1 agent.");
  expect(savedMessage(3)).toBe("Saved. Restarted 3 agents.");
});

it("changing the default harness clears model and effort and saves write-only env", async () => {
  const user = userEvent.setup();
  const { fixture, control } = setup(2);
  await control.refresh();
  const card = await screen.findByRole("region", { name: "Agent defaults" });
  expect(within(card).getByLabelText("Default model")).toHaveValue("old-model");
  // Saved environment values are never shown; only the key and its state.
  expect(within(card).getByText("SAVED_TOKEN")).toBeVisible();
  expect(card).not.toHaveTextContent("secret");
  await user.click(
    within(card).getByRole("combobox", { name: "Default harness" }),
  );
  await user.click(await screen.findByRole("option", { name: "Goose" }));
  expect(within(card).getByLabelText("Default model")).toHaveValue("");
  expect(within(card).getByLabelText("Default effort")).toHaveValue("");
  await user.type(within(card).getByLabelText("Name"), "NEW_KEY");
  await user.type(within(card).getByLabelText("Value"), "secret-value");
  await user.click(within(card).getByRole("button", { name: "Add variable" }));
  await user.click(
    within(card).getByRole("button", { name: "Remove SAVED_TOKEN" }),
  );
  await user.click(within(card).getByRole("button", { name: "Save defaults" }));
  expect(
    await within(card).findByText("Saved. Restarted 2 agents."),
  ).toBeVisible();
  expect(fixture.calls.find((c) => c.action === "saveDefaults")).toEqual({
    action: "saveDefaults",
    payload: {
      edit: {
        harness: "goose",
        provider: "databricks_v2",
        model: "",
        effort: "",
        environment: { NEW_KEY: "secret-value", SAVED_TOKEN: null },
      },
    },
  });
  expect(within(card).getByText("NEW_KEY")).toBeVisible();
  expect(within(card).queryByText("SAVED_TOKEN")).toBeNull();
  expect(card).not.toHaveTextContent("secret-value");
});
