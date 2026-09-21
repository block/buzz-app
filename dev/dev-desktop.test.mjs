import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopArgs, worktreeLabel } from "../scripts/dev-desktop.mjs";

const directories = [];
// Git hooks export repository selectors. Keep every fixture command, including
// the real launcher under test, scoped to the disposable checkout instead.
const repositoryEnvironment = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
];
beforeEach(() => {
  for (const key of repositoryEnvironment) vi.stubEnv(key, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "buzz-dev-launch-"));
  directories.push(base);
  const main = join(base, "main");
  const linked = join(base, 'linked "checkout"');
  const git = (...args) => execFileSync("git", args, { stdio: "pipe" });
  git("init", "--initial-branch=main", main);
  git(
    "-C",
    main,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  git(
    "-C",
    main,
    "-c",
    "core.hooksPath=/dev/null",
    "worktree",
    "add",
    "-b",
    "person/onboarding-feedback",
    linked,
  );
  return { main, linked, git };
}
it("labels linked worktrees by branch suffix and detached trees by directory", () => {
  const { main, linked, git } = fixture();
  expect(worktreeLabel(main)).toBeNull();
  expect(worktreeLabel(linked)).toBe("onboarding-feedback");
  git("-C", linked, "-c", "core.hooksPath=/dev/null", "checkout", "--detach");
  expect(worktreeLabel(linked)).toBe('linked "checkout"');
});
it("overrides only the development icon, safely encoding checkout paths", () => {
  const { linked } = fixture();
  const run = vi.fn(() => ({ status: 0 }));
  const args = desktopArgs({ cwd: linked, platform: "darwin", run });
  expect(args.slice(0, 3)).toEqual(["tauri", "dev", "--config"]);
  expect(JSON.parse(args[3])).toEqual({
    bundle: { icon: [join(linked, "src-tauri/target/dev-icons/icon.icns")] },
  });
  expect(run.mock.calls[0][1].at(-1)).toBe("onboarding-feedback");
});
it("leaves ordinary checkouts and non-macOS launches alone", () => {
  const { main, linked } = fixture();
  const run = vi.fn();
  expect(desktopArgs({ cwd: main, platform: "darwin", run })).toEqual([
    "tauri",
    "dev",
  ]);
  expect(desktopArgs({ cwd: linked, platform: "linux", run })).toEqual([
    "tauri",
    "dev",
  ]);
  expect(run).not.toHaveBeenCalled();
});
it.each([{ status: 1 }, { status: null, error: new Error("Swift missing") }])(
  "warns and falls back when icon generation fails: %j",
  (result) => {
    const { linked } = fixture();
    const warn = vi.fn();
    expect(
      desktopArgs({ cwd: linked, platform: "darwin", run: () => result, warn }),
    ).toEqual(["tauri", "dev"]);
    expect(warn).toHaveBeenCalledOnce();
  },
);
