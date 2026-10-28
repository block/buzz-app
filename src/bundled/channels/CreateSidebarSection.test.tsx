// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { CreateSidebarSection } from "./CreateSidebarSection";

afterEach(cleanup);

it("keeps a gated draft editable and submits its edited name with a fresh identity", async () => {
  const user = userEvent.setup();
  const create = vi.fn().mockReturnValue(false);
  const retry = vi.fn().mockResolvedValue(undefined);
  const props = {
    channelName: "Beta",
    create,
    close: vi.fn(),
    writable: true,
    refreshing: false,
    retry,
  };
  const view = render(<CreateSidebarSection {...props} />);
  const input = screen.getByRole("textbox", { name: "Section name" });
  expect(
    screen.getByRole("dialog", { name: "Move to new section" }),
  ).not.toHaveAccessibleDescription();
  await waitFor(() => expect(input).toHaveFocus());
  expect(input).toHaveAttribute("placeholder", "Section name");
  fireEvent.change(input, { target: { value: " Launch " } });
  const form = input.closest("form");
  if (!form) throw new Error("Create form missing");
  const submit = () => fireEvent.submit(form);
  await submit();
  expect(create).toHaveBeenCalledWith({
    id: expect.any(String),
    name: "Launch",
  });
  expect(input).toHaveValue(" Launch ");
  await waitFor(() => expect(input).not.toHaveAttribute("readonly"));
  await user.clear(input);
  await user.type(input, "Release");
  expect(input).toHaveValue("Release");
  view.rerender(<CreateSidebarSection {...props} writable={false} />);
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Retry preferences"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry preferences" }));
  expect(retry).toHaveBeenCalledTimes(1);
  view.rerender(
    <CreateSidebarSection {...props} writable={false} refreshing />,
  );
  expect(
    screen.getByRole("button", { name: "Retry preferences" }),
  ).toBeDisabled();
  view.rerender(<CreateSidebarSection {...props} writable={false} />);
  expect(input).toHaveValue("Release");
  create.mockReturnValue(true);
  view.rerender(<CreateSidebarSection {...props} writable />);
  expect(screen.queryByRole("alert")).toBeNull();
  await submit();
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1]?.[0]).toEqual({
    id: expect.any(String),
    name: "Release",
  });
  expect(create.mock.calls[1]?.[0].id).not.toBe(create.mock.calls[0]?.[0].id);
  await submit();
  expect(create).toHaveBeenCalledTimes(2);
});

it("keeps the submitted name and identity through a failed save, blocking dismissal while pending", async () => {
  const user = userEvent.setup();
  let reject!: (cause: Error) => void;
  const create = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((_, no) => {
          reject = no;
        }),
    )
    .mockResolvedValue(true);
  const close = vi.fn();
  render(
    <CreateSidebarSection
      create={create}
      close={close}
      writable
      refreshing={false}
      retry={vi.fn()}
    />,
  );
  const input = screen.getByRole("textbox", { name: "Section name" });
  expect(
    screen.getByRole("dialog", { name: "Create new section" }),
  ).toBeInTheDocument();
  await waitFor(() => expect(input).toHaveFocus());
  fireEvent.change(input, { target: { value: " Launch " } });
  const submit = screen.getByRole("button", { name: "Create" });
  fireEvent.click(submit);
  expect(input).toHaveAttribute("readonly");
  expect(input).toBeEnabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  const form = input.closest("form");
  if (!form) throw new Error("Create form missing");
  fireEvent.submit(form);
  expect(create).toHaveBeenCalledTimes(1);
  reject(new Error("Could not confirm section"));
  await screen.findByRole("alert");
  // The write may already have reached the relay. Editing before retry must
  // not pair the retained ID with a different name.
  await user.type(input, "es");
  expect(input).toHaveValue(" Launch ");
  expect(input).toHaveAttribute("readonly");
  expect(input).toBeEnabled();
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(submit);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled(),
  );
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
});
