import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, join } from "node:path";

// Keep optional macOS artwork out of the shared launcher's argument handling.
export function worktreeIcon(cwd, platform = process.platform) {
  if (platform !== "darwin") return null;
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  let label;
  try {
    if (
      git("rev-parse", "--path-format=absolute", "--git-dir") ===
      git("rev-parse", "--path-format=absolute", "--git-common-dir")
    )
      return null;
    const branch = git("branch", "--show-current");
    label = branch
      ? branch.split("/").at(-1)
      : basename(git("rev-parse", "--show-toplevel"));
  } catch {
    return null;
  }

  let temporary;
  try {
    const directory = join(cwd, "src-tauri/target/dev-icons");
    mkdirSync(directory, { recursive: true });
    temporary = mkdtempSync(join(directory, "staging-"));
    const output = join(temporary, "icon.icns");
    const result = spawnSync(
      "swift",
      [
        join(cwd, "scripts/generate-dev-icon.swift"),
        join(cwd, "src-tauri/icons/icon.icns"),
        output,
        label,
      ],
      { cwd, stdio: "inherit" },
    );
    if (result.error || result.status !== 0)
      throw result.error ?? new Error("Icon generator failed");
    // Tauri caches the embedded bytes, not the source icon's modification time.
    // A content-keyed path changes TAURI_CONFIG and invalidates warm Cargo builds.
    const digest = createHash("sha256")
      .update(readFileSync(output))
      .digest("hex");
    const icon = join(directory, `${digest}.icns`);
    renameSync(output, icon);
    return icon;
  } catch {
    console.warn(
      "Worktree icon could not be generated; using the ordinary Buzz icon.",
    );
    return null;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
