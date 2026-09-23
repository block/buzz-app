import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { portForPath, worktreePort } from "../../scripts/worktree-port.mjs";

// Expected values were cross-checked independently of portForPath with
// Python 3.14.5 and a separate Node one-liner, which agree on both:
// python3 -c "import hashlib,sys; h=int(hashlib.sha256(sys.argv[1].encode()).hexdigest(),16); print(40000 + h % 25000)" "$PATH_UNDER_TEST"
// The first vector keeps the value it had under the previous
// 10000 + digest % 55000 mapping by coincidence (both moduli are multiples of
// 5000); the second moved from 42704, so it pins the new mapping.
const KNOWN = [
  ["/tmp/buzz-worktree-port-fixture", 60252],
  ["/tmp/wörktree ✓", 57704],
];

test("portForPath is deterministic and stays in buzz-app's [40000, 64999]", () => {
  for (const [candidate, expected] of KNOWN) {
    assert.equal(portForPath(candidate), expected);
    assert.equal(portForPath(candidate), portForPath(candidate));
  }
  // block/buzz owns [10000, 39999]; anything below 40000 would break the partition.
  for (const candidate of ["", "/", "a".repeat(4096), KNOWN[0][0]]) {
    const port = portForPath(candidate);
    assert.ok(Number.isInteger(port), `${candidate}: ${port}`);
    assert.ok(port >= 40000 && port <= 64999, `${candidate}: ${port}`);
  }
  assert.notEqual(portForPath(`${KNOWN[0][0]}/`), KNOWN[0][1]);
});

test("worktreePort hashes the Git toplevel, or the directory outside Git", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-worktree-port-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // Git hooks export repository selectors; never let fixtures resolve to the real repo.
  for (const key of [
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
  ])
    delete process.env[key];
  const git = (...args) =>
    execFileSync("git", args, { encoding: "utf8", stdio: "pipe" }).trim();
  const repo = path.join(directory, "repo");
  git("init", "--quiet", repo);
  const nested = path.join(repo, "nested", "deeper");
  mkdirSync(nested, { recursive: true });
  // Git reports the resolved root (on macOS, /private/var rather than /var).
  const toplevel = git("-C", nested, "rev-parse", "--show-toplevel");
  assert.equal(worktreePort(nested), portForPath(toplevel));
  assert.equal(worktreePort(repo), portForPath(toplevel));
  assert.equal(worktreePort(`${repo}${path.sep}`), portForPath(toplevel));

  const plain = path.join(directory, "plain");
  mkdirSync(plain);
  assert.equal(worktreePort(plain), portForPath(plain));
  assert.equal(
    worktreePort(`${plain}${path.sep}`),
    portForPath(plain),
    "trailing separators do not change the fallback",
  );
});
