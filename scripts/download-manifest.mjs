import assert from "node:assert/strict";

export const downloadBranch = "download-feed";
export const downloadRepository = "block/buzz-app";
export const previewVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-preview\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const installerSuffixes = {
  "macos-arm64": "aarch64.dmg",
  "macos-x64": "x64.dmg",
  "windows-x64": "x64_unsigned.exe",
  "linux-appimage": "x86_64.AppImage",
  "linux-deb": "amd64.deb",
};

export function installerUrls(version) {
  assert.match(version, previewVersionPattern, "Invalid preview version");
  return Object.fromEntries(
    Object.entries(installerSuffixes).map(([id, suffix]) => [
      id,
      `https://github.com/${downloadRepository}/releases/download/v${version}/Buzz_${version}_${suffix}`,
    ]),
  );
}

export function validateDownloadManifest(manifest) {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.channel, "preview");
  assert.equal(manifest.release, `v${manifest.version}`);
  assert.deepEqual(manifest.downloads, installerUrls(manifest.version));
  return manifest;
}

export function buildDownloadManifest(version, release) {
  const downloads = installerUrls(version);
  assert.equal(release.tag_name, `v${version}`);
  assert.equal(release.draft, false, "Release is still a draft");
  assert.equal(release.prerelease, true, "Expected a preview release");
  for (const url of Object.values(downloads)) {
    const name = url.slice(url.lastIndexOf("/") + 1);
    const matches = release.assets.filter((asset) => asset.name === name);
    assert.equal(matches.length, 1, `Expected exactly one installer: ${name}`);
    assert.equal(matches[0].browser_download_url, url);
    assert.equal(matches[0].state, "uploaded");
    assert.ok(matches[0].size > 0, `Empty installer: ${name}`);
  }
  return {
    schemaVersion: 1,
    channel: "preview",
    version,
    release: `v${version}`,
    downloads,
  };
}

export function comparePreviewVersions(left, right) {
  const a = previewVersionPattern.exec(left);
  const b = previewVersionPattern.exec(right);
  assert.ok(a && b, "Invalid preview version");
  for (let i = 1; i < a.length; i++) {
    if (BigInt(a[i]) !== BigInt(b[i]))
      return BigInt(a[i]) > BigInt(b[i]) ? 1 : -1;
  }
  return 0;
}
