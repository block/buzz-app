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

**Signing is blocked:** the runtime manifest contains hashes of binaries before
signing changes them. Resolve that mismatch before merging. The workflow checks
signatures, notarization, and runtime hashes before publishing a release.
