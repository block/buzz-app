import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

// sha256(absolute worktree root) -> 40000 + digest % 25000, so the result lies
// in [40000, 64999]. The dev port space is partitioned between the two Buzz
// repositories: block/buzz hashes the same input into [10000, 39999] for all
// three of its ports (base, HMR = base + 1 and `just web` = base + 100), and
// buzz-app owns [40000, 64999], so a buzz and a buzz-app dev server can never
// collide, even when their worktrees share a branch or workspace name.
// Hashing the path rather than the branch keeps the port, and with it Tauri's
// config and Cargo's warm build, stable across branch switches inside a worktree.
export function portForPath(path) {
  const digest = createHash("sha256").update(path, "utf8").digest("hex");
  return Number(40000n + (BigInt(`0x${digest}`) % 25000n));
}

// The worktree root reported by Git; outside a checkout, the directory itself.
// A missing git or a plain directory is an ordinary outcome, not an exception,
// so this reads spawnSync's exit status rather than catching a throw.
export function worktreePort(dir) {
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return portForPath(git.status === 0 ? git.stdout.trim() : resolve(dir));
}
