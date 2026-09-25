// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CreateSidebarSection } from "./CreateSidebarSection";

afterEach(cleanup);

it("retains a rejected draft and its identity through preference recovery", () => {
  const create = vi.fn().mockReturnValue(false);
  const retry = vi.fn().mockResolvedValue(undefined);
  const props = {
    channelName: "Beta",
    create,
    close: vi.fn(),
    writable: false,
    refreshing: false,
    retry,
  };
  const view = render(<CreateSidebarSection {...props} />);
  const input = screen.getByRole("textbox", { name: "Section name" });
  fireEvent.change(input, { target: { value: " Launch " } });
  const form = input.closest("form");
  if (!form) throw new Error("Create form missing");
  const submit = () => fireEvent.submit(form);
  submit();
  expect(create).toHaveBeenCalledWith({
    id: expect.any(String),
    name: "Launch",
  });
  expect(input).toHaveValue(" Launch ");
  expect(screen.getByRole("alert")).toHaveTextContent("Retry preferences");
  fireEvent.click(screen.getByRole("button", { name: "Retry preferences" }));
  expect(retry).toHaveBeenCalledTimes(1);
  view.rerender(<CreateSidebarSection {...props} refreshing />);
  expect(
    screen.getByRole("button", { name: "Retry preferences" }),
  ).toBeDisabled();
  view.rerender(<CreateSidebarSection {...props} />);
  expect(input).toHaveValue(" Launch ");
  create.mockReturnValue(true);
  view.rerender(<CreateSidebarSection {...props} writable />);
  expect(screen.queryByRole("alert")).toBeNull();
  submit();
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
  submit();
  expect(create).toHaveBeenCalledTimes(2);
});
