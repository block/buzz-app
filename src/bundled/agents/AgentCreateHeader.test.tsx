// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRef } from "react";
import type { InstructionEditingActions } from "./AgentInstructions";
import { AgentCreateHeader } from "./AgentCreateHeader";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("keeps the name under the avatar and expands choices only on request", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const onChange = vi.fn();
  const editing = createRef<InstructionEditingActions>();
  render(
    <AgentCreateHeader
      instructionEditingRef={editing}
      instructions="Existing instructions"
      name="Helper"
      disabled={false}
      onChange={onChange}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Helper");
  fireEvent.click(screen.getByRole("button", { name: "Agent instructions" }));
  fireEvent.click(screen.getByRole("button", { name: "Text" }));
  expect(screen.getByLabelText("Agent instructions")).toHaveValue(
    "Existing instructions",
  );
  expect(
    screen
      .getByLabelText("Agent instructions")
      .closest(".agent-create-identity"),
  ).not.toBeNull();
  act(() => editing.current?.done());
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Helper");
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "New name" },
  });
  expect(onChange).toHaveBeenLastCalledWith({ name: "New name" });
  expect(screen.queryByRole("button", { name: "Gloopies 1" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Choose avatar" }));
  fireEvent.click(await screen.findByRole("button", { name: /Gloopies$/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Gloopies 1" }));
  expect(onChange).toHaveBeenLastCalledWith({
    picture: expect.stringMatching(/^https:/),
  });
  expect(screen.getByRole("button", { name: "Choose avatar" })).toHaveFocus();
  expect(
    screen
      .getByRole("button", { name: "Choose avatar" })
      .closest("[data-avatar-view]"),
  ).toHaveAttribute("data-avatar-view", "selected");
});
