// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarActiveDialog } from "./SidebarActiveDialog";

afterEach(cleanup);

it("starts with the saved window and cancels without writing", async () => {
  const apply = vi.fn(),
    close = vi.fn();
  render(
    <SidebarActiveDialog
      seconds={14 * 86400}
      apply={apply}
      close={close}
      finalFocus={{ current: null }}
    />,
  );
  expect(screen.getByRole("spinbutton", { name: "Days" })).toHaveValue(14);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledOnce();
  expect(apply).not.toHaveBeenCalled();
});

it("rejects an invalid draft inline without writing", async () => {
  const user = userEvent.setup();
  const apply = vi.fn();
  render(
    <SidebarActiveDialog
      apply={apply}
      close={vi.fn()}
      finalFocus={{ current: null }}
    />,
  );
  const days = screen.getByRole("spinbutton", { name: "Days" });
  await user.clear(days);
  await user.type(days, "0");
  await user.click(screen.getByRole("button", { name: "Apply" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Enter a whole number of days from 1 to 365.",
  );
  expect(apply).not.toHaveBeenCalled();
});

it("keeps the draft after a failed save and prevents closing while saving", async () => {
  const user = userEvent.setup();
  let reject!: (error: Error) => void;
  const gate = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const apply = vi
    .fn()
    .mockImplementationOnce(() => gate)
    .mockResolvedValue(undefined);
  const close = vi.fn();
  render(
    <SidebarActiveDialog
      apply={apply}
      close={close}
      finalFocus={{ current: null }}
    />,
  );
  const days = screen.getByRole("spinbutton", { name: "Days" });
  await user.clear(days);
  await user.type(days, "45");
  await user.click(screen.getByRole("button", { name: "Apply" }));
  expect(apply).toHaveBeenCalledExactlyOnceWith(45 * 86400);
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(close).not.toHaveBeenCalled();
  await act(async () => reject(new Error("Duration not confirmed")));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Duration not confirmed",
  );
  expect(days).toHaveValue(45);
  await user.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(apply).toHaveBeenLastCalledWith(45 * 86400);
});
