import { createHash } from "node:crypto";
import { worktreeRoot } from "./worktree-port.mjs";

// An OS routes a URL scheme to one application, so a development build must not
// claim the released `buzz`: on a machine with Buzz installed, whichever app
// registered last would receive every buzz:// link. Each worktree instead derives
// its own scheme from the SHA-256 digest of its root, the same input its port
// hashes, so two worktrees bundled on one machine own different schemes and
// neither shadows a released client. Six hex characters keep a scheme short
// enough to type; a collision would only matter between two worktrees on one
// machine, and `--scheme` settles it. Hashing the path rather than the branch
// keeps the scheme, and with it Tauri's config and Cargo's warm build, stable
// across branch switches inside a worktree.
export function schemeForPath(path) {
  const digest = createHash("sha256").update(path, "utf8").digest("hex");
  return `buzz-dev-${digest.slice(0, 6)}`;
}

export function worktreeScheme(dir) {
  return schemeForPath(worktreeRoot(dir));
}
