import { describe, expect, it } from "vitest";
import {
  chooseLanes,
  hostHint,
  notProven,
  parseArgs,
  parseSelection,
  renderSummary,
  reviewEnv,
  touchesReviewTooling,
  touchesRust,
} from "./review-head.mjs";

describe("parseArgs", () => {
  it("accepts a pull request number or a commit", () => {
    expect(parseArgs(["4085"])).toMatchObject({ pr: 4085, lanes: "auto" });
    expect(parseArgs(["abc1234", "--base=release"])).toMatchObject({
      commit: "abc1234",
      base: "release",
    });
  });

  it("accepts a tag that names a reviewer's own worktree", () => {
    expect(parseArgs(["1", "--tag=mongo"]).tag).toBe("mongo");
  });

  it("collects repeated journeys", () => {
    expect(
      parseArgs(["1", "--browser=a.spec.mjs", "--browser=b.spec.mjs:4"])
        .browser,
    ).toEqual(["a.spec.mjs", "b.spec.mjs:4"]);
  });

  it.each([
    [[]],
    [["1", "2"]],
    [["main"]],
    [["1", "--lanes=static,nope"]],
    [["1", "--unknown=x"]],
    [["1", "--tag=../x"]],
    [["1", "--browser=--grep=x"]],
  ])("rejects %j", (argv) => {
    expect(() => parseArgs(argv)).toThrow(/usage/);
  });
});

describe("chooseLanes", () => {
  const files = ["src/app/App.tsx"];

  it("runs Rust only when Rust changed and browser only with a journey", () => {
    expect(chooseLanes("auto", { files, browser: [] })).toEqual([
      "static",
      "tests",
    ]);
    expect(
      chooseLanes("auto", {
        files: [...files, "src-tauri/src/lib.rs"],
        browser: ["tests/browser/startup.spec.mjs:3"],
      }),
    ).toEqual(["static", "tests", "rust", "browser"]);
  });

  it("honors explicit, all and full selections", () => {
    expect(chooseLanes("rust", { files, browser: [] })).toEqual(["rust"]);
    expect(chooseLanes("all", { files, browser: [] })).toHaveLength(4);
    expect(chooseLanes("full", { files, browser: [] })).toEqual(["full"]);
  });
});

it("recognizes Rust paths", () => {
  expect(touchesRust(["Cargo.lock"])).toBe(true);
  expect(touchesRust(["crates/x/src/lib.rs"])).toBe(true);
  expect(touchesRust(["src/bundled/x/compute/Cargo.toml"])).toBe(true);
  expect(touchesRust(["src/bundled/x/compute/src/main.rs"])).toBe(true);
  expect(touchesRust([".cargo/config.toml"])).toBe(true);
  expect(touchesRust(["docs/cargo.md", "src/Cargo.tsx"])).toBe(false);
});

it("flags changes to the tooling that sets up and selects the run", () => {
  expect(
    touchesReviewTooling([
      "scripts/flake-check.mjs",
      "scripts/flake-check-costs.json",
      "bin/pnpm",
      "scripts/other.mjs",
      "src/bin/x.ts",
    ]),
  ).toEqual([
    "scripts/flake-check.mjs",
    "scripts/flake-check-costs.json",
    "bin/pnpm",
  ]);
});

it("passes the reviewed code no tokens or CI flag", () => {
  const env = reviewEnv(
    {
      PATH: "/usr/bin",
      HOME: "/h",
      HTTPS_PROXY: "http://proxy",
      GH_TOKEN: "x",
      GITHUB_TOKEN: "x",
      AWS_SECRET_ACCESS_KEY: "x",
      SSH_AUTH_SOCK: "/s",
      CI: "true",
    },
    "/wt",
  );
  expect(env).toEqual({
    PATH: "/wt/bin:/usr/bin",
    HOME: "/h",
    HTTPS_PROXY: "http://proxy",
  });
});

it("parses flake-check output and drops duplicates", () => {
  expect(
    parseSelection(
      "noise\nvitest=a.test.ts b.test.ts\nbrowser=x.spec.mjs:4 x.spec.mjs:4\nbrowser_shards=[1]\n",
    ),
  ).toEqual({ vitest: ["a.test.ts", "b.test.ts"], browser: ["x.spec.mjs:4"] });
  expect(parseSelection("vitest=\nbrowser=\n")).toEqual({
    vitest: [],
    browser: [],
  });
});

it("names what each platform leaves unproven", () => {
  const linux = notProven("linux", ["static", "tests"]).join("\n");
  expect(linux).toMatch(/@media-recorder/);
  expect(linux).toMatch(/No browser journey ran/);
  expect(linux).toMatch(/Rust checks were skipped/);
  const mac = notProven("darwin", ["full"]).join("\n");
  expect(mac).not.toMatch(/@media-recorder|No browser journey|Rust checks/);
  expect(mac).toMatch(/just desktop/);
  const flagged = notProven("darwin", ["static"], {
    rustChanged: true,
    tooling: ["bin/pnpm"],
    remote: "unknown",
  }).join("\n");
  expect(flagged).toMatch(/Rust paths changed, but/);
  expect(flagged).toMatch(/review tooling \(bin\/pnpm\)/);
  expect(flagged).toMatch(/could not be re-read/);
});

it("renders a summary that a review body can quote", () => {
  const summary = renderSummary({
    pr: 7,
    head: "a".repeat(40),
    base: { ref: "main", sha: "b".repeat(40) },
    mergeBase: "c".repeat(40),
    host: { platform: "linux", arch: "arm64" },
    changedFiles: ["src/a.ts"],
    selection: { vitest: ["src/a.test.ts"], browser: [] },
    lanes: [
      {
        name: "static",
        status: "passed",
        reason: "",
        seconds: 12.4,
        commands: [{ display: "bin/pnpm check", exit: 0 }],
      },
      {
        name: "browser",
        status: "skipped",
        reason: "no journey selected",
        seconds: 0,
        commands: [],
      },
    ],
    final: { headUnchanged: true, remoteHeadUnchanged: false, treeClean: true },
    notProven: ["gap"],
    result: "failed",
  });
  expect(summary).toContain("PR #7 at `aaaaaaaaaaaa`");
  expect(summary).toContain(
    "| static | ✅ passed | 12s | `bin/pnpm check` → 0 |",
  );
  expect(summary).toContain("⏭ skipped: no journey selected");
  expect(summary).toContain("remote ❌ moved");
  expect(summary).toContain("- gap");
  expect(
    renderSummary({
      pr: 7,
      head: "a".repeat(40),
      base: { ref: "main", sha: "b".repeat(40) },
      mergeBase: "c".repeat(40),
      host: { platform: "linux", arch: "arm64" },
      changedFiles: [],
      selection: { vitest: [], browser: [] },
      lanes: [],
      final: {
        headUnchanged: true,
        remoteHeadUnchanged: "unknown",
        treeClean: true,
      },
      notProven: [],
      result: "passed",
    }),
  ).toContain("remote ⚠ unchecked");
});

it("names the host fix instead of blaming the change", () => {
  expect(
    hostHint("x\nHost system is missing dependencies to run browsers."),
  ).toMatch(/install-deps chromium webkit/);
  expect(hostHint("pkg-config exited with status code 1")).toMatch(/ci\.yml/);
  expect(hostHint("AssertionError: 1 !== 0")).toBeUndefined();
});
