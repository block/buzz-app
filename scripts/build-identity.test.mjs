import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureBuildIdentity } from "./build-identity.mjs";

const directories = [];

function repository() {
  const root = mkdtempSync(join(tmpdir(), "buzz-build-identity-"));
  directories.push(root);
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "--quiet");
  git("config", "user.name", "Buzz Test");
  git("config", "user.email", "buzz-test@example.org");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "source.txt"), "source\n");
  git("add", "source.txt");
  git("commit", "--quiet", "-m", "initial source");
  return root;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("captures a committed production source as clean and a mutable edit as dirty", () => {
  const root = repository();
  const clean = captureBuildIdentity(root);
  expect(clean.revision).toMatch(/^[a-f\d]{40}$/);
  expect(clean.state).toBe("clean");

  writeFileSync(join(root, "source.txt"), "edited source\n");
  expect(captureBuildIdentity(root)).toEqual({
    revision: clean.revision,
    state: "dirty",
  });
});

it("keeps a dev server or a source archive unknown without failing configuration", () => {
  const root = repository();
  expect(captureBuildIdentity(root, { mutable: true })).toEqual({
    revision: expect.stringMatching(/^[a-f\d]{40}$/),
    state: "unknown",
  });

  const archive = mkdtempSync(join(tmpdir(), "buzz-build-archive-"));
  directories.push(archive);
  expect(captureBuildIdentity(archive)).toEqual({
    revision: null,
    state: "unknown",
  });
});
