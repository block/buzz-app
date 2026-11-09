// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SharedInstructionsSettings } from "./SharedInstructionsSettings";
import { readSharedInstructions } from "./shared-instructions";
import { memoryStorage } from "./test-fakes";

afterEach(cleanup);

it("protects edits after a failed read, releases a pending Save, and restores the guard on failure", async () => {
  const owner = "a".repeat(64);
  let reject!: (error: Error) => void;
  const saving = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const base = memoryStorage();
  const storage = {
    ...base,
    read: vi.fn<typeof base.read>().mockRejectedValue(new Error("Unavailable")),
    set: vi.fn<typeof base.set>(() => saving),
  };
  const onUnsavedChange = vi.fn();
  const user = userEvent.setup();
  const view = render(
    <SharedInstructionsSettings
      owner={owner}
      storage={storage}
      onUnsavedChange={onUnsavedChange}
    />,
  );
  expect(screen.getByRole("textbox")).toBeDisabled();
  await screen.findByRole("alert");
  await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
  expect(onUnsavedChange).not.toHaveBeenCalledWith(true);
  await user.type(screen.getByRole("textbox"), "Pending draft");
  expect(onUnsavedChange).toHaveBeenLastCalledWith(true);
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("textbox")).toBeDisabled();
  expect(onUnsavedChange).toHaveBeenLastCalledWith(false);
  await act(async () => reject(new Error("Persistence failed.")));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Persistence failed",
  );
  expect(onUnsavedChange).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole("textbox")).toHaveValue("Pending draft");
  storage.set.mockImplementation(base.set);
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("status")).toBeVisible();
  expect(readSharedInstructions(storage, owner)).toBe("Pending draft");
  expect(readSharedInstructions(storage, "b".repeat(64))).toBe("");
  expect(onUnsavedChange).toHaveBeenLastCalledWith(false);
  await user.click(screen.getByRole("button", { name: "Clear" }));
  expect(screen.getByRole("textbox")).toHaveValue("");
  expect(readSharedInstructions(storage, owner)).toBe("");
  expect(screen.queryByRole("alert")).toBeNull();
  await user.type(screen.getByRole("textbox"), "Another draft");
  expect(onUnsavedChange).toHaveBeenLastCalledWith(true);
  view.unmount();
  expect(onUnsavedChange).toHaveBeenLastCalledWith(false);
});
