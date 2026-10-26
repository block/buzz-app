import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const directory = fileURLToPath(new URL(".", import.meta.url));
for (const file of readdirSync(directory).filter(
  (name) => name.startsWith("test-") && /\.(sh|py)$/.test(name),
)) {
  it(file, () => {
    expect(() =>
      execFileSync(
        file.endsWith(".py") ? "python3" : "bash",
        [directory + file],
        { timeout: 30000, stdio: "pipe" },
      ),
    ).not.toThrow();
  }, 35000);
}
