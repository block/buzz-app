import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { stageLocalGoose } from "./build-goose-acp.mjs";

const script = fileURLToPath(new URL("./build-goose-acp.mjs", import.meta.url));
const local = "/usr/bin/true";
// Staging takes a target; these tests need no Rust toolchain discovery.
// Keep the native macOS library check active for the real fixture executable.
const triple =
  process.platform === "darwin"
    ? "aarch64-apple-darwin"
    : "x86_64-unknown-linux-gnu";
const sha256 = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const roots = [];
const root = () => {
  const directory = mkdtempSync(join(tmpdir(), "goose-acp-bin-"));
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it.runIf(process.platform !== "win32")(
  "stages a local goose-acp's exact bytes for development",
  () => {
    const directory = root();
    stageLocalGoose(directory, local, triple);
    expect(sha256(join(directory, "src-tauri/resources/bin/goose-acp"))).toBe(
      sha256(local),
    );
  },
);

it("refuses a relative or missing GOOSE_ACP_BIN", () => {
  expect(() => stageLocalGoose(root(), "goose-acp", triple)).toThrow(
    /absolute path/,
  );
  expect(() =>
    stageLocalGoose(root(), "/nonexistent/goose-acp", triple),
  ).toThrow();
});

it("refuses GOOSE_ACP_BIN outside development runs", () => {
  const result = spawnSync(process.execPath, [script], {
    env: {
      ...process.env,
      GOOSE_ACP_BIN: local,
      TAURI_ENV_TARGET_TRIPLE: triple,
    },
    encoding: "utf8",
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/GOOSE_ACP_BIN is for development only/);
});
