import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { portForPath, worktreePort } from "../../scripts/worktree-port.mjs";
import {
  schemeForPath,
  worktreeScheme,
} from "../../scripts/worktree-scheme.mjs";

// Expected values were cross-checked independently of schemeForPath with
// Python 3.14.5, which agrees on both:
// python3 -c "import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:6])" "$PATH_UNDER_TEST"
const KNOWN = [
  ["/tmp/buzz-worktree-port-fixture", "buzz-dev-6b33e0"],
  ["/tmp/wörktree ✓", "buzz-dev-33ae62"],
];

test("schemeForPath is deterministic and valid RFC 3986 scheme syntax", () => {
  for (const [candidate, expected] of KNOWN) {
    assert.equal(schemeForPath(candidate), expected);
    assert.equal(schemeForPath(candidate), schemeForPath(candidate));
  }
  for (const candidate of ["", "/", "a".repeat(4096), KNOWN[0][0]]) {
    const scheme = schemeForPath(candidate);
    // Lower case, since the shell compares a delivered scheme exactly.
    assert.match(scheme, /^[a-z][a-z0-9+.-]*$/, candidate);
    assert.equal(scheme, scheme.toLowerCase(), candidate);
  }
});

test("schemeForPath never claims the scheme a released client owns", () => {
  const { schemes } = JSON.parse(
    readFileSync(
      new URL("../../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  ).plugins["deep-link"].desktop;
  // A derived scheme must not shadow an installed Buzz, which is the whole reason
  // development launches overlay one. The `buzz-dev-` prefix guarantees it for
  // every input, since the released scheme has no hyphen at all.
  for (const candidate of [
    "",
    "/",
    "a".repeat(4096),
    ...KNOWN.map(([p]) => p),
  ]) {
    const scheme = schemeForPath(candidate);
    assert.ok(scheme.startsWith("buzz-dev-"), scheme);
    assert.ok(!schemes.includes(scheme), scheme);
  }
});

test("distinct paths get distinct schemes", () => {
  const paths = [
    "/Users/dev/buzz-app",
    "/Users/dev/buzz-app/",
    "/Users/dev/buzz-app-worktrees/deep-links",
    "/Users/dev/buzz-app-worktrees/feature-5098",
  ];
  const schemes = new Set(paths.map(schemeForPath));
  assert.equal(schemes.size, paths.length);
});

test("worktreeScheme hashes the same root as the port, or the directory outside Git", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-worktree-scheme-"));
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
  assert.equal(worktreeScheme(nested), schemeForPath(toplevel));
  assert.equal(worktreeScheme(repo), schemeForPath(toplevel));
  // Both identities resolve the root the same way, so a worktree's scheme and its
  // port cannot end up derived from different paths.
  assert.equal(worktreePort(nested), portForPath(toplevel));

  const plain = path.join(directory, "plain");
  mkdirSync(plain);
  assert.equal(worktreeScheme(plain), schemeForPath(plain));
  assert.equal(
    worktreeScheme(`${plain}${path.sep}`),
    schemeForPath(plain),
    "trailing separators do not change the fallback",
  );
});
