import { execFileSync, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const config = (key, scope = []) => {
  const result = spawnSync("git", ["config", ...scope, "--get", key], {
    encoding: "utf8",
  });
  if (result.status === 1) return "";
  if (result.status !== 0)
    throw new Error(result.stderr || `Cannot read ${key}`);
  return result.stdout.trim();
};
const executable = (file) => accessSync(file, constants.X_OK);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
process.chdir(git("rev-parse", "--show-toplevel"));
const root = process.cwd();
const ownedRoot = resolve(git("rev-parse", "--git-path", "buzz-hooks"));
const existing = config("core.hooksPath");
let upstream = existing;
let previous =
  config("extensions.worktreeConfig") === "true"
    ? config("core.hooksPath", ["--worktree"])
    : "";
if (existing.startsWith(`${ownedRoot}/`)) {
  const metadata = JSON.parse(
    readFileSync(join(existing, "owner.json"), "utf8"),
  );
  if (
    metadata.owner !== "buzz-hooks-v1" ||
    metadata.upstream.startsWith(ownedRoot)
  )
    throw new Error(
      "Invalid Buzz dispatcher ownership; restore the previous hooksPath.",
    );
  for (const [name, content] of Object.entries(metadata.files)) {
    if (readFileSync(join(existing, name), "utf8") !== content)
      throw new Error(
        `Modified Buzz dispatcher ${name}; reconcile it before installing.`,
      );
  }
  if (
    readdirSync(existing).some(
      (name) => name !== "owner.json" && !(name in metadata.files),
    )
  )
    throw new Error(
      "Custom files in Buzz dispatcher; reconcile them before installing.",
    );
  upstream = metadata.upstream;
  previous = metadata.previous;
} else if (existing === ".githooks") {
  // Read lower scopes without temporarily disabling the active hooks.
  upstream = config("core.hooksPath", ["--local"]);
  if (!upstream || upstream === ".githooks")
    upstream = config("core.hooksPath", ["--global"]);
  if (!upstream || upstream === ".githooks")
    upstream = config("core.hooksPath", ["--system"]);
  if (upstream === ".githooks") upstream = "";
}
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
if (config("core.worktree") || config("core.bare") === "true")
  throw new Error(
    "Nonstandard worktree configuration; install hooks manually.",
  );

const events = [];
if (upstream) {
  upstream = resolve(upstream);
  for (const name of readdirSync(upstream)) {
    if (!/^[a-z]+(?:-[a-z]+)+$/.test(name))
      throw new Error(
        `Unknown custom hook ${name}; reconcile it before installing.`,
      );
    const file = join(upstream, name);
    const content = readFileSync(file, "utf8");
    const match = content.match(
      /^#!\/bin\/sh\nexec "([^"$`\\\n]+)" run-hook ([a-z-]+) "\$@"\n$/,
    );
    if (!match || match[2] !== name || !isAbsolute(match[1]))
      throw new Error(
        `Unrecognized lhm hook ${file}; reconcile it before installing.`,
      );
    executable(file);
    executable(match[1]);
    events.push(name);
  }
  if (!events.includes("pre-commit") || !events.includes("pre-push"))
    throw new Error("lhm installation must include pre-commit and pre-push.");
}
for (const file of [
  "bin/node",
  "bin/lefthook",
  ".githooks/pre-commit",
  ".githooks/pre-push",
])
  executable(resolve(file));
execFileSync(resolve("bin/lefthook"), ["validate"], { stdio: "inherit" });
let target = ".githooks";
if (upstream) {
  mkdirSync(ownedRoot, { recursive: true });
  target = mkdtempSync(join(ownedRoot, "dispatch-"));
  try {
    const files = {};
    for (const event of events) {
      files[event] =
        event === "pre-commit" || event === "pre-push"
          ? `#!/bin/sh\nexec ${quote(join(root, "bin/node"))} ${quote(join(root, "scripts/run-hook.mjs"))} ${quote(event)} ${quote(join(upstream, event))} "$@"\n`
          : `#!/bin/sh\nset -eu\ntest -x ${quote(join(root, "bin/lefthook"))} || { echo "Missing pinned Lefthook" >&2; exit 1; }\nPATH=${quote(join(root, "bin"))}:"$PATH"\nexport PATH\nexec ${quote(join(upstream, event))} "$@"\n`;
      writeFileSync(join(target, event), files[event], { mode: 0o755 });
      executable(join(target, event));
      execFileSync("sh", ["-n", join(target, event)]);
    }
    writeFileSync(
      join(target, "owner.json"),
      `${JSON.stringify({ owner: "buzz-hooks-v1", upstream, previous, files }, null, 2)}\n`,
    );
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}
// Only activate after every validation succeeds. Older generations remain usable
// for recovery; never rewrite an active wrapper underneath a running Git command.
git("config", "--local", "extensions.worktreeConfig", "true");
git("config", "--worktree", "core.hooksPath", target);
console.log(
  `Installed Buzz hooks for this worktree only${upstream ? ` with lhm at ${upstream}` : ""}.`,
);
