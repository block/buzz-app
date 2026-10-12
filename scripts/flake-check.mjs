// Advisory pull-request flake check. `select` maps a diff to the Vitest tests
// and Playwright journeys it changed; `vitest` repeats a selection and reports
// every iteration. Playwright repeats natively with --repeat-each.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVitest } from "./ci-test-report.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const pnpm = `${root}bin/pnpm`;
export const ITERATIONS = 10;
// Journeys that need their own project or platform: the measurements job and
// the macOS recorder own them, so the engine lanes never repeat them.
const excludedTags = ["classic-scrollbars", "local-webkit", "media-recorder"];

// Mirrors vitest.config.ts `include` and the Playwright testDir/testMatch.
// Paths are later split on whitespace in a shell, so admit only plain names.
export function classify(file) {
  if (!/^[\w./@-]+$/.test(file)) return undefined;
  if (
    /^(?:src\/.*\.test\.(?:ts|tsx|mjs)|browser-host\/.*\.test\.mjs|scripts\/.*\.test\.(?:ts|mjs)|tests\/fixtures\/design-system\/.*\.test\.(?:ts|tsx))$/.test(
      file,
    )
  )
    return "vitest";
  if (/^tests\/browser\/[^/]+\.spec\.mjs$/.test(file)) return "browser";
  return undefined;
}

// New-side line ranges of a -U0 diff. A pure deletion has no new lines and
// attaches to the line before it (0 at the top of the file).
export function hunkRanges(diff) {
  return [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].map(
    ([, start, count = "1"]) => ({
      start: Number(start),
      end: Number(start) + Math.max(Number(count), 1) - 1,
    }),
  );
}

// A test owns the lines from its start to the next test's start. Hunks inside
// tests select those tests. A hunk before the first test (imports, helpers,
// hooks, module constants) can change every test, so it, a new file, or a file
// with no listed tests selects the whole file.
export function selectTests(ranges, starts, { added = false } = {}) {
  const sorted = [...new Set(starts)].sort((a, b) => a - b);
  if (added) return { whole: true, reason: "new file" };
  if (sorted.length === 0) return { whole: true, reason: "no tests listed" };
  const selected = new Set();
  for (const { start, end } of ranges) {
    const owner = sorted.findLast((line) => line <= start);
    if (owner === undefined)
      return { whole: true, reason: "shared code changed" };
    selected.add(owner);
    for (const line of sorted)
      if (line > start && line <= end) selected.add(line);
  }
  return { lines: [...selected].sort((a, b) => a - b) };
}

export const repeatableLines = (specs) =>
  specs
    .filter((spec) => !spec.tags.some((tag) => excludedTags.includes(tag)))
    .map((spec) => spec.line);

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
};
const git = (...args) => {
  const result = run("git", args);
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
  return result.stdout;
};
const summarize = (text) => {
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  else process.stdout.write(text);
};
const cell = (value) => String(value).replaceAll("|", "\\|");

// Test start lines per file. Vitest filters are substrings, so an argument may
// list neighbouring files too; those drop out of the map.
function listVitest(files) {
  const result = run(pnpm, [
    "--silent",
    "exec",
    "vitest",
    "list",
    "--json",
    "--includeTaskLocation",
    ...files,
  ]);
  if (result.status !== 0) throw new Error(`vitest list: ${result.stderr}`);
  const starts = new Map(files.map((file) => [file, []]));
  for (const { file, location } of JSON.parse(result.stdout))
    starts.get(relative(root, file))?.push(location.line);
  return starts;
}

// Specs per file as the CI engine project lists them. The engine projects
// ignore measurement files, and Playwright reports a run selecting nothing as
// an error, so a selection of only measurement files lists no specs.
export function listBrowser(files) {
  const result = run(pnpm, [
    "--silent",
    "test:browser:ci",
    "--project",
    "chromium",
    "--no-deps",
    "--list",
    "--reporter=json",
    ...files,
  ]);
  const report = JSON.parse(result.stdout);
  const empty =
    report.errors.length === 1 &&
    /No tests found/.test(report.errors[0].message);
  if (result.status !== 0 && !empty)
    throw new Error(
      `playwright --list: ${report.errors.map((error) => error.message).join("\n")}`,
    );
  const specs = new Map(files.map((file) => [file, []]));
  const collect = (suites) => {
    for (const suite of suites) {
      for (const spec of suite.specs ?? [])
        if (spec.tests?.length)
          specs
            .get(`tests/browser/${spec.file}`)
            ?.push({ line: spec.line, tags: spec.tags });
      collect(suite.suites ?? []);
    }
  };
  collect(empty ? [] : report.suites);
  return specs;
}

function select(base = "HEAD^1", head = "HEAD") {
  const changed = git(
    "diff",
    "--name-status",
    "--no-renames",
    "-z",
    "--diff-filter=AM",
    base,
    head,
    "--",
  ).split("\0");
  const files = { vitest: [], browser: [] };
  const added = new Set();
  for (let i = 0; i + 1 < changed.length; i += 2) {
    const [status, file] = [changed[i], changed[i + 1]];
    const runner = classify(file);
    if (runner) files[runner].push(file);
    if (status === "A") added.add(file);
  }
  const vitestStarts = files.vitest.length
    ? listVitest(files.vitest)
    : new Map();
  const browserSpecs = files.browser.length
    ? listBrowser(files.browser)
    : new Map();
  const outputs = { vitest: [], browser: [] };
  const rows = [];
  for (const runner of ["vitest", "browser"]) {
    for (const file of files[runner]) {
      const specs = browserSpecs.get(file) ?? [];
      const starts =
        runner === "vitest"
          ? vitestStarts.get(file)
          : specs.map((spec) => spec.line);
      const selection = selectTests(
        hunkRanges(git("diff", "-U0", "--no-color", base, head, "--", file)),
        starts,
        { added: added.has(file) },
      );
      let entries;
      let note;
      if (runner === "vitest") {
        entries = selection.whole
          ? [file]
          : selection.lines.map((line) => `${file}:${line}`);
        note = selection.whole
          ? `whole file (${selection.reason})`
          : `${selection.lines.length} changed test(s)`;
      } else {
        const repeatable = repeatableLines(specs);
        const lines = selection.whole
          ? repeatable
          : selection.lines.filter((line) => repeatable.includes(line));
        entries = lines.map((line) => `${file}:${line}`);
        note =
          lines.length === 0
            ? "excluded (measurement or tagged journeys only)"
            : selection.whole
              ? `whole file (${selection.reason}): ${lines.length} journey(s)`
              : `${lines.length} changed journey(s)`;
      }
      outputs[runner].push(...entries);
      rows.push(`| ${cell(file)} | ${runner} | ${cell(note)} |`);
    }
  }
  summarize(
    [
      "## Flake check selection",
      "",
      ...(rows.length
        ? ["| File | Runner | Selection |", "| --- | --- | --- |", ...rows]
        : ["No Vitest or Playwright test files changed."]),
      "",
      "",
    ].join("\n"),
  );
  const text = Object.entries(outputs)
    .map(([key, entries]) => `${key}=${entries.join(" ")}\n`)
    .join("");
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, text);
  else process.stdout.write(text);
}

// Vitest has no repeat flag (--retry hides flakes instead), so run the
// selection once per iteration; each run is a fresh worker.
function repeatVitest(filters, iterations) {
  const dir = `${root}test-results/flake/vitest`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const runs = [];
  for (let i = 1; i <= iterations; i += 1) {
    const outputFile = `${dir}/iter-${i}.json`;
    const result = spawnSync(
      pnpm,
      [
        "exec",
        "vitest",
        "run",
        ...filters,
        "--reporter=default",
        "--reporter=json",
        `--outputFile=${outputFile}`,
      ],
      { cwd: root, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    const statuses = new Map();
    let ok = false;
    try {
      const source = JSON.parse(readFileSync(outputFile, "utf8"));
      const report = parseVitest(source);
      for (const file of source.testResults)
        for (const test of file.assertionResults ?? [])
          statuses.set(
            `${relative(root, file.name)} › ${test.fullName}`,
            test.status,
          );
      ok = result.status === 0 && report.complete && report.counts.total > 0;
    } catch {
      ok = false;
    }
    runs.push({ ok, statuses });
    console.log(
      `flake-check: iteration ${i}/${iterations} ${ok ? "passed" : "FAILED"}`,
    );
  }
  const columns = runs.map((_, i) => String(i + 1));
  const mark = (status) =>
    ({ passed: "✅", failed: "❌" })[status] ?? (status ? "⏭" : "—");
  // A file:line filter reports the file's other tests as skipped; omit tests
  // that never ran so the table holds only the repeated ones.
  const ran = (status) => status === "passed" || status === "failed";
  const tests = [
    ...new Set(runs.flatMap((run) => [...run.statuses.keys()])),
  ].filter((test) => runs.some((run) => ran(run.statuses.get(test))));
  const failures = runs.filter((run) => !run.ok).length;
  summarize(
    [
      `## Flake check (Vitest): ${failures} of ${runs.length} iterations failed`,
      "",
      `| Test | ${columns.join(" | ")} | Failed |`,
      `| --- | ${columns.map(() => ":-:").join(" | ")} | ---: |`,
      `| **Run** | ${runs.map((run) => (run.ok ? "✅" : "❌")).join(" | ")} | ${failures}/${runs.length} |`,
      ...tests.sort().map((test) => {
        const statuses = runs.map((run) => run.statuses.get(test));
        return `| ${cell(test)} | ${statuses.map(mark).join(" | ")} | ${statuses.filter((status) => status === "failed").length}/${runs.length} |`;
      }),
      "",
      "",
    ].join("\n"),
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "select" && args.length <= 2) return select(...args);
  if (command === "vitest") {
    const iterations = Number(
      args
        .find((argument) => argument.startsWith("--iterations="))
        ?.slice("--iterations=".length) ?? ITERATIONS,
    );
    const filters = args.filter((argument) => !argument.startsWith("--"));
    if (Number.isInteger(iterations) && iterations > 0 && filters.length > 0)
      return repeatVitest(filters, iterations);
  }
  throw new Error(
    "usage: flake-check select [base] [head] | vitest [--iterations=N] <file[:line]…>",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
