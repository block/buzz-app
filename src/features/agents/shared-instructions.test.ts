import { expect, it } from "vitest";
import { localStore } from "./store";
import { memoryStorage } from "./test-fakes";
import {
  saveSharedInstructions,
  readSharedInstructions,
} from "./shared-instructions";
const owner = "a".repeat(64);
it("keeps the 16 KiB UTF-8 limit, including multibyte instructions", async () => {
  const storage = localStore(memoryStorage());
  await saveSharedInstructions(storage, owner, "é".repeat(8192));
  await expect(
    saveSharedInstructions(storage, owner, "é".repeat(8193)),
  ).rejects.toThrow("16 KB");
  expect(readSharedInstructions(storage, owner)).toBe("é".repeat(8192));
});
