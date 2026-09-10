import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);
// These commits are disposable probe fixtures, never commits in the source checkout.
env.GIT_CONFIG_NOSYSTEM = "1";
env.GIT_CONFIG_GLOBAL = "/dev/null";
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "buzz-hook-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (cmd, args) =>
    spawnSync(cmd, args, { cwd: dir, env, encoding: "utf8" });
  const git = (...args) => {
    const result = run("git", args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  const write = (file, content) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  };
  const read = (file) => readFileSync(path.join(dir, file), "utf8");
  git("init", "-q");
  git("config", "user.name", "Hook Test");
  git("config", "user.email", "hook-test@example.invalid");
  write("untouched.ts", "export const unrelated = 1;\n");
  write("partial.ts", "export const first = 1;\nexport const second = 2;\n");
  git("add", ".");
  git("commit", "-qm", "fixture base");
  for (const file of [
    "biome.json",
    "package.json",
    "lefthook.yml",
    "scripts",
    ".githooks",
  ])
    cpSync(path.join(root, file), path.join(dir, file), { recursive: true });
  symlinkSync(path.join(root, "bin"), path.join(dir, "bin"), "dir");
  symlinkSync(
    path.join(root, "node_modules"),
    path.join(dir, "node_modules"),
    "dir",
  );
  git(
    "add",
    "biome.json",
    "package.json",
    "lefthook.yml",
    "scripts",
    ".githooks",
  );
  git("commit", "-qm", "hook configuration");
  const sibling = path.join(dir, "sibling");
  git("worktree", "add", "--detach", sibling);
  const install = () =>
    run(path.join(root, "bin/node"), ["scripts/install-hooks.mjs"]);
  const installed = install();
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const commit = () => run("git", ["commit", "-qm", "probe"]);
  return { dir, sibling, run, git, write, read, install, commit };
}

test("installed hook formats and safely fixes staged files without including other work", (t) => {
  const f = fixture(t);
  f.write("nested/space name.ts", "export const answer={value:42}\n");
  f.write("safe.ts", "export function count(){let value=1; return value;}\n");
  f.git("add", "nested/space name.ts", "safe.ts");
  f.write("untouched.ts", "export const unrelated = 99;\n");
  f.write("untracked.ts", "export const doNotAdd={value:1}\n");
  const result = f.commit();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    f.git("show", "HEAD:nested/space name.ts"),
    "export const answer = { value: 42 };\n",
  );
  assert.match(f.git("show", "HEAD:safe.ts"), /const value = 1;/);
  assert.equal(f.read("untouched.ts"), "export const unrelated = 99;\n");
  assert.equal(
    f.git("show", "HEAD:untouched.ts"),
    "export const unrelated = 1;\n",
  );
  assert.equal(f.git("ls-files", "untracked.ts"), "");
  assert.equal(f.git("stash", "list"), "");
});

test("partial staging fails before writes, preserving index, unrelated edits and stashes", (t) => {
  const f = fixture(t);
  f.write("untouched.ts", "export const unrelated = 7;\n");
  f.git("stash", "push", "-qm", "existing user stash");
  f.write(
    "partial.ts",
    "export const first={value:1}\nexport const second = 2;\n",
  );
  f.write("fully.ts", "export const staged={value:1}\n");
  f.git("add", "partial.ts", "fully.ts");
  const index = f.git("write-tree");
  const partial = "export const first={value:1}\nexport const second = 99;\n";
  f.write("partial.ts", partial);
  f.write("untouched.ts", "export const unrelated = 88;\n");
  const stashes = f.git("stash", "list");
  const result = f.commit();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /Partially staged file/);
  assert.equal(f.git("write-tree"), index);
  assert.equal(f.read("partial.ts"), partial);
  assert.equal(f.read("fully.ts"), "export const staged={value:1}\n");
  assert.equal(f.read("untouched.ts"), "export const unrelated = 88;\n");
  assert.equal(f.git("stash", "list"), stashes);
});

test("warnings reject commit without unsafe fixes or index updates", (t) => {
  const f = fixture(t);
  const source = "export const first = (values: string[]) => values[0]!;\n";
  f.write("warning.ts", source);
  f.git("add", "warning.ts");
  const index = f.git("write-tree");
  const head = f.git("rev-parse", "HEAD");
  const result = f.commit();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /noNonNullAssertion/);
  assert.equal(f.read("warning.ts"), source);
  assert.equal(f.git("write-tree"), index);
  assert.equal(f.git("rev-parse", "HEAD"), head);
});

test("Rust formatting touches the staged file, not its unstaged modules", (t) => {
  const f = fixture(t);
  f.write("main.rs", 'mod child;\nfn main(){println!("test");}\n');
  f.git("add", "main.rs");
  const child = "pub fn untouched( ){ }\n";
  f.write("child.rs", child);
  const result = f.commit();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    f.git("show", "HEAD:main.rs"),
    'mod child;\nfn main() {\n    println!("test");\n}\n',
  );
  assert.equal(f.read("child.rs"), child);
  assert.equal(f.git("ls-files", "child.rs"), "");
});

test("staged deletions and documentation-only commits do not rewrite source", (t) => {
  const f = fixture(t);
  f.git("rm", "partial.ts");
  f.write("notes.md", "# notes\n");
  f.git("add", "notes.md");
  f.write("untouched.ts", "export const unrelated={value:1}\n");
  const result = f.commit();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.git("ls-files", "partial.ts"), "");
  assert.equal(f.read("untouched.ts"), "export const unrelated={value:1}\n");
});

test("installation is worktree-local, repeatable, and refuses custom hooks", (t) => {
  const f = fixture(t);
  assert.equal(
    f.git("config", "--worktree", "--get", "core.hooksPath").trim(),
    ".githooks",
  );
  assert.equal(
    f.run("git", ["config", "--local", "--get", "core.hooksPath"]).status,
    1,
  );
  assert.equal(f.install().status, 0);

  const result = spawnSync("git", ["config", "--get", "core.hooksPath"], {
    cwd: f.sibling,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  f.git("config", "--worktree", "--unset", "core.hooksPath");
  f.write(".git/hooks/pre-commit", "#!/bin/sh\nexit 1\n");
  const before = f.read(".git/hooks/pre-commit");
  const refused = f.install();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Existing hooks/);
  assert.equal(f.read(".git/hooks/pre-commit"), before);
  f.git("config", "--worktree", "core.hooksPath", "custom-hooks");
  assert.notEqual(f.install().status, 0);
  assert.equal(
    f.git("config", "--get", "core.hooksPath").trim(),
    "custom-hooks",
  );
});

test("unstaged lint configuration cannot hide a staged warning", (t) => {
  const f = fixture(t);
  const config = JSON.parse(f.read("biome.json"));
  config.linter.rules.style = { noNonNullAssertion: "off" };
  f.write("biome.json", `${JSON.stringify(config, null, 2)}\n`);
  f.write(
    "warning.ts",
    "export const first = (values: string[]) => values[0]!;\n",
  );
  f.git("add", "warning.ts");
  const index = f.git("write-tree");
  const result = f.commit();
  assert.notEqual(
    result.status,
    0,
    "Staged warning committed using unstaged rule disable",
  );
  assert.equal(f.git("write-tree"), index);
});

test("type-change from symlink to source still checks warnings", (t) => {
  const f = fixture(t);
  symlinkSync("untouched.ts", path.join(f.dir, "changed.ts"));
  f.git("add", "changed.ts");
  // Seed type-change baseline without running a hook on a symlink.
  const seed = f.run("git", [
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "seed symlink",
  ]);
  assert.equal(seed.status, 0, seed.stderr);
  rmSync(path.join(f.dir, "changed.ts"));
  f.write(
    "changed.ts",
    "export const first = (values: string[]) => values[0]!;\n",
  );
  f.git("add", "changed.ts");
  assert.match(f.git("diff", "--cached", "--name-status"), /^T\s+changed.ts/m);
  const result = f.commit();
  assert.notEqual(
    result.status,
    0,
    "Type-changed source warning committed unchecked",
  );
});

test("formatter failure preserves index and unrelated edits", (t) => {
  const f = fixture(t);
  f.write("safe.ts", "export const value={a:1}\n");
  f.write("bad.ts", "export const first=(values:string[])=>values[0]!\n");
  f.git("add", "safe.ts", "bad.ts");
  f.write("untouched.ts", "export const unrelated=99\n");
  const index = f.git("write-tree");
  const result = f.commit();
  assert.notEqual(result.status, 0);
  assert.equal(f.git("write-tree"), index);
  assert.equal(f.read("untouched.ts"), "export const unrelated=99\n");
  assert.match(f.read("safe.ts"), /value =/);
});

test("filename metacharacters and rename destination are literal", (t) => {
  const f = fixture(t);
  f.git("mv", "partial.ts", "renamed.ts");
  const names = [
    "-dash.ts",
    "bracket[1].ts",
    "line\nbreak.ts",
    "colon:name.ts",
  ];
  for (const name of names) f.write(name, "export const value={a:1}\n");
  f.git("add", "--", ...names);
  f.write("bracket1.ts", "export const untracked={a:2}\n");
  const result = f.commit();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const name of names)
    assert.equal(
      f.git("show", `HEAD:${name}`),
      "export const value = { a: 1 };\n",
    );
  assert.equal(f.git("ls-files", "bracket1.ts"), "");
  assert.equal(f.git("ls-files", "partial.ts"), "");
  assert.equal(f.git("ls-files", "renamed.ts"), "renamed.ts\n");
});

test("untracked nested formatter overrides fail before any source writes", (t) => {
  const f = fixture(t);
  f.write("nested/biome.json", '{"root":false,"linter":{"enabled":false}}\n');
  const source = "export const first=(values:string[])=>values[0]!\n";
  f.write("nested/warning.ts", source);
  f.git("add", "nested/warning.ts");
  const index = f.git("write-tree");
  const result = f.commit();
  assert.notEqual(result.status, 0);
  assert.match(
    result.stdout + result.stderr,
    /Unstaged formatter configuration/,
  );
  assert.equal(f.git("write-tree"), index);
  assert.equal(f.read("nested/warning.ts"), source);
});
