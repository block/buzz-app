import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflow = (name) =>
  parse(readFileSync(join(root, ".github/workflows", name), "utf8"));
const sha = "a".repeat(40);

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "desktop-stable-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A fake gh answers from environment variables and logs every call.
function fakeGh(dir, script) {
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "gh"), `#!/bin/bash\n${script}`, {
    mode: 0o755,
  });
}

function run(dir, command, env) {
  const result = spawnSync("bash", ["-c", command], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      DIR: dir,
      GH_REPO: "block/buzz-app",
      ...env,
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  let calls = [];
  try {
    calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
  } catch {}
  return { ...result, calls };
}

test("stable tags build from main history with the tag's version, never preview tags", (t) => {
  const { on, jobs } = workflow("desktop-stable.yml");
  assert.deepEqual(on, { push: { tags: ["v[0-9]*", "!v*-preview.*"] } });
  assert.equal(jobs.source.if, "github.repository == 'block/buzz-app'");
  assert.equal(jobs.desktop.uses, "./.github/workflows/desktop-build.yml");
  assert.deepEqual(jobs.desktop.needs, "source");
  assert.equal(
    jobs.desktop.with.release_version,
    `\${{ needs.source.outputs.version }}`,
  );
  assert.deepEqual(jobs.desktop.permissions, {
    contents: "write",
    "id-token": "write",
  });
  const check = jobs.source.steps[0].run;
  const source = (tag, { tagged = sha, base = sha, ruleset = "7" } = {}) => {
    const dir = temp(t);
    fakeGh(
      dir,
      `args="$*"; echo "\${args//$'\\n'/ }" >> "$DIR/calls"
# gh applies each --jq filter; this answers with the filtered result.
case "$2" in
  */rulesets) echo 7 ;;
  */rulesets/7) echo "$RULESET" ;;
  */commits/refs/tags/*) echo "$TAGGED" ;;
  */git/ref/heads/main) echo "${"b".repeat(40)}" ;;
  */compare/*) echo "$BASE" ;;
  *) exit 64 ;;
esac
`,
    );
    const output = join(dir, "output");
    writeFileSync(output, "");
    const result = run(dir, `set -e\n${check}`, {
      TAG: tag,
      SOURCE_SHA: sha,
      TAGGED: tagged,
      BASE: base,
      RULESET: ruleset,
      GITHUB_OUTPUT: output,
    });
    return { ...result, output: readFileSync(output, "utf8") };
  };
  for (const [tag, version] of [
    ["v1.0.0", "1.0.0"],
    ["v1.2.3-beta.4", "1.2.3-beta.4"],
  ]) {
    const result = source(tag);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(result.output, `version=${version}\n`);
    assert.equal(result.calls.length, 5);
    assert.match(
      result.calls[0],
      /^api repos\/block\/buzz-app\/rulesets --jq /,
    );
    assert.match(
      result.calls[1],
      /^api repos\/block\/buzz-app\/rulesets\/7 --jq /,
    );
    assert.deepEqual(result.calls.slice(2), [
      `api repos/block/buzz-app/commits/refs/tags/${tag} --jq .sha`,
      "api repos/block/buzz-app/git/ref/heads/main --jq .object.sha",
      `api repos/block/buzz-app/compare/${sha}...${"b".repeat(40)} --jq .merge_base_commit.sha`,
    ]);
  }
  for (const tag of [
    "v1.0",
    "v01.0.0",
    "v1.0.0-beta.0",
    "v1.0.0-rc.1",
    "v1.0.0-preview.2.1",
    "v1.0.0-beta.1-preview.1.1",
  ]) {
    const result = source(tag);
    assert.notEqual(result.status, 0, tag);
    assert.deepEqual(result.calls, [], tag);
    assert.equal(result.output, "", tag);
  }
  // Unprotected v* tags never publish: anyone with write access can push one.
  assert.match(
    source("v1.0.0", { ruleset: "" }).stdout,
    /No active tag ruleset restricts/,
  );
  // The tag must be this run's commit, and that commit must be on main.
  assert.match(
    source("v1.0.0", { tagged: "c".repeat(40) }).stdout,
    /is at c+, not a+/,
  );
  assert.match(
    source("v1.0.0", { base: "d".repeat(40) }).stdout,
    /is not in main history/,
  );
});

test("stable feed promotion is a manual, approved dispatch from main", (t) => {
  const { on, jobs, concurrency } = workflow("desktop-stable-feed.yml");
  assert.deepEqual(Object.keys(on), ["workflow_dispatch"]);
  assert.equal(on.workflow_dispatch.inputs.version.required, true);
  assert.equal(concurrency.group, "desktop-stable-feed");
  const { promote } = jobs;
  assert.equal(promote.environment, "desktop-stable-feed");
  assert.deepEqual(promote.permissions, { contents: "write" });
  const [requireMain, , promotion] = promote.steps;
  for (const [ref, status] of [
    ["refs/heads/main", 0],
    ["refs/heads/feature", 1],
    ["refs/tags/v1.0.0", 1],
  ]) {
    const dir = temp(t);
    assert.equal(
      run(dir, requireMain.run, { DISPATCH_REF: ref }).status,
      status,
      ref,
    );
  }
  assert.equal(
    promotion.run,
    'scripts/promote-updater-feed.sh stable-feed "$VERSION"',
  );
  assert.equal(promotion.env.VERSION, `\${{ inputs.version }}`);
});

test("feed promotion serves each version only on its own feed and release type", (t) => {
  const promote = (feed, version, prerelease = "false") => {
    const dir = temp(t);
    // Stops after the release-type check: later steps are preview-feed.test.mjs's.
    fakeGh(
      dir,
      `echo "$*" >> "$DIR/calls"
[ "$1 $2" = "release view" ] && { echo "$PRERELEASE"; exit 0; }
exit 1
`,
    );
    return run(dir, `scripts/promote-updater-feed.sh ${feed} ${version}`, {
      PRERELEASE: prerelease,
      RUNNER_TEMP: dir,
      GITHUB_SHA: sha,
    });
  };
  const view = (version) =>
    `release view v${version} --json isPrerelease --jq .isPrerelease`;
  // Betas and previews are refused before any release is read.
  for (const [feed, version] of [
    ["stable-feed", "1.0.0-beta.1"],
    ["stable-feed", "1.0.0-preview.2.1"],
    ["preview-feed", "1.0.0"],
    ["preview-feed", "1.0.0-beta.1"],
    ["latest", "1.0.0"],
  ]) {
    const result = promote(feed, version);
    assert.notEqual(result.status, 0, `${feed} ${version}`);
    assert.deepEqual(result.calls, [], `${feed} ${version}`);
  }
  // Stable feeds serve full releases; preview feeds serve prereleases.
  for (const [feed, version, prerelease] of [
    ["stable-feed", "1.0.0", "true"],
    ["preview-feed", "1.0.0-preview.2.1", "false"],
  ]) {
    const result = promote(feed, version, prerelease);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, [view(version)]);
  }
  for (const [feed, version, prerelease] of [
    ["stable-feed", "1.0.0", "false"],
    ["preview-feed", "1.0.0-preview.2.1", "true"],
  ]) {
    const result = promote(feed, version, prerelease);
    // The type check passed, so the next call is the first asset download.
    assert.equal(result.calls[0], view(version));
    assert.match(result.calls[1], new RegExp(`^release download v${version} `));
  }
});
