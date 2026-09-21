import {
  checkIconSource,
  checkIconManifest,
} from "./design-system/check-icons.mjs";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
process.chdir(git("rev-parse", "--show-toplevel").trim());
const paths = (output) => output.split("\0").filter(Boolean);
const staged = paths(
  git("diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z", "--"),
);
const supported = /\.(?:[cm]?[jt]sx?|jsonc?|css|rs)$/;
const files = staged.filter((file) => supported.test(file));
const unstaged = new Set(paths(git("diff", "--name-only", "-z", "--")));
// Format using the configuration that will accompany this commit. Include nested
// configuration and untracked overrides, not just partially staged source files.
const configNames = [
  "biome.json",
  "biome.jsonc",
  ".editorconfig",
  "rustfmt.toml",
  ".rustfmt.toml",
  "package.json",
  "tsconfig.json",
  ".gitignore",
  ".ignore",
];
const configs = new Set();
for (const file of files) {
  let directory = dirname(file);
  while (true) {
    for (const name of configNames)
      configs.add(directory === "." ? name : `${directory}/${name}`);
    if (directory === ".") break;
    directory = dirname(directory);
  }
}
const tracked = new Set(paths(git("ls-files", "-z")));
for (const file of configs) {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (unstaged.has(file) || (stat && !tracked.has(file)))
    throw new Error(
      `Unstaged formatter configuration: ${file}. Stage or restore it before committing; nothing was changed.`,
    );
  if (stat && !stat.isFile())
    throw new Error(`Refusing non-regular formatter configuration: ${file}`);
}
// Check every candidate before any formatter writes. Never broaden a partial commit.
for (const file of files) {
  if (unstaged.has(file))
    throw new Error(
      `Partially staged file: ${file}. Format it first, then reselect your hunks; nothing was changed.`,
    );
  if (!lstatSync(file).isFile())
    throw new Error(`Refusing to format a non-regular staged file: ${file}`);
}
// Same icon policy as lint/CI, after partial-stage checks and before any writes.
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const errors = /\.[cm]?[jt]sx?$/.test(file)
    ? checkIconSource(file, source)
    : file === "package.json" || file.endsWith("/package.json")
      ? checkIconManifest(JSON.parse(source))
      : [];
  if (errors.length) throw new Error(`${file}: ${errors.join("\n")}`);
}
const biome = files.filter((file) => !file.endsWith(".rs"));
if (biome.length)
  execFileSync(
    resolve("bin/pnpm"),
    [
      "exec",
      "biome",
      "check",
      "--config-path=biome.json",
      "--write",
      "--error-on-warnings",
      "--files-ignore-unknown=true",
      "--no-errors-on-unmatched",
      "--",
      ...biome,
    ],
    { stdio: "inherit" },
  );
for (const file of files.filter((file) => file.endsWith(".rs"))) {
  // Stdin formats just this file, never follows `mod` into unstaged Rust files.
  const formatted = execFileSync(
    resolve("bin/rustfmt"),
    ["--edition", "2021", "--emit", "stdout"],
    { input: readFileSync(file), maxBuffer: 16 * 1024 * 1024 },
  );
  writeFileSync(file, formatted);
}
// A failed check leaves fixes visible but does not change the index.
if (files.length)
  execFileSync("git", ["--literal-pathspecs", "add", "--", ...files], {
    stdio: "inherit",
  });
