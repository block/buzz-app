// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  act,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GitHubPolicyEditor } from "./GitHubPolicyEditor";

afterEach(cleanup);
const empty = {
  version: 1 as const,
  trustedOrganizations: [],
  trustedAuthors: [],
  ignoredAuthors: [],
};
it("saves the shared policy shape, preserving exact user-specified bot and author logins", async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <GitHubPolicyEditor
      initialValue={empty}
      onSave={onSave}
      onClose={vi.fn()}
    />,
  );
  for (const input of screen.getAllByRole("textbox")) {
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("autocapitalize", "none");
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(input).toHaveAttribute("autocomplete", "off");
  }
  fireEvent.change(
    screen.getByRole("textbox", { name: "Trusted organizations" }),
    { target: { value: "example-org\n" } },
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Trusted commenters" }),
    { target: { value: "trusted-bot[bot]\nReviewer" } },
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Ignored commenters" }),
    { target: { value: "ignored-user" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  expect(onSave).toHaveBeenCalledWith({
    version: 1,
    trustedOrganizations: ["example-org"],
    trustedAuthors: ["trusted-bot[bot]", "Reviewer"],
    ignoredAuthors: ["ignored-user"],
  });
});
it("allows an empty policy for CI and PR-state monitoring", async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <GitHubPolicyEditor
      initialValue={{ ...empty, trustedAuthors: ["reviewer"] }}
      onSave={onSave}
      onClose={vi.fn()}
    />,
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Trusted commenters" }),
    { target: { value: "" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(empty));
});
it("disables changes during a save and retains the draft after a rejected write", async () => {
  let reject = (_reason: Error) => {};
  const held = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const onSave = vi.fn().mockReturnValueOnce(held).mockResolvedValue(undefined);
  render(
    <GitHubPolicyEditor
      initialValue={empty}
      onSave={onSave}
      onClose={vi.fn()}
    />,
  );
  const authors = screen.getByRole("textbox", { name: "Trusted commenters" });
  fireEvent.change(authors, { target: { value: "reviewer" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(authors).toBeDisabled());
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await act(async () => reject(new Error("File changed externally")));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "File changed externally",
  );
  expect(authors).toHaveValue("reviewer");
  expect(authors).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
});

it("disables unchanged saves and cancels without writing", () => {
  const onSave = vi.fn();
  const onClose = vi.fn();
  render(
    <GitHubPolicyEditor
      initialValue={empty}
      onSave={onSave}
      onClose={onClose}
    />,
  );
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  fireEvent.change(
    screen.getByRole("textbox", { name: "Trusted commenters" }),
    { target: { value: "reviewer" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(onSave).not.toHaveBeenCalled();
});
