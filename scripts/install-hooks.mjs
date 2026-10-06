import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const config = (key, ...scope) => {
  const result = spawnSync("git", ["config", ...scope, "--get", key], {
    encoding: "utf8",
  });
  if (result.status === 1) return "";
  if (result.status !== 0)
    throw new Error(result.stderr || `Cannot read ${key}`);
  return result.stdout.trim();
};
process.chdir(git("rev-parse", "--show-toplevel"));
// Refuse different hooks paths in this clone or its worktree config. Global and
// system settings are intentionally ignored because this install replaces them.
const shared = config("core.hooksPath", "--local");
const worktreeConfig =
  config("extensions.worktreeConfig", "--local", "--type=bool") === "true";
const worktree = worktreeConfig ? config("core.hooksPath", "--worktree") : "";
for (const value of [shared, worktree])
  if (value && value !== ".githooks")
    throw new Error(
      `Existing core.hooksPath (${value}); reconcile it before installing.`,
    );
if (!shared) {
  // The clone's default hooks directory, whatever this worktree overrides.
  const hooks = join(resolve(git("rev-parse", "--git-common-dir")), "hooks");
  const custom = existsSync(hooks)
    ? readdirSync(hooks).filter((name) => !name.endsWith(".sample"))
    : [];
  if (custom.length)
    throw new Error(
      `Existing hooks (${custom.join(", ")}); reconcile them before installing.`,
    );
}
// Git requires special migration for explicit core.worktree/bare repositories.
if (config("core.worktree") || config("core.bare") === "true")
  throw new Error(
    "Nonstandard worktree configuration; install hooks manually.",
  );
execFileSync(resolve("bin/lefthook"), ["validate"], { stdio: "inherit" });
// One clone-wide setting covers every worktree: Git resolves the relative path
// from each worktree's root, so each runs its own branch's tracked .githooks.
// Explicit per-worktree settings, including earlier installs, stay in place.
git("config", "--local", "core.hooksPath", ".githooks");
console.log(
  "Installed Lefthook pre-commit and pre-push for every worktree of this clone.",
);
