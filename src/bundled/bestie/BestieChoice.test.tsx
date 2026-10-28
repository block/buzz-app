// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { BestieChoice } from "./BestieChoice";
import type { BestieAgent } from "./state";

afterEach(cleanup);

const pollen: BestieAgent = {
  pubkey: "b".repeat(64),
  name: "Pollen",
  managed: false,
};
const fizz: BestieAgent = {
  pubkey: "c".repeat(64),
  name: "Fizz",
  managed: false,
};
const open = async (
  props: Partial<Parameters<typeof BestieChoice>[0]> = {},
) => {
  const onChoose = vi.fn();
  const user = userEvent.setup();
  render(
    <StrictMode>
      <BestieChoice
        agents={[pollen, fizz]}
        trigger={<Button>Choose your bestie</Button>}
        onChoose={onChoose}
        {...props}
      />
    </StrictMode>,
  );
  await user.click(screen.getByRole("button", { name: /bestie/ }));
  return { user, onChoose };
};

test("the first pick takes effect without a confirmation", async () => {
  const { user, onChoose } = await open();
  // Keyboard and pointer share the one selection owner.
  await user.keyboard("{ArrowDown}{Enter}");
  expect(onChoose).toHaveBeenCalledWith(pollen);
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});

test("a community with no agents says so instead of showing an empty list", async () => {
  await open({ agents: [] });
  expect(
    await screen.findByText("No agents to choose from in this community."),
  ).toBeInTheDocument();
  expect(screen.queryByRole("menuitemradio")).not.toBeInTheDocument();
});
