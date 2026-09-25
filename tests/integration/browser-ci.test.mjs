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
import { dirname, join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import config from "../browser/playwright.config.mjs";
import { nativeFixtureRequired } from "../../scripts/ci-browser-setup.mjs";
import { run } from "../browser/run-command.mjs";

const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const workflow = read(".github/workflows/ci.yml");
// These guards intentionally follow this workflow's small, literal job matrix.
// Unsupported YAML shapes fail rather than silently selecting fewer jobs.
const job = (name) => {
  const body = workflow.match(
    new RegExp(`^ {2}${name}:\n([\\s\\S]*?)(?=^ {2}\\w+:|$(?![\\s\\S]))`, "m"),
  )?.[1];
  assert.ok(body, `${name} job must exist`);
  return body;
};
const browser = job("browser");
const matrixValues = (key) => {
  const values = browser.match(
    new RegExp(`^ {8}${key}: \\[([^\\]]+)\\]$`, "m"),
  )?.[1];
  assert.ok(values, `literal ${key} matrix must exist`);
  return values.split(",").map((value) => value.trim());
};

test("six independent browser jobs retain isolated measurements and native setup", () => {
  assert.deepEqual(matrixValues("engine"), ["chromium", "webkit"]);
  assert.deepEqual(matrixValues("shard"), ["1", "2", "3"]);
  assert.doesNotMatch(browser, /^ {4}(needs|continue-on-error):/m);
  assert.doesNotMatch(browser, /^ {8}(include|exclude):/m);
  assert.match(browser, /^ {6}fail-fast: false$/m);
  assert.match(
    browser,
    /name: browser-journeys-\$\{\{ matrix\.engine \}\}-\$\{\{ matrix\.shard \}\}/,
  );
  const preparation = browser.indexOf(
    "run: cargo build --locked -p buzzodz-plugins --example fixture-bridge",
  );
  const journey = browser.indexOf("-- pnpm test:browser:ci");
  assert.ok(
    preparation >= 0 && journey > preparation,
    "native fixture must build before the browser journeys",
  );
  const steps = parse(workflow).jobs.browser.steps;
  const discovery = steps.find((step) => step.id === "browser-setup");
  const build = steps.find(
    (step) => step.name === "Build native browser fixture",
  );
  const cache = steps.find((step) => step.with?.key === "browser-fixture");
  const toolchain = steps.find(
    (step) => step.name === "Cache native fixture toolchain",
  );
  assert.ok(discovery, "discover native setup from the selected journeys");
  assert.ok(steps.indexOf(discovery) < steps.indexOf(toolchain));
  assert.ok(steps.indexOf(toolchain) < steps.indexOf(cache));
  assert.equal(toolchain.with.path, "~/.cache/hermit/pkg/rust-*");
  assert.equal(
    toolchain.with.key,
    `hermit-browser-fixture-\${{ runner.os }}-\${{ runner.arch }}-\${{ hashFiles('bin/**') }}`,
  );
  assert.ok(steps.indexOf(cache) < steps.indexOf(build));
  assert.equal(discovery.if, undefined);
  // Cache misses must build too; only actual test selection controls setup.
  for (const step of [toolchain, cache, build]) {
    assert.equal(
      step.if,
      "steps.browser-setup.outputs.native-fixture == 'true'",
    );
    assert.equal(step["continue-on-error"], undefined);
  }
  const functional = browser
    .split("      - name: Functional journeys\n")[1]
    ?.split("      - name:")[0];
  assert.ok(functional, "functional step must exist");
  assert.doesNotMatch(functional, /^ {8}(if|continue-on-error):/m);
  assert.doesNotMatch(functional, /(?:\s|^)--list(?:[=\s]|$)/);
  assert.match(functional, /--reporter=list,json/);
  assert.match(
    job("measurements"),
    /-- pnpm test:browser:ci --project '\*-measurements' --workers=1 --reporter=list,json$/m,
  );
  assert.equal(config.workers, 2);
  assert.equal(config.retries, 0);
  assert.ok(!config.fullyParallel);
  const projects = Object.fromEntries(
    config.projects.map((project) => [project.name, project]),
  );
  assert.equal(projects["chromium-measurements"].workers, 1);
  assert.equal(projects["webkit-measurements"].workers, 1);
  assert.deepEqual(projects["webkit-measurements"].dependencies, [
    "chromium-measurements",
  ]);
  for (const engine of ["chromium", "webkit"])
    assert.deepEqual(projects[engine].dependencies, ["webkit-measurements"]);
});

test("workflow shards discover every functional test/project exactly once", (t) => {
  const command = browser.match(
    /^ {8}run: .+ -- (pnpm test:browser:ci .+)$/m,
  )?.[1];
  assert.ok(command, "functional invocation must exist");
  const selectedIds = (report) => {
    assert.deepEqual(report.errors, []);
    const collect = (suites) =>
      suites.flatMap((suite) => [
        ...suite.specs.flatMap((spec) =>
          spec.tests.map((entry) => {
            assert.ok(
              ["chromium", "webkit"].includes(entry.projectName),
              "no measurements on functional runners",
            );
            return `${entry.projectName}:${spec.id}`;
          }),
        ),
        ...collect(suite.suites ?? []),
      ]);
    return collect(report.suites);
  };
  const expected = selectedIds(
    JSON.parse(
      run("pnpm", [
        "--silent",
        "test:browser:ci",
        "--project",
        "chromium",
        "--project",
        "webkit",
        "--no-deps",
        "--list",
        "--reporter=json",
      ]),
    ),
  );
  const discovery = parse(workflow).jobs.browser.steps.find(
    (step) => step.id === "browser-setup",
  );
  const directory = mkdtempSync(join(tmpdir(), "buzz-browser-selection-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, "output");
  const nativeProjects = [];
  assert.ok(expected.length > 0);
  const actual = [];
  for (const engine of matrixValues("engine")) {
    for (const shard of matrixValues("shard")) {
      // Exercise the actual workflow command, including its shard denominator.
      const expanded = command
        .replaceAll(/\$\{\{ matrix\.engine \}\}/g, engine)
        .replaceAll(/\$\{\{ matrix\.shard \}\}/g, shard);
      const script = discovery.run
        .replaceAll(/\$\{\{ matrix\.engine \}\}/g, engine)
        .replaceAll(/\$\{\{ matrix\.shard \}\}/g, shard);
      assert.equal(
        script.split("\n")[0].split(" --list")[0],
        expanded
          .replace("pnpm ", "pnpm --silent ")
          .replace(" --reporter=list,json", ""),
        "discovery and execution must use identical test selection",
      );
      writeFileSync(output, "");
      const result = spawnSync("bash", ["-e", "-c", script], {
        env: { ...process.env, RUNNER_TEMP: directory, GITHUB_OUTPUT: output },
        encoding: "utf8",
        timeout: 30000,
      });
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(
        readFileSync(join(directory, "browser-selection.json"), "utf8"),
      );
      const selected = selectedIds(report);
      // Assert against the actual native owner, independently of its setup tag.
      const includesNative = report.suites.some(
        (suite) => suite.file === "conversation.spec.mjs",
      );
      assert.equal(
        readFileSync(output, "utf8"),
        `native-fixture=${includesNative}\n`,
      );
      if (includesNative) nativeProjects.push(engine);
      assert.ok(selected.length > 0, `${engine}/${shard} must select tests`);
      assert.ok(selected.every((id) => id.startsWith(`${engine}:`)));
      actual.push(...selected);
      t.diagnostic(`${engine}/${shard}: ${selected.length} functional tests`);
    }
  }
  assert.deepEqual(nativeProjects, ["chromium", "webkit"]);
  assert.equal(
    new Set(actual).size,
    actual.length,
    "no duplicate test/project across shards",
  );
  assert.deepEqual(
    actual.sort(),
    expected.sort(),
    "matrix must cover unsharded discovery",
  );
});

test("automatic CI stays on Linux and manual dispatch runs only Windows", () => {
  const { jobs } = parse(workflow);
  for (const lane of ["javascript", "native", "measurements", "browser"]) {
    assert.equal(jobs[lane].if, "github.event_name != 'workflow_dispatch'");
    assert.equal(jobs[lane]["runs-on"], "ubuntu-24.04");
  }
  const windows = jobs["windows-native"];
  assert.equal(windows.if, "github.event_name == 'workflow_dispatch'");
  assert.equal(windows["runs-on"], "windows-2025");
  assert.ok(
    windows.steps.some(
      (step) => step.run === "cargo test -p buzz-foundation --locked",
    ),
    "on-demand Windows validation retains the complete native package tests",
  );
});

test("required gate executes its real shell and rejects every unsuccessful lane", () => {
  const required = job("required");
  const { jobs } = parse(workflow);
  assert.equal(
    jobs.required.name,
    `\${{ github.event_name == 'workflow_dispatch' && 'Automatic CI (not requested)' || 'CI required' }}`,
  );
  assert.equal(
    jobs.required.if,
    "always() && github.event_name != 'workflow_dispatch'",
  );
  assert.doesNotMatch(required, /^ {8}if:/m);
  assert.match(
    required,
    /^ {4}needs: \[javascript, native, measurements, browser\]$/m,
  );
  assert.doesNotMatch(required, /continue-on-error/);
  const lanes = ["JAVASCRIPT", "NATIVE", "MEASUREMENTS", "BROWSER"];
  for (const lane of lanes)
    assert.ok(
      required.includes(
        `${lane}: \${{ needs.${lane.toLowerCase().replaceAll("_", "-")}.result }}`,
      ),
    );
  const script = required.match(/^ {8}run: \|\n((?: {10}.+\n?)+)/m)?.[1];
  assert.ok(script, "required shell must exist");
  const execute = (results) =>
    spawnSync("bash", ["-e", "-c", script], {
      env: { PATH: process.env.PATH, ...results },
      encoding: "utf8",
      timeout: 5000,
    });
  const success = Object.fromEntries(lanes.map((lane) => [lane, "success"]));
  assert.equal(execute(success).status, 0);
  for (const lane of lanes) {
    for (const result of ["failure", "skipped", "cancelled", "", undefined]) {
      const results = { ...success, [lane]: result };
      if (result === undefined) delete results[lane];
      assert.equal(execute(results).status, 1, `${lane}=${result} must fail`);
    }
  }
});

test("Hermit cache keys distinguish jobs that provision different tools", () => {
  const setup = read(".github/actions/setup/action.yml");
  assert.match(setup, /key: hermit-.*\$\{\{ github\.job \}\}/);
});

test("browser cache follows the installed Playwright version, not unrelated dependency edits", (t) => {
  const { steps } = parse(read(".github/actions/setup/action.yml")).runs;
  const version = steps.find((step) => step.id === "playwright");
  const cache = steps.find((step) => step.name === "Cache Playwright engines");
  const install = steps.find(
    (step) => step.name === "Install pinned browser engines and libraries",
  );
  assert.ok(version, "resolve the installed version after the frozen install");
  assert.ok(
    steps.findIndex((step) => step.run === "pnpm install --frozen-lockfile") <
      steps.indexOf(version),
  );
  assert.ok(steps.indexOf(version) < steps.indexOf(cache));
  assert.ok(steps.indexOf(cache) < steps.indexOf(install));
  for (const step of [version, cache, install])
    assert.equal(step.if, "inputs.browsers != ''");
  assert.equal(install.env.BROWSERS, `\${{ inputs.browsers }}`);
  assert.equal(
    cache.with.key,
    `playwright-\${{ runner.os }}-\${{ runner.arch }}-\${{ steps.playwright.outputs.version }}-\${{ inputs.browsers }}`,
  );
  assert.equal(cache.with["restore-keys"], undefined);

  const cwd = mkdtempSync(join(tmpdir(), "buzz-playwright-version-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const manifest = join(cwd, "node_modules/@playwright/test/package.json");
  const output = join(cwd, "output");
  mkdirSync(dirname(manifest), { recursive: true });
  const resolve = () => {
    writeFileSync(output, "");
    return spawnSync("bash", ["-e", "-c", version.run], {
      cwd,
      env: { ...process.env, GITHUB_OUTPUT: output },
      encoding: "utf8",
      timeout: 5000,
    });
  };
  for (const installed of ["1.60.0", "1.61.0"]) {
    writeFileSync(manifest, JSON.stringify({ version: installed }));
    for (const unrelated of ["before", "after"]) {
      writeFileSync(join(cwd, "pnpm-lock.yaml"), unrelated);
      const result = resolve();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(output, "utf8"), `version=${installed}\n`);
    }
  }
  rmSync(manifest);
  assert.notEqual(
    resolve().status,
    0,
    "missing installation must fail, not cache an empty version",
  );
  assert.equal(readFileSync(output, "utf8"), "");
});

test("browser provisioning installs exactly the requested engines", (t) => {
  const setup = parse(read(".github/actions/setup/action.yml"));
  const { jobs } = parse(workflow);
  assert.equal(setup.inputs.browsers.default, "");
  const inputs = (job) =>
    job.steps.find((step) => step.uses === "./.github/actions/setup").with;
  assert.equal(inputs(jobs.browser).browsers, `\${{ matrix.engine }}`);
  assert.equal(inputs(jobs.measurements).browsers, "chromium webkit");
  for (const name of ["javascript", "native"])
    assert.equal(inputs(jobs[name]), undefined);

  const install = setup.runs.steps.find(
    (step) => step.name === "Install pinned browser engines and libraries",
  );
  const directory = mkdtempSync(join(tmpdir(), "buzz-browser-install-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const args = join(directory, "args");
  writeFileSync(
    join(directory, "pnpm"),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$ARGS"\n',
    { mode: 0o755 },
  );
  for (const browsers of [
    "chromium",
    "webkit",
    "chromium webkit",
    "",
    "firefox",
    "chromium --force",
  ]) {
    rmSync(args, { force: true });
    const result = spawnSync("bash", ["-e", "-c", install.run], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        BROWSERS: browsers,
        ARGS: args,
      },
      encoding: "utf8",
      timeout: 5000,
    });
    if (["chromium", "webkit", "chromium webkit"].includes(browsers)) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        readFileSync(args, "utf8"),
        [
          "exec",
          "playwright",
          "install",
          "--with-deps",
          ...browsers.split(" "),
          "",
        ].join("\n"),
      );
    } else {
      assert.notEqual(result.status, 0);
      assert.throws(() => readFileSync(args), { code: "ENOENT" });
    }
  }
});

test("native setup follows nested discovered tags and rejects incomplete discovery", () => {
  const spec = { tests: [{}], tags: [] };
  const report = { suites: [{ specs: [spec], suites: [] }], errors: [] };
  assert.equal(nativeFixtureRequired(report), false);
  report.suites[0].suites.push({
    specs: [{ ...spec, tags: ["native-fixture"] }],
  });
  assert.equal(nativeFixtureRequired(report), true);
  for (const invalid of [
    {},
    { suites: [], errors: [] },
    { ...report, errors: [{ message: "import failed" }] },
    {
      suites: [{ specs: [{ tests: [], tags: ["native-fixture"] }] }],
      errors: [],
    },
  ])
    assert.throws(() => nativeFixtureRequired(invalid));
});
