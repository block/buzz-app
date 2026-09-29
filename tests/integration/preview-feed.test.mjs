import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const script = new URL("../../scripts/preview-feed.mjs", import.meta.url)
  .pathname;

function run(...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

test("preview candidate embeds the exact signed archive URL and signature", () => {
  const dir = mkdtempSync(join(tmpdir(), "preview-feed-"));
  const sig = join(dir, "archive.sig");
  const manifest = join(dir, "manifest.json");
  writeFileSync(sig, "YWJjZA==\n");
  assert.equal(run("generate", "0.0.0-preview.22.1", sig, manifest).status, 0);
  const data = JSON.parse(readFileSync(manifest, "utf8"));
  assert.equal(data.platforms["darwin-aarch64"].signature, "YWJjZA==");
  assert.equal(
    data.platforms["darwin-aarch64"].url,
    "https://github.com/block/buzz-app/releases/download/v0.0.0-preview.22.1/Buzz_0.0.0-preview.22.1_aarch64.app.tar.gz",
  );
  assert.equal(run("verify", "0.0.0-preview.22.1", sig, manifest).status, 0);
  const older = join(dir, "older.json");
  writeFileSync(
    older,
    JSON.stringify({ ...data, version: "0.0.0-preview.23.1" }),
  );
  assert.match(
    run("verify", "0.0.0-preview.22.1", sig, manifest, older).stderr,
    /rollback/,
  );
  writeFileSync(
    older,
    JSON.stringify({ ...data, version: "0.0.0-preview.22.1" }),
  );
  assert.match(
    run("verify", "0.0.0-preview.22.1", sig, manifest, older).stderr,
    /differs/,
  );
  data.platforms["darwin-aarch64"].url = "https://example.com/wrong";
  writeFileSync(manifest, JSON.stringify(data));
  assert.notEqual(run("verify", "0.0.0-preview.22.1", sig, manifest).status, 0);
  assert.notEqual(
    run("generate", "0.0.0-preview.bad", sig, manifest).status,
    0,
  );
});
