# macOS test releases

The **macOS prerelease** workflow builds and signs Apple Silicon test builds from
`main`. It publishes a DMG and `SHA256SUMS` as a GitHub prerelease, tagged
`v<app-version>-preview.<run-number>.<attempt>` at the built commit.

Runs are scheduled at **00:17, 06:17, 12:17, and 18:17 UTC**. To start one manually:

```sh
gh workflow run release.yml --repo block/buzz-app --ref main
```

These builds use `macos-latest` and the repository's pinned toolchain. They do not
generate Tauri updater artifacts or upload to the legacy `block/buzz` updater.

## Prerequisites

Deploy [the signing infrastructure](https://github.com/squareup/tf-mobuild-workers/pull/1398)
and set these repository Actions secrets:

- `OSX_CODESIGN_ROLE`: ARN of `block-buzz-app-codesign-role`.
- `CODESIGN_S3_BUCKET`: `block-buzz-app-artifacts-bucket-<environment>`.

The manifest records hashes before signing. Packaged macOS apps accept changed
hashes only after verifying their enclosing app's resource seal and Block Developer
ID signature. The app retains the signed files' hashes in memory and checks them
before each launch. Development builds and other platforms still require the
manifest hashes to match. The release workflow verifies the signed seal,
notarization, and manifest identity before publishing.

## Preparing the legacy app replacement

The production identity overlay is separate from these test releases. See
[desktop identity](desktop-identity.md) for bundle identity, profile storage, and
migration requirements before an updater cutover.
