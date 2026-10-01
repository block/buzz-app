import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { jobs } = parse(
  readFileSync(join(root, ".github/workflows/release.yml"), "utf8"),
);
const baseVersion = JSON.parse(
  readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"),
).version.split("-")[0];
const version = `${baseVersion}-preview.42.2`;
const sha = "a".repeat(40);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const assets = {
  macos: [
    `Buzz_${version}_aarch64.dmg`,
    `Buzz_${version}_aarch64.app.tar.gz`,
    `Buzz_${version}_aarch64.app.tar.gz.sig`,
  ],
  windows: [`Buzz_${version}_x64_unsigned.exe`],
  linux: [`Buzz_${version}_amd64.deb`, `Buzz_${version}_x86_64.AppImage`],
};
const assembly = jobs.publish.steps.find((step) =>
  step.run?.includes("sha256sum --check"),
).run;

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "desktop-release-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// These job guards use the common Actions/JavaScript boolean-expression subset.
function selected(
  job,
  inputs = {},
  ref = "refs/heads/main",
  repository = "block/buzz-app",
) {
  return new Function("github", "inputs", `return (${job.if})`)(
    { ref, repository },
    inputs,
  );
}

test("scheduled/manual releases build all platforms; candidates and promotions remain isolated", () => {
  for (const job of [jobs.build, jobs.windows, jobs.linux]) {
    assert.equal(selected(job), true);
    assert.equal(
      selected(job, { candidates: false, promote_version: "" }),
      true,
    );
    assert.equal(selected(job, { promote_version: version }), false);
    assert.equal(selected(job, {}, "refs/heads/main", "fork/buzz-app"), false);
  }
  assert.equal(selected(jobs.build, { candidates: true }), false);
  for (const job of [jobs.windows, jobs.linux]) {
    assert.equal(
      selected(job, { candidates: true }, "refs/heads/feature"),
      true,
    );
    assert.equal(selected(job, {}, "refs/heads/feature"), false);
    assert.equal(job.permissions?.contents, undefined); // read-only workflow default
  }
  assert.deepEqual(jobs.publish.needs, ["build", "windows", "linux"]);
  assert.equal(jobs.publish.if, undefined); // implicit success(): never publish partial builds
  const downloads = jobs.publish.steps.filter((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  assert.deepEqual(
    downloads.map((step) => step.with.path),
    ["build-assets/macos", "build-assets/windows", "build-assets/linux"],
  );
  for (const [index, job] of [jobs.build, jobs.windows, jobs.linux].entries()) {
    assert.equal(downloads[index].with.name, job.steps.at(-1).with.name);
  }
  const publication = jobs.publish.steps.at(-1).run;
  assert.match(
    publication,
    /gh release create "v\$VERSION" release-assets\/\*/,
  );
  assert.match(
    publication,
    /--target "\$SOURCE_SHA" --prerelease --latest=false/,
  );
});

test("existing platform version generators agree for the same run and attempt", (t) => {
  const dir = temp(t);
  const env = {
    ...process.env,
    GITHUB_RUN_NUMBER: "42",
    GITHUB_RUN_ATTEMPT: "2",
    RUNNER_TEMP: dir,
    GITHUB_ENV: join(dir, "env"),
    GITHUB_OUTPUT: join(dir, "outputs"),
    BUZZ_UPDATER_PUBLIC_KEY: "fixture-key",
    BUZZ_UPDATER_ENDPOINT: "https://example.com/feed",
  };
  const macos = jobs.build.steps.find((step) => step.id === "version").run;
  for (const command of [macos, "node scripts/candidate-version.mjs"]) {
    const result = spawnSync("bash", ["-e", "-c", command], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  }
  for (const name of ["release.json", "candidate.json"]) {
    const config = JSON.parse(readFileSync(join(dir, name), "utf8"));
    assert.equal(config.version, version);
    assert.equal(config.bundle.createUpdaterArtifacts, false);
  }
  assert.equal(readFileSync(env.GITHUB_ENV, "utf8"), `VERSION=${version}\n`);
  assert.equal(readFileSync(env.GITHUB_OUTPUT, "utf8"), `version=${version}\n`);
});

function fixture(t) {
  const dir = temp(t);
  for (const [platform, files] of Object.entries(assets)) {
    const path = join(dir, "build-assets", platform);
    mkdirSync(path, { recursive: true });
    for (const file of files) writeFileSync(join(path, file), file);
    writeFileSync(join(path, "SOURCE_COMMIT"), `${sha}\n`);
    writeFileSync(
      join(path, "SHA256SUMS"),
      files
        .filter((file) => !file.endsWith(".sig"))
        .map((file) => `${hash(file)}  ./${file}\n`)
        .join(""),
    );
  }
  return {
    dir,
    run: () =>
      spawnSync("bash", ["-e", "-c", assembly], {
        cwd: dir,
        env: { ...process.env, VERSION: version, SOURCE_SHA: sha },
        encoding: "utf8",
      }),
  };
}

test("actual assembly command collects all six assets and emits one complete checksum file", (t) => {
  const { dir, run } = fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const output = join(dir, "release-assets");
  const files = Object.values(assets).flat();
  assert.deepEqual(
    readdirSync(output).sort(),
    [...files, "SHA256SUMS", "SOURCE_COMMIT"].sort(),
  );
  for (const file of files)
    assert.equal(readFileSync(join(output, file), "utf8"), file);
  assert.equal(readFileSync(join(output, "SOURCE_COMMIT"), "utf8"), `${sha}\n`);
  const checksums = readFileSync(join(output, "SHA256SUMS"), "utf8")
    .trim()
    .split("\n");
  assert.deepEqual(
    checksums.sort(),
    files.map((file) => `${hash(file)}  ./${file}`).sort(),
  );
});

for (const failure of [
  "corrupt",
  "source mismatch",
  "mixed version",
  "missing platform",
]) {
  test(`actual assembly refuses ${failure} before publication`, (t) => {
    const { dir, run } = fixture(t);
    const windows = join(dir, "build-assets/windows");
    const file = assets.windows[0];
    if (failure === "corrupt") writeFileSync(join(windows, file), "corrupted");
    if (failure === "source mismatch")
      writeFileSync(join(windows, "SOURCE_COMMIT"), "b".repeat(40));
    if (failure === "mixed version") {
      const older = file.replace("42.2", "42.1");
      renameSync(join(windows, file), join(windows, older));
      writeFileSync(join(windows, "SHA256SUMS"), `${hash(file)}  ./${older}\n`);
    }
    if (failure === "missing platform") rmSync(windows, { recursive: true });
    assert.notEqual(run().status, 0);
  });
}
