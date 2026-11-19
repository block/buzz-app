import { execFileSync } from "node:child_process";

const REVISION = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i;

export function captureBuildIdentity(root, { mutable = false } = {}) {
  let revision = null;
  try {
    const found = execFileSync(
      "git",
      ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (REVISION.test(found)) revision = found;
  } catch {}

  if (!revision || mutable) return { revision, state: "unknown" };

  try {
    const status = execFileSync(
      "git",
      [
        "-C",
        root,
        "--no-optional-locks",
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return { revision, state: status.trim() ? "dirty" : "clean" };
  } catch {
    return { revision, state: "unknown" };
  }
}
