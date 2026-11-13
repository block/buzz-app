#!/usr/bin/env node
// Prints the preview version for a commit: one patch above the highest stable
// vX.Y.Z tag in its history, then -preview.<run>.<attempt>. Betas and previews'
// own tags never count. release.yml runs it once and passes the result to every
// platform job, so a tag pushed mid-run cannot split their versions.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const [commit = "HEAD"] = process.argv.slice(2);
const { GITHUB_RUN_NUMBER: run, GITHUB_RUN_ATTEMPT: attempt } = process.env;
assert.match(run ?? "", /^[1-9]\d*$/, "GITHUB_RUN_NUMBER is required");
assert.match(attempt ?? "", /^[1-9]\d*$/, "GITHUB_RUN_ATTEMPT is required");
const stable = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const releases = execFileSync(
  "git",
  ["tag", "--merged", commit, "--list", "v*"],
  { encoding: "utf8" },
)
  .split("\n")
  .map((tag) => stable.exec(tag)?.slice(1).map(BigInt))
  .filter(Boolean);
assert.ok(releases.length, `No stable vX.Y.Z tag is reachable from ${commit}`);
const [major, minor, patch] = releases.reduce((highest, release) => {
  for (let i = 0; i < 3; i++)
    if (release[i] !== highest[i])
      return release[i] > highest[i] ? release : highest;
  return highest;
});
const version = `${major}.${minor}.${patch + 1n}-preview.${run}.${attempt}`;
console.log(version);
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
