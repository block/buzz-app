// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SharedInstructionsSettings } from "./SharedInstructionsSettings";
import { readSharedInstructions } from "./shared-instructions";
import { localStore } from "./store";
import { memoryStorage } from "./test-fakes";
import { fileStore } from "./state";

afterEach(cleanup);
const owner = "a".repeat(64);
const ready = () =>
  waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());

it.each(["Save", "Clear"] as const)(
  "keeps reopened %s provisional until pending persistence settles",
  async (action) => {
    const key = `buzz.owner-instructions.v1:${owner}`;
    let release!: () => void;
    let started!: () => void;
    let fail = true;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const native = fileStore(new Map([[key, "Saved original."]]), async () => {
      started();
      await pending;
      if (fail) throw new Error("Write failed.");
    });
    const storage = { ...native, read: vi.fn(native.read) };
    const user = userEvent.setup();
    let view = render(
      <SharedInstructionsSettings owner={owner} storage={storage} />,
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await ready();
      if (action === "Save") {
        await user.clear(screen.getByRole("textbox"));
        await user.type(screen.getByRole("textbox"), "Pending replacement.");
      }
      await user.click(screen.getByRole("button", { name: action }));
      await entered;
      expect(storage.get(key)).toBe(
        action === "Save" ? "Pending replacement." : null,
      );
      const reads = storage.read.mock.calls.length;
      view.unmount();
      view = render(
        <SharedInstructionsSettings owner={owner} storage={storage} />,
      );
      await waitFor(() =>
        expect(storage.read.mock.calls.length).toBeGreaterThan(reads),
      );
      const provisional =
        screen.getByRole<HTMLTextAreaElement>("textbox").disabled;
      await act(async () => release());
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Couldn’t read",
      );
      expect(provisional).toBe(true);
      expect(storage.get(key)).toBe("Saved original.");
      expect(
        screen.queryByText("Shared instructions saved on this device."),
      ).toBeNull();
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
      fail = false;
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByRole("status")).toHaveTextContent(
        "saved on this device",
      );
      expect(storage.get(key)).toBe(
        action === "Save" ? "Pending replacement." : null,
      );
    } finally {
      await act(async () => release());
      view.unmount();
      error.mockRestore();
    }
  },
);

it("adopts a pending write only after the settled read succeeds", async () => {
  const key = `buzz.owner-instructions.v1:${owner}`;
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  const storage = fileStore(new Map([[key, "Original."]]), async () => pending);
  const writing = storage.set(key, "Saved replacement.");
  render(<SharedInstructionsSettings owner={owner} storage={storage} />);
  try {
    expect(screen.getByRole("textbox")).toBeDisabled();
  } finally {
    await act(async () => {
      resolve();
      await writing;
    });
  }
  expect(screen.getByRole("textbox")).toHaveValue("Saved replacement.");
  expect(screen.getByRole("textbox")).toBeEnabled();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("releases the guard while Save continues and restores it if persistence fails", async () => {
  let reject!: (error: Error) => void;
  const saving = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const storage = { ...memoryStorage(), set: vi.fn(() => saving) };
  const onUnsavedChange = vi.fn();
  const user = userEvent.setup();
  render(
    <SharedInstructionsSettings
      owner={owner}
      storage={storage}
      onUnsavedChange={onUnsavedChange}
    />,
  );
  await ready();
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
});

it("releases its dirty signal after Save, Clear, account change and unmount", async () => {
  const storage = memoryStorage();
  const onUnsavedChange = vi.fn();
  const user = userEvent.setup();
  const view = render(
    <SharedInstructionsSettings
      key={owner}
      owner={owner}
      storage={storage}
      onUnsavedChange={onUnsavedChange}
    />,
  );
  await ready();
  await user.type(screen.getByRole("textbox"), "First draft");
  expect(onUnsavedChange).toHaveBeenLastCalledWith(true);
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("status");
  expect(onUnsavedChange).toHaveBeenLastCalledWith(false);
  await user.type(screen.getByRole("textbox"), " edited");
  expect(onUnsavedChange).toHaveBeenLastCalledWith(true);
  await user.click(screen.getByRole("button", { name: "Clear" }));
  expect(onUnsavedChange).toHaveBeenLastCalledWith(false);
  await user.type(screen.getByRole("textbox"), "Another draft");
  const other = "b".repeat(64);
  view.rerender(
    <SharedInstructionsSettings
      key={other}
      owner={other}
      storage={storage}
      onUnsavedChange={onUnsavedChange}
    />,
  );
  expect(onUnsavedChange).toHaveBeenLastCalledWith(false);
  await ready();
  await user.type(screen.getByRole("textbox"), "Other draft");
  expect(onUnsavedChange).toHaveBeenLastCalledWith(true);
  view.unmount();
  expect(onUnsavedChange).toHaveBeenLastCalledWith(false);
});

it("allows Clear to recover an unreadable preference", async () => {
  const base = localStore(memoryStorage());
  const storage = {
    ...base,
    read: vi.fn(base.read).mockImplementationOnce(async () => {
      throw new Error("unreadable");
    }),
  };
  const user = userEvent.setup();
  render(<SharedInstructionsSettings owner={owner} storage={storage} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t read");
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Clear" }));
  expect(await screen.findByRole("status")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("saves and clears instructions without changing another account's draft", async () => {
  const storage = localStore(memoryStorage());
  const user = userEvent.setup();
  const view = render(
    <SharedInstructionsSettings key={owner} owner={owner} storage={storage} />,
  );
  await ready();
  const input = () =>
    screen.getByRole("textbox", { name: "Instructions for your local agents" });
  expect(input()).toHaveValue("");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await user.type(input(), "Prefer short answers.");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "saved on this device",
  );
  expect(readSharedInstructions(storage, owner)).toBe("Prefer short answers.");
  const other = "b".repeat(64);
  view.rerender(
    <SharedInstructionsSettings key={other} owner={other} storage={storage} />,
  );
  await ready();
  expect(input()).toHaveValue("");
  view.rerender(
    <SharedInstructionsSettings key={owner} owner={owner} storage={storage} />,
  );
  await ready();
  expect(input()).toHaveValue("Prefer short answers.");
  await user.click(screen.getByRole("button", { name: "Clear" }));
  expect(input()).toHaveValue("");
  expect(readSharedInstructions(storage, owner)).toBe("");
});

it("preserves a draft and offers retry when saving fails", async () => {
  const base = localStore(memoryStorage());
  const storage = {
    ...base,
    set: vi.fn(base.set).mockRejectedValueOnce(new Error("Try again")),
  };
  const user = userEvent.setup();
  render(<SharedInstructionsSettings owner={owner} storage={storage} />);
  const input = screen.getByRole("textbox");
  await ready();
  await user.type(input, "Keep my draft.");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Try again");
  expect(input).toHaveValue("Keep my draft.");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("status")).toBeVisible();
});

it("leaves an untouched read failure clean and protects subsequent edits", async () => {
  const storage = {
    ...localStore(memoryStorage()),
    read: vi.fn(async () => {
      throw new Error("Unavailable");
    }),
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
  await screen.findByRole("alert");
  await ready();
  expect(onUnsavedChange).not.toHaveBeenCalledWith(true);
  await user.type(screen.getByRole("textbox"), "Keep my draft.");
  expect(onUnsavedChange).toHaveBeenLastCalledWith(true);
  view.unmount();
  expect(onUnsavedChange).toHaveBeenLastCalledWith(false);
});
