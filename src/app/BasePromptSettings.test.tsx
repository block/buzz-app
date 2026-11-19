// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { BasePromptSettings } from "./BasePromptSettings";
import {
  BASE_PROMPT,
  basePromptFor,
} from "../features/agent-harness/base-prompt";
import {
  basePromptPreference,
  setBasePromptPreference,
} from "../features/agent-harness/base-prompt-preference";
import { systemPrompt } from "../bundled/claude-code/prompt";
import { developerInstructions } from "../bundled/codex/prompt";

// Exercise the form and shared assembly, not a substitute prompt renderer.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});
async function open() {
  const user = userEvent.setup();
  render(<BasePromptSettings />);
  await user.click(
    screen.getByRole("button", { name: "Base prompt", expanded: false }),
  );
  return user;
}
function replacement() {
  return screen.getByRole("textbox", { name: "Base prompt replacement" });
}

it("shows the immutable original and a live visual diff, then saves a replacement used by shared harnesses", async () => {
  const user = await open();
  const original = screen.getByRole("textbox", { name: "Bundled original" });
  expect(original).toHaveValue(BASE_PROMPT);
  expect(original).toHaveAttribute("readonly");
  expect(
    screen.getByRole("button", { name: "Save base prompt" }),
  ).toBeDisabled();
  const edited = BASE_PROMPT.split("\n")
    .filter((line) => !line.includes("Co-authored-by"))
    .join("\n");
  fireEvent.change(replacement(), { target: { value: edited } });
  expect(
    screen
      .getByRole("region", { name: "Base prompt diff" })
      .querySelector(".diff-code-delete"),
  ).not.toBeNull();
  expect(basePromptFor()).toBe(BASE_PROMPT);
  await user.click(screen.getByRole("button", { name: "Save base prompt" }));
  expect(basePromptFor()).toBe(edited);
  expect(original).toHaveValue(BASE_PROMPT);
  const shared = systemPrompt({ scope: "thread", cwd: "/work" });
  expect(shared).not.toContain("Co-authored-by");
  expect(
    developerInstructions({ name: "Example", pubkey: "a".repeat(64) }),
  ).not.toContain("Co-authored-by");
  expect(screen.getByRole("status")).toHaveTextContent(
    "Custom base prompt saved",
  );
  cleanup();
  await open();
  expect(replacement()).toHaveValue(edited);
});

it("accepts an empty replacement, including a conversation-specific workspace, and restores the default", async () => {
  const user = await open();
  fireEvent.change(replacement(), { target: { value: "" } });
  await user.click(screen.getByRole("button", { name: "Save base prompt" }));
  expect(basePromptPreference()).toBe("");
  expect(basePromptFor("/workspace")).toBe("");
  expect(systemPrompt({ scope: "thread", cwd: "/work" })).not.toContain(
    BASE_PROMPT,
  );
  await user.click(
    screen.getByRole("button", { name: "Restore bundled default" }),
  );
  expect(basePromptPreference()).toBeNull();
  expect(basePromptFor()).toBe(BASE_PROMPT);
  expect(basePromptFor("/workspace")).toContain(
    "Your persistent workspace is at `/workspace`",
  );
  expect(replacement()).toHaveValue(BASE_PROMPT);
});

it("keeps draft and active prompt unchanged on save/reset failure and supports retry", async () => {
  setBasePromptPreference("Saved original");
  const user = await open();
  fireEvent.change(replacement(), { target: { value: "My replacement" } });
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("full");
    });
  await user.click(screen.getByRole("button", { name: "Save base prompt" }));
  expect(screen.getByRole("alert")).toHaveTextContent("wasn’t saved");
  expect(replacement()).toHaveValue("My replacement");
  expect(basePromptFor()).toBe("Saved original");
  write.mockRestore();
  await user.click(screen.getByRole("button", { name: "Save base prompt" }));
  expect(basePromptFor()).toBe("My replacement");
  const remove = vi
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementation(() => {
      throw new Error("unavailable");
    });
  await user.click(
    screen.getByRole("button", { name: "Restore bundled default" }),
  );
  expect(basePromptFor()).toBe("My replacement");
  expect(screen.getByRole("alert")).toHaveTextContent("wasn’t saved");
  remove.mockRestore();
  await user.click(
    screen.getByRole("button", { name: "Restore bundled default" }),
  );
  expect(basePromptFor()).toBe(BASE_PROMPT);
});

it("does not overwrite a dirty draft or another window's saved replacement", async () => {
  const user = await open();
  fireEvent.change(replacement(), { target: { value: "Unsaved draft" } });
  act(() => {
    localStorage.setItem("buzz-agent-base-prompt.v1", "Other window");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "buzz-agent-base-prompt.v1" }),
    );
  });
  expect(replacement()).toHaveValue("Unsaved draft");
  expect(
    screen.getByRole("button", { name: "Save base prompt" }),
  ).toBeDisabled();
  expect(basePromptFor()).toBe("Other window");
  await user.click(screen.getByRole("button", { name: "Load saved prompt" }));
  expect(replacement()).toHaveValue("Other window");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("uses custom workspace guidance verbatim rather than partially rewriting an alternative", () => {
  const custom = `${BASE_PROMPT}\nUse my own workspace policy.`;
  setBasePromptPreference(custom);
  expect(basePromptFor("/conversation-workspace")).toBe(custom);
});

it("falls back to the bundled prompt if storage cannot be read", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  expect(basePromptFor()).toBe(BASE_PROMPT);
});
