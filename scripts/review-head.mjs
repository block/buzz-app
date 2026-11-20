// Review one pull request or commit at its exact head, in its own worktree,
// and write an evidence bundle: receipt.json (machine-readable) and summary.md
// (for a review body). It runs the gates a reviewer needs for that change, not
// the whole CI matrix: static checks, the Vitest tests and Playwright journeys
// `flake-check.mjs select` maps the diff to, and Rust checks when Rust changed.
// Run it from a trusted checkout. The reviewed code runs as you, with only the
// environment variables in ENV_ALLOW; it is not containment for hostile code,
// so use a disposable machine for authors you do not trust.
import { spawnSync } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, release } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");

export const LANES = ["static", "tests", "rust", "browser"];
const BUNDLE = ["receipt.json", "summary.md", "logs", "browser"];
// Failures that mean this host lacks system packages CI's runners provide,
// not that the change is wrong. Each names the one-time fix.
export const HOST_HINTS = [
  [
    "Host system is missing dependencies",
    "this host lacks browser system libraries; run `sudo bin/pnpm exec playwright install-deps chromium webkit` once",
  ],
  [
    "pkg-config exited with status code",
    "this host lacks the native build libraries CI installs; see the apt step in .github/workflows/ci.yml",
  ],
];
export const hostHint = (text) =>
  HOST_HINTS.find(([pattern]) => text.includes(pattern))?.[1];
const USAGE =
  "usage: review-head <pr-number|commit> [--base=<ref>] [--lanes=auto|all|full|<lane,…>] [--browser=<spec[:line]>]… [--out=<dir>] [--tag=<name>]";

export function parseArgs(argv) {
  const options = {
    base: undefined,
    lanes: "auto",
    browser: [],
    out: "",
    tag: "",
  };
  const operands = [];
  for (const argument of argv) {
    const [, name, value] = /^--([a-z]+)=(.*)$/.exec(argument) ?? [];
    if (name === "base" && value) options.base = value;
    else if (name === "lanes" && value) options.lanes = value;
    else if (name === "browser" && /^[^-]/.test(value))
      options.browser.push(value);
    else if (name === "out" && value) options.out = value;
    else if (name === "tag" && /^[\w-]+$/.test(value)) options.tag = value;
    else if (argument.startsWith("--")) throw new Error(USAGE);
    else operands.push(argument);
  }
  if (operands.length !== 1) throw new Error(USAGE);
  const [target] = operands;
  if (/^\d+$/.test(target)) options.pr = Number(target);
  else if (/^[0-9a-f]{7,40}$/i.test(target)) options.commit = target;
  else throw new Error(USAGE);
  const lanes = options.lanes.split(",");
  if (
    !["auto", "all", "full"].includes(options.lanes) &&
    !lanes.every((lane) => LANES.includes(lane))
  )
    throw new Error(USAGE);
  return options;
}

// Workspace members live outside crates/ too, so any manifest or source counts.
export const touchesRust = (files) =>
  files.some((file) =>
    /^(?:crates\/|src-tauri\/|\.cargo\/|rust-toolchain(?:\.toml)?$|(?:deny|clippy|\.?rustfmt)\.toml$)|(?:^|\/)Cargo\.(?:toml|lock)$|\.rs$/.test(
      file,
    ),
  );

// Setup and test selection run from the reviewed worktree, so a change to them
// decides what this run checks.
export const touchesReviewTooling = (files) =>
  files.filter((file) =>
    /^(?:bin\/|scripts\/(?:bootstrap-worktree\.sh|flake-check[\w.-]*|review-head[\w.-]*)$)/.test(
      file,
    ),
  );

// What the reviewed code may see. Everything else, tokens included, is dropped.
const ENV_ALLOW =
  /^(?:PATH|HOME|USER|LOGNAME|SHELL|SHLVL|TERM|TMPDIR|TMP|TEMP|LANG|LC_\w+|TZ|DISPLAY|WAYLAND_DISPLAY|XDG_\w+|HERMIT_\w+|CARGO_HOME|RUSTUP_HOME|PNPM_HOME|PLAYWRIGHT_BROWSERS_PATH|BUZZ_TEST_WORKERS|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|(?:HTTPS?|ALL|NO)_PROXY|(?:https?|all|no)_proxy)$/;
export const reviewEnv = (env, worktree) => ({
  ...Object.fromEntries(
    Object.entries(env).filter(([name]) => ENV_ALLOW.test(name)),
  ),
  PATH: `${worktree}/bin:${env.PATH ?? ""}`,
});

// `auto` always runs static checks and the tests the diff reaches; Rust and
// browser lanes run only when there is something for them to prove.
export function chooseLanes(lanes, { files, browser }) {
  if (lanes === "full") return ["full"];
  if (lanes === "all") return LANES;
  if (lanes !== "auto") return lanes.split(",");
  return LANES.filter(
    (lane) =>
      (lane !== "rust" || touchesRust(files)) &&
      (lane !== "browser" || browser.length > 0),
  );
}

// flake-check prints `key=value` lines; entries are space-separated.
export function parseSelection(text) {
  const selection = { vitest: [], browser: [] };
  for (const line of text.split("\n")) {
    const [, key, value] = /^(vitest|browser)=(.*)$/.exec(line) ?? [];
    if (key) selection[key] = [...new Set(value.split(" ").filter(Boolean))];
  }
  return selection;
}

// What a passing run here still does not establish. Headless journeys drive
// the built frontend against fixture relays and a mocked host bridge.
export function notProven(
  os,
  lanes,
  { rustChanged = false, tooling = [], remote } = {},
) {
  const gaps = [
    "The shipped desktop host: Tauri commands, signing and IPC enforcement are not exercised by headless journeys.",
  ];
  if (os === "linux")
    gaps.push(
      "macOS WebKit behavior: @media-recorder and the documented local-only WebKit cases (docs/browser-testing.md) do not run on Linux.",
      "Native windowing, input, focus, menus and rendering (WKWebView, AppKit).",
    );
  else if (os === "darwin")
    gaps.push(
      "Native windowing, input and focus: run `just desktop` and exercise the change by hand.",
    );
  else gaps.push(`Platform ${os}: browser engine coverage was not calibrated.`);
  if (!lanes.includes("browser") && !lanes.includes("full"))
    gaps.push(
      "No browser journey ran. Name journeys with --browser=<spec[:line]> to exercise UI behavior.",
    );
  if (!lanes.includes("rust") && !lanes.includes("full"))
    gaps.push(
      rustChanged
        ? "Rust paths changed, but the Rust checks did not run."
        : "Rust checks were skipped because no Rust paths changed.",
    );
  if (tooling.length)
    gaps.push(
      `This change edits the review tooling (${tooling.join(", ")}); setup and test selection ran its own versions.`,
    );
  if (remote === "unknown")
    gaps.push("The pull request head on the remote could not be re-read.");
  return gaps;
}

export function renderSummary(receipt) {
  const mark = { passed: "✅", failed: "❌", skipped: "⏭" };
  const short = (sha) => sha.slice(0, 12);
  const subject = receipt.pr ? `PR #${receipt.pr}` : "commit";
  const lines = [
    `## Review evidence: ${subject} at \`${short(receipt.head)}\``,
    "",
    `**Result:** ${receipt.result} · base \`${receipt.base.ref}\` at \`${short(receipt.base.sha)}\` (merge base \`${short(receipt.mergeBase)}\`) · ${receipt.host.platform}/${receipt.host.arch}`,
    "",
    "| Lane | Result | Time | Commands |",
    "| --- | --- | ---: | --- |",
    ...receipt.lanes.map(
      (lane) =>
        `| ${lane.name} | ${mark[lane.status]} ${lane.status}${lane.reason ? `: ${lane.reason}` : ""} | ${Math.round(lane.seconds)}s | ${lane.commands.map((command) => `\`${command.display}\` → ${command.exit}`).join("<br>") || "—"} |`,
    ),
    "",
    `**Exact head held:** worktree ${receipt.final.headUnchanged ? "✅" : "❌"} · remote ${{ null: "n/a", unknown: "⚠ unchecked", true: "✅", false: "❌ moved" }[receipt.final.remoteHeadUnchanged]} · tree clean ${receipt.final.treeClean ? "✅" : "❌"}`,
    "",
    `**Selected:** ${receipt.selection.vitest.length} Vitest file(s), ${receipt.selection.browser.length} browser journey(s), ${receipt.changedFiles.length} changed file(s).`,
    "",
    "**Not proven by this run:**",
    ...receipt.notProven.map((gap) => `- ${gap}`),
    "",
  ];
  return lines.join("\n");
}

function git(args, cwd = root) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function capture(command, args, cwd = root, env = process.env) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function resolveTarget(options) {
  const remote = "origin";
  if (options.pr) {
    const ref = `refs/review/pr-${options.pr}`;
    git(["fetch", "--no-tags", remote, `+refs/pull/${options.pr}/head:${ref}`]);
    const base =
      options.base ??
      capture("gh", [
        "pr",
        "view",
        String(options.pr),
        "--json",
        "baseRefName",
        "--jq",
        ".baseRefName",
      ]);
    if (!base)
      throw new Error(
        `could not read the base of #${options.pr} with gh; pass --base=<ref>`,
      );
    return { remote, ref, head: git(["rev-parse", `${ref}^{commit}`]), base };
  }
  return {
    remote,
    head: git(["rev-parse", `${options.commit}^{commit}`]),
    base: options.base ?? "main",
  };
}

function remoteHead(target, pr) {
  if (!pr) return null;
  const line = capture("git", [
    "ls-remote",
    target.remote,
    `refs/pull/${pr}/head`,
  ]);
  return line ? line.split(/\s+/)[0] === target.head : "unknown";
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const target = resolveTarget(options);
  git(["fetch", "--no-tags", target.remote, target.base]);
  const baseSha = git(["rev-parse", "FETCH_HEAD^{commit}"]);
  const mergeBase = git(["merge-base", baseSha, target.head]);
  // Reviewers sharing one machine tag their runs so worktrees never collide.
  const label = `${options.pr ? `pr-${options.pr}` : "commit"}-${target.head.slice(0, 12)}${options.tag ? `-${options.tag}` : ""}`;
  const worktree = join(dirname(root), `${basename(root)}-review-${label}`);
  const out = options.out || join(root, "test-results", "review", label);

  if (existsSync(worktree)) {
    if (git(["rev-parse", "HEAD"], worktree) !== target.head)
      throw new Error(`${worktree} exists at a different commit; remove it`);
    if (git(["status", "--porcelain"], worktree))
      throw new Error(`${worktree} has local changes; remove it`);
  } else git(["worktree", "add", "--detach", worktree, target.head]);
  // Replace only an earlier bundle (finished or interrupted), never a
  // directory someone named by mistake.
  if (
    existsSync(out) &&
    readdirSync(out).some((name) => !BUNDLE.includes(name))
  )
    throw new Error(
      `${out} holds files that are not review evidence; choose another --out`,
    );
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "logs"), { recursive: true });
  // A reused worktree keeps earlier browser results; they must not leak in.
  rmSync(join(worktree, "test-results", "browser"), {
    recursive: true,
    force: true,
  });

  // Hermit proxies first, so every tool is the pinned one. CI is dropped with
  // the rest: it would switch fixtures to CI-only artifacts.
  const env = reviewEnv(process.env, worktree);
  const lanes = [];
  const runLane = (name, commands, reason = "") => {
    const lane = { name, status: "skipped", reason, seconds: 0, commands: [] };
    lanes.push(lane);
    if (commands.length === 0) return lane;
    lane.status = "passed";
    for (const argv of commands) {
      const log = join(out, "logs", `${name}-${lane.commands.length + 1}.log`);
      const fd = openSync(log, "w");
      const started = Date.now();
      const result = spawnSync(argv[0], argv.slice(1), {
        cwd: worktree,
        env,
        stdio: ["ignore", fd, fd],
      });
      closeSync(fd);
      const seconds = (Date.now() - started) / 1000;
      const exit = result.status ?? `signal ${result.signal}`;
      const display = argv.join(" ").replace(`${worktree}/`, "");
      lane.commands.push({ argv, display, exit, seconds, log });
      lane.seconds += seconds;
      console.log(
        `review-head: ${name}: ${display} → ${exit} (${Math.round(seconds)}s)`,
      );
      if (exit !== 0) {
        lane.status = "failed";
        const text = readFileSync(log, "utf8");
        lane.reason = hostHint(text) ?? "";
        console.log(text.split("\n").slice(-40).join("\n"));
        break;
      }
    }
    return lane;
  };

  const setup = runLane("setup", [["scripts/bootstrap-worktree.sh", root]]);
  const files = git(["diff", "--name-only", mergeBase, target.head], worktree)
    .split("\n")
    .filter(Boolean);
  let selection = { vitest: [], browser: [] };
  let chosen = [];
  if (setup.status === "passed") {
    const selected = capture(
      "bin/node",
      ["scripts/flake-check.mjs", "select", mergeBase, target.head],
      worktree,
      { ...env, GITHUB_OUTPUT: "" },
    );
    if (selected === undefined) throw new Error("flake-check select failed");
    selection = parseSelection(selected);
    selection.browser = [
      ...new Set([...selection.browser, ...options.browser]),
    ];
    chosen = chooseLanes(options.lanes, { files, browser: selection.browser });
    const pnpm = "bin/pnpm";
    // Linux uses CI's selection, which leaves macOS-only WebKit cases out.
    const config =
      platform() === "linux"
        ? "tests/browser/playwright.ci.config.mjs"
        : "tests/browser/playwright.config.mjs";
    const plan = {
      full: [["bin/just", "scan"]],
      static: [
        [pnpm, "check"],
        [pnpm, "exec", "vite", "build"],
      ],
      tests: [
        ["bin/node", "--test", "tests/integration/*.test.mjs"],
        ...(selection.vitest.length
          ? [[pnpm, "exec", "vitest", "run", ...selection.vitest]]
          : []),
      ],
      rust: [
        ["bin/cargo", "fmt", "--all", "--check"],
        [
          "bin/cargo",
          "clippy",
          "--workspace",
          "--locked",
          "--all-targets",
          "--",
          "-D",
          "warnings",
        ],
        ["bin/cargo", "test", "--workspace", "--locked"],
      ],
      // An empty selection would run the whole suite; that is `full`.
      browser:
        selection.browser.length === 0
          ? []
          : [
              [pnpm, "test:browser:install"],
              [
                pnpm,
                "exec",
                "playwright",
                "test",
                "--config",
                config,
                "--project",
                "chromium",
                "--project",
                "webkit",
                "--no-deps",
                "--workers=2",
                ...selection.browser,
              ],
            ],
    };
    for (const name of [...LANES, "full"])
      if (chosen.includes(name))
        runLane(
          name,
          plan[name],
          plan[name].length ? "" : "no journey selected",
        );
      else if (name !== "full" && options.lanes !== "full")
        runLane(
          name,
          [],
          options.lanes !== "auto"
            ? "excluded by --lanes"
            : name === "browser"
              ? "no journey selected"
              : "not needed for this diff",
        );
    const results = join(worktree, "test-results", "browser");
    if (existsSync(results))
      cpSync(results, join(out, "browser"), { recursive: true });
  }

  const headUnchanged = git(["rev-parse", "HEAD"], worktree) === target.head;
  const treeClean = git(["status", "--porcelain"], worktree) === "";
  const remoteHeadUnchanged = remoteHead(target, options.pr);
  const passed =
    lanes.every((lane) => lane.status !== "failed") &&
    headUnchanged &&
    treeClean &&
    remoteHeadUnchanged !== false;
  const receipt = {
    schema: 1,
    repository: capture("git", ["remote", "get-url", target.remote], root),
    pr: options.pr ?? null,
    head: target.head,
    base: { ref: target.base, sha: baseSha },
    mergeBase,
    worktree,
    changedFiles: files,
    selection,
    host: { platform: platform(), arch: arch(), release: release() },
    tools: {
      node: capture("bin/node", ["--version"], worktree, env),
      pnpm: capture("bin/pnpm", ["--version"], worktree, env),
      rustc: capture("bin/rustc", ["--version"], worktree, env),
      // pnpm may print install chatter first; the version is the last line.
      playwright: capture(
        "bin/pnpm",
        ["exec", "playwright", "--version"],
        worktree,
        env,
      )
        ?.split("\n")
        .at(-1),
    },
    lanes,
    final: { headUnchanged, remoteHeadUnchanged, treeClean },
    notProven: notProven(platform(), chosen, {
      rustChanged: touchesRust(files),
      tooling: touchesReviewTooling(files),
      remote: remoteHeadUnchanged,
    }),
    result: passed ? "passed" : "failed",
    finishedAt: new Date().toISOString(),
  };
  writeFileSync(
    join(out, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  writeFileSync(join(out, "summary.md"), renderSummary(receipt));
  console.log(`review-head: ${receipt.result}; evidence in ${out}`);
  process.exitCode = passed ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
