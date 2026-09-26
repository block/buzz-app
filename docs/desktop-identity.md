# Production desktop identity

Use the production overlay when preparing a replacement for installed legacy Buzz:

```sh
bin/pnpm tauri build --config src-tauri/tauri.production.conf.json
```

| Contract | Production configuration |
| --- | --- |
| Product / macOS bundle | `Buzz` / `Buzz.app` |
| Bundle identifier | `xyz.block.buzz.app` |
| Main executable | `buzz-desktop` |
| macOS display name | `Buzz` |
| Deep-link scheme | `buzz://` (inherited from the base config) |
| Signing identity | Block Developer ID Application, team `EYF346PHUG` |

The identity values match [legacy Buzz](https://github.com/block/buzz/blob/b65cff31a4c5f4a0af63952b60a21fd73195321a/desktop/src-tauri/tauri.conf.json)
and its [executable](https://github.com/block/buzz/blob/b65cff31a4c5f4a0af63952b60a21fd73195321a/desktop/src-tauri/Cargo.toml).
Use the existing Block signing/notarization service after building. A matching
bundle identifier is not a signature. This Developer ID flow has no provisioning
profile configured. Entitlements belong to implemented capabilities; legacy
camera/audio/MeshLLM permissions are not required for identity continuity.

Default builds and scheduled prereleases keep `Buzz Foundation` /
`dev.local.buzz.foundation`. The production overlay is opt-in and is not used by
the test release workflow. Both identities register `buzz://`, so multiple
installed copies can compete for link handling.

## Local plugin profiles

The desktop resolves its plugin home from the selected bundle's app-data directory.
`BUZZODZ_HOME` overrides it; `BUZZODZ_PROFILE` selects `<home>/profiles/<name>`.
These are plugin profiles, not legacy user accounts. The CLI still defaults to the
preview home; pass `buzzodz --home <production-app-data-directory> --profile <name>`
to manage a production plugin profile.

Existing agent credentials keep their current separate schema and service. This
change does not move data, access legacy credentials, or migrate accounts. Preview
and production are not separate agent credential vaults. Account migration and
updater integration remain separate work; select a version higher than the
installed legacy version and validate an upgrade before any production cutover.
