import { expect, it, vi } from "vitest";
import { localStore } from "./store";
import { memoryStorage } from "./test-fakes";
import { isAgentKey } from "./state";
import { basePrompt, BASE_PROMPT } from "../agent-harness/base-prompt";
import {
  settledSharedInstructions,
  readSharedInstructions,
  saveSharedInstructions,
  SHARED_INSTRUCTIONS_PREFIX,
} from "./shared-instructions";

const owner = "a".repeat(64);
it("defaults to the bundled base, persists by owner across communities, and clears only the shared section", async () => {
  const storage = localStore(memoryStorage());
  expect(basePrompt(readSharedInstructions(storage, owner))).toBe(BASE_PROMPT);
  await saveSharedInstructions(storage, owner, "  Prefer short answers.  ");
  expect(readSharedInstructions(storage, owner)).toBe("Prefer short answers.");
  expect(readSharedInstructions(storage, "b".repeat(64))).toBe("");
  expect(basePrompt(readSharedInstructions(storage, owner))).toContain(
    "<owner-instructions>\nPrefer short answers.\n</owner-instructions>",
  );
  expect(isAgentKey(`${SHARED_INSTRUCTIONS_PREFIX}${owner}`)).toBe(true);
  await saveSharedInstructions(storage, owner, "");
  expect(basePrompt(readSharedInstructions(storage, owner))).toBe(BASE_PROMPT);
});

it("reports a refused save instead of claiming persistence", async () => {
  const storage = {
    ...localStore(memoryStorage()),
    set: vi.fn(async () => {
      throw new Error("disk full");
    }),
  };
  await expect(
    saveSharedInstructions(storage, owner, "Keep this draft."),
  ).rejects.toThrow("disk full");
  expect(readSharedInstructions(storage, owner)).toBe("");
});

it("keeps the 16 KiB UTF-8 limit, including multibyte instructions", async () => {
  const storage = localStore(memoryStorage());
  await saveSharedInstructions(storage, owner, "é".repeat(8192));
  await expect(
    saveSharedInstructions(storage, owner, "é".repeat(8193)),
  ).rejects.toThrow("16 KB");
  expect(readSharedInstructions(storage, owner)).toBe("é".repeat(8192));
});

it("only adopts successful persistence and skips reads when already canceled", async () => {
  const storage = {
    ...localStore(memoryStorage()),
    read: vi.fn(async () => "Committed."),
  };
  const abort = new AbortController();
  abort.abort(new Error("Canceled"));
  await expect(
    settledSharedInstructions(storage, owner, abort.signal),
  ).rejects.toThrow("Canceled");
  expect(storage.read).not.toHaveBeenCalled();
  await expect(
    settledSharedInstructions(storage, owner, new AbortController().signal),
  ).resolves.toBe("Committed.");
});
