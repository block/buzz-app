#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const [command, version, signaturePath, manifestPath] = process.argv.slice(2);
const versionPattern = /^\d+\.\d+\.\d+-preview\.(\d+)\.(\d+)$/;
const release = `v${version}`;
const archive = `Buzz_${version}_aarch64.app.tar.gz`;
const url = `https://github.com/block/buzz-app/releases/download/${release}/${archive}`;

function previewNumber(value) {
  const match = versionPattern.exec(value);
  assert.ok(match, `Invalid preview version: ${value}`);
  return match.slice(1).map(Number);
}

function signature(path) {
  const value = readFileSync(path, "utf8").trim();
  assert.match(
    value,
    /^[A-Za-z0-9+/=]+$/,
    "Expected a nonempty Tauri base64 signature",
  );
  return value;
}

function validate(manifest, expectedSignature) {
  assert.equal(manifest.version, version);
  assert.deepEqual(Object.keys(manifest.platforms), ["darwin-aarch64"]);
  assert.deepEqual(manifest.platforms["darwin-aarch64"], {
    signature: expectedSignature,
    url,
  });
}

previewNumber(version);
const expectedSignature = signature(signaturePath);
if (command === "generate") {
  const currentPath = process.argv[6];
  if (currentPath) {
    const current = JSON.parse(readFileSync(currentPath, "utf8"));
    if (current.version === version) {
      validate(current, expectedSignature);
      writeFileSync(manifestPath, readFileSync(currentPath, "utf8"));
      process.exit(0);
    }
  }
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        version,
        notes: `Buzz ${version} macOS preview`,
        pub_date: new Date().toISOString(),
        platforms: { "darwin-aarch64": { signature: expectedSignature, url } },
      },
      null,
      2,
    )}\n`,
  );
} else if (command === "verify") {
  validate(JSON.parse(readFileSync(manifestPath, "utf8")), expectedSignature);
  const currentPath = process.argv[6];
  if (currentPath) {
    const current = JSON.parse(readFileSync(currentPath, "utf8"));
    const [run, attempt] = previewNumber(current.version);
    const [nextRun, nextAttempt] = previewNumber(version);
    assert.ok(
      nextRun > run || (nextRun === run && nextAttempt >= attempt),
      "Refusing preview feed rollback",
    );
    if (nextRun === run && nextAttempt === attempt) {
      assert.equal(
        readFileSync(manifestPath, "utf8"),
        readFileSync(currentPath, "utf8"),
        "Same-version manifest differs",
      );
    }
  }
} else {
  throw new Error(
    "Usage: preview-feed.mjs generate|verify <version> <signature-file> <manifest-file> [current-manifest-file]",
  );
}
