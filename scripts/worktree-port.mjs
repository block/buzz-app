import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

// Same derivation as block/buzz's scripts/instance-env.sh, so one checkout path
// selects one port in both repositories: sha256(path) -> 10000 + digest % 55000.
// The result lies in [10000, 64999]. Hashing the path rather than the branch
// keeps the port, and with it Tauri's config and Cargo's warm build, stable
// across branch switches inside a worktree.
export function portForPath(path) {
  const digest = createHash("sha256").update(path, "utf8").digest("hex");
  return Number(10000n + (BigInt(`0x${digest}`) % 55000n));
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
