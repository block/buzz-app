// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentAvatarPicker } from "./AgentAvatarPicker";
import { agentAvatars } from "../../features/agents/avatar-packs";
afterEach(cleanup);
it("offers all three bundled collections and uses portable HTTPS pictures", () => {
  const onChange = vi.fn();
  const view = render(
    <AgentAvatarPicker disabled={false} onChange={onChange} />,
  );
  expect(screen.getAllByRole("button", { name: /^Gloopies \d/ })).toHaveLength(
    23,
  );
  fireEvent.click(screen.getByRole("button", { name: "Figgies" }));
  expect(screen.getAllByRole("button", { name: /^Figgies \d/ })).toHaveLength(
    7,
  );
  fireEvent.click(screen.getByRole("button", { name: "Figgies 2" }));
  const picture = agentAvatars.find((avatar) => avatar.id === "pollies-2")?.url;
  expect(onChange).toHaveBeenLastCalledWith(picture);
  view.rerender(
    <AgentAvatarPicker value={picture} disabled={false} onChange={onChange} />,
  );
  expect(screen.getByRole("button", { name: "Figgies 2" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Fuzzies" }));
  expect(screen.getAllByRole("button", { name: /^Fuzzies \d/ })).toHaveLength(
    19,
  );
  expect(screen.getByRole("button", { name: "Use image" })).toBeVisible();
  expect(screen.queryByText("Avatar")).toBeNull();
});
it("disables avatar changes while saving", () => {
  render(<AgentAvatarPicker disabled onChange={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Gloopies 1" })).toBeDisabled();
});
