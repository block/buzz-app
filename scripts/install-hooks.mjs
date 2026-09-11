import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const config = (key) => {
  const result = spawnSync("git", ["config", "--get", key], {
    encoding: "utf8",
  });
  if (result.status === 1) return "";
  if (result.status !== 0)
    throw new Error(result.stderr || `Cannot read ${key}`);
  return result.stdout.trim();
};
process.chdir(git("rev-parse", "--show-toplevel"));
const existing = config("core.hooksPath");
if (existing && existing !== ".githooks")
  throw new Error(
    `Existing core.hooksPath (${existing}); reconcile it before installing.`,
  );
if (!existing) {
  const hooks = git("rev-parse", "--git-path", "hooks");
  const custom = existsSync(hooks)
    ? readdirSync(hooks).filter((name) => !name.endsWith(".sample"))
    : [];
  if (custom.length)
    throw new Error(
      `Existing hooks (${custom.join(", ")}); reconcile them before installing.`,
    );
}
// Worktree-specific hooks must not replace a sibling checkout's workflow.
// Git requires special migration for explicit core.worktree/bare repositories.
if (config("core.worktree") || config("core.bare") === "true")
  throw new Error(
    "Nonstandard worktree configuration; install hooks manually.",
  );
execFileSync(resolve("bin/lefthook"), ["validate"], { stdio: "inherit" });
git("config", "--local", "extensions.worktreeConfig", "true");
git("config", "--worktree", "core.hooksPath", ".githooks");
console.log(
  "Installed Lefthook pre-commit and pre-push for this worktree only.",
);
