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

// gh's --jq on a fixture response: the last argument is the filter.
const jq = (json) =>
  `jq -r "\${@: -1}" <<< ${JSON.stringify(JSON.stringify(json)).replace(/\$/g, "\\$")}`;

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
  // The live desktop-v* ruleset, and the v* one the setup docs describe.
  const desktopRuleset = {
    id: 6,
    target: "tag",
    enforcement: "active",
    conditions: {
      ref_name: { include: ["refs/tags/desktop-v*"], exclude: [] },
    },
    rules: ["deletion", "non_fast_forward", "creation", "update"].map(
      (type) => ({ type }),
    ),
    current_user_can_bypass: "never",
  };
  const stableRuleset = {
    ...desktopRuleset,
    id: 7,
    conditions: {
      ref_name: {
        include: ["refs/tags/v*"],
        exclude: ["refs/tags/v*-preview.*"],
      },
    },
  };
  const source = (
    tag,
    {
      tagged = sha,
      base = sha,
      ruleset = stableRuleset,
      actor = "admin-user",
      permission = "admin",
    } = {},
  ) => {
    const dir = temp(t);
    fakeGh(
      dir,
      `args="$*"; echo "\${args//$'\\n'/ }" >> "$DIR/calls"
case "$2" in
  */collaborators/admin-user/permission) ${jq({ permission })} ;;
  */collaborators/*/permission) exit 1 ;;
  */rulesets) ${jq([desktopRuleset, ruleset])} ;;
  */rulesets/6) ${jq(desktopRuleset)} ;;
  */rulesets/7) ${jq(ruleset)} ;;
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
      ACTOR: actor,
      SOURCE_SHA: sha,
      TAGGED: tagged,
      BASE: base,
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
    assert.equal(result.calls.length, 7);
    assert.equal(
      result.calls[0],
      "api repos/block/buzz-app/collaborators/admin-user/permission --jq .permission",
    );
    assert.match(
      result.calls[1],
      /^api repos\/block\/buzz-app\/rulesets --jq /,
    );
    assert.match(
      result.calls[2],
      /^api repos\/block\/buzz-app\/rulesets\/6 --jq /,
    );
    assert.match(
      result.calls[3],
      /^api repos\/block\/buzz-app\/rulesets\/7 --jq /,
    );
    assert.deepEqual(result.calls.slice(4), [
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
  // Only an admin's tag publishes. The token cannot see bypass actors, so a
  // write role or App granted a bypass is caught by who pushed the tag.
  for (const permission of ["write", "maintain", "read", "none"]) {
    const result = source("v1.0.0", { permission });
    assert.match(
      result.stdout,
      /was pushed by admin-user, who is not a repository admin/,
    );
    assert.equal(result.calls.length, 1, permission);
    assert.equal(result.output, "", permission);
  }
  // An unreadable permission (an App's bot, an API error) fails closed.
  const bot = source("v1.0.0", { actor: "release-app[bot]" });
  assert.match(bot.stdout, /Could not read release-app\[bot\]'s permission/);
  assert.equal(bot.calls.length, 1);
  assert.equal(bot.output, "");
  // Unprotected v* tags never publish: anyone with write access can push one.
  const condition = (ref_name) => ({ ...stableRuleset.conditions, ref_name });
  for (const ruleset of [
    { ...stableRuleset, enforcement: "evaluate" },
    // Workflows could create the tag: GitHub Actions is a bypass actor.
    { ...stableRuleset, current_user_can_bypass: "always" },
    { ...stableRuleset, current_user_can_bypass: "pull_requests_only" },
    { ...stableRuleset, rules: stableRuleset.rules.slice(1) },
    {
      ...stableRuleset,
      conditions: condition({
        include: ["refs/tags/v*"],
        exclude: ["refs/tags/v1*"],
      }),
    },
    {
      ...stableRuleset,
      conditions: condition({ include: ["refs/tags/v1*"], exclude: [] }),
    },
  ])
    assert.match(
      source("v1.0.0", { ruleset }).stdout,
      /No active tag ruleset restricts/,
    );
  // Protecting previews' tags as well is accepted: the stable lane is safe.
  assert.equal(
    source("v1.0.0", {
      ruleset: {
        ...stableRuleset,
        conditions: condition({ include: ["refs/tags/v*"], exclude: [] }),
      },
    }).status,
    0,
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
  assert.deepEqual(promote.permissions, {
    actions: "read",
    contents: "write",
  });
  const [requireMain, requireEnvironment, , promotion] = promote.steps;
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
  // GitHub creates a missing environment unprotected; promotion fails closed.
  const reviewers = {
    type: "required_reviewers",
    reviewers: [{ type: "User", reviewer: { login: "example" } }],
  };
  const custom = { custom_branch_policies: true, protected_branches: false };
  const main = [{ name: "main", type: "branch" }];
  const environment = (rules, policy, branches) => {
    const dir = temp(t);
    fakeGh(
      dir,
      `echo "$2" >> "$DIR/calls"
case "$2" in
  */environments/desktop-stable-feed) ${jq({ protection_rules: rules, deployment_branch_policy: policy })} ;;
  */deployment-branch-policies) ${jq({ branch_policies: branches })} ;;
  *) exit 64 ;;
esac
`,
    );
    return run(dir, requireEnvironment.run, {}).status;
  };
  assert.equal(
    environment([reviewers, { type: "branch_policy" }], custom, main),
    0,
  );
  for (const [rules, policy, branches] of [
    [[], null, []],
    [[{ type: "branch_policy" }], custom, main],
    [[{ ...reviewers, reviewers: [] }], custom, main],
    [[reviewers], null, []],
    [
      [reviewers],
      { custom_branch_policies: false, protected_branches: true },
      [],
    ],
    [[reviewers], custom, [...main, { name: "release/*", type: "branch" }]],
    [[reviewers], custom, [{ name: "main", type: "tag" }]],
  ])
    assert.notEqual(environment(rules, policy, branches), 0);
  assert.equal(
    promotion.run,
    'scripts/promote-updater-feed.sh stable-feed "$VERSION"',
  );
  assert.equal(promotion.env.VERSION, `\${{ inputs.version }}`);
});

test("feed promotion serves each version only on its own feed and release type", (t) => {
  const promote = (feed, version, prerelease = false, draft = false) => {
    const dir = temp(t);
    // Stops after the release-type check: later steps are preview-feed.test.mjs's.
    fakeGh(
      dir,
      `echo "$1 $2 $3" >> "$DIR/calls"
[ "$1 $2" = "release view" ] && { ${jq({ isDraft: draft, isPrerelease: prerelease })}; exit 0; }
exit 1
`,
    );
    return run(dir, `scripts/promote-updater-feed.sh ${feed} ${version}`, {
      RUNNER_TEMP: dir,
      GITHUB_SHA: sha,
    });
  };
  const view = (version) => `release view v${version}`;
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
  // Stable feeds serve full releases; preview feeds serve prereleases. Neither
  // serves a draft a failed publication left: its asset URLs 404 publicly.
  for (const [feed, version, prerelease, draft] of [
    ["stable-feed", "1.0.0", true, false],
    ["preview-feed", "1.0.0-preview.2.1", false, false],
    ["stable-feed", "1.0.0", false, true],
    ["preview-feed", "1.0.0-preview.2.1", true, true],
  ]) {
    const result = promote(feed, version, prerelease, draft);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, [view(version)]);
  }
  for (const [feed, version, prerelease] of [
    ["stable-feed", "1.0.0", false],
    ["preview-feed", "1.0.0-preview.2.1", true],
  ]) {
    const result = promote(feed, version, prerelease);
    // The type check passed, so the next call is the first asset download.
    assert.equal(result.calls[0], view(version));
    assert.match(result.calls[1], new RegExp(`^release download v${version}$`));
  }
});
