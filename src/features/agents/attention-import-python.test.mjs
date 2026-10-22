import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("reads real legacy registration files and archives only the acknowledged snapshot", async () => {
  const { stdout } = await promisify(execFile)("python3", [
    fileURLToPath(new URL("./attention-import.test.py", import.meta.url)),
  ]);
  expect(stdout).toContain("archive passed");
});
