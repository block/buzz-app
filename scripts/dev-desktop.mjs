import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export function worktreeLabel(cwd) {
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    if (
      git("rev-parse", "--path-format=absolute", "--git-dir") ===
      git("rev-parse", "--path-format=absolute", "--git-common-dir")
    )
      return null;
    const branch = git("branch", "--show-current");
    return branch
      ? branch.split("/").at(-1)
      : basename(git("rev-parse", "--show-toplevel"));
  } catch {
    return null;
  }
}

export function desktopArgs({
  cwd = root,
  platform = process.platform,
  run = spawnSync,
  warn = console.warn,
} = {}) {
  const args = ["tauri", "dev"];
  if (platform !== "darwin") return args;
  const label = worktreeLabel(cwd);
  if (!label) return args;
  try {
    const icon = resolve(cwd, "src-tauri/target/dev-icons/icon.icns");
    mkdirSync(resolve(cwd, "src-tauri/target/dev-icons"), { recursive: true });
    const result = run(
      "swift",
      [
        resolve(cwd, "scripts/generate-dev-icon.swift"),
        resolve(cwd, "src-tauri/icons/icon.icns"),
        icon,
        label,
      ],
      { cwd, stdio: "inherit" },
    );
    if (result.error || result.status !== 0)
      throw result.error ?? new Error("Icon generator failed");
    args.push("--config", JSON.stringify({ bundle: { icon: [icon] } }));
  } catch {
    warn("Worktree icon could not be generated; using the ordinary Buzz icon.");
  }
  return args;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = spawnSync(
    resolve(root, "bin/pnpm"),
    [...desktopArgs(), ...process.argv.slice(2)],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
