# Deployment configuration: current-feature parity

Buzz Foundation supports configuration for capabilities that exist here, not a
port of every OG Buzz feature. Keep deployment values in local/CI configuration,
not in source. Build defaults are readable binary data, **never secret storage**.

## Supported inputs and surfaces

| Input | Consumer and boundary |
| --- | --- |
| `BUZZ_BUILD_AGENT_ENV` | Native build: allowlisted multiline Databricks host/model/filter defaults. Runtime, OAuth/discovery and editor share one compiled floor. |
| `BUZZ_BUILD_BUZZ_AGENT_PROVIDER` | Native build: lowest-precedence Buzz Agent provider, never a default for other harnesses. |
| `BUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY` | Native build: presence-only local listener policy clamp, including saved/imported agents. |
| `BUZZ_BUILDERLAB_URL` | Vite build: public URL exposed as `import.meta.env.VITE_BUZZ_BUILDERLAB_URL` in web and packaged desktop frontend code; no runtime override. |
| `BUZZ_BUILD_BUILDERLAB` | Vite build: `1` includes the Builderlab frontend plugin; pair with Cargo `--features builderlab` for its native companion. Standard builds omit both. |
| `BL_HOME`, `BL_SKILLS_CONFIG`, `BL_SKILLS_PROFILE`, `BL_AUTH_STORAGE`, `BL_AUTH_STORAGE_FILE`, `KGOOSE_BASE_URL`, `KGOOSE_SERVICE_PATH` | Native desktop runtime: the `bl` CLI's own environment, read from the app process at launch to locate the [shared Builderlab session](#builderlab-session-shared-with-the-bl-cli). Not build inputs. |
| `BUZZ_RELAY_URL` | Live development broker's default community, not an agent relay override or a packaged default. |
| `BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY` | Presence-only alias for fresh-viewer community selection in live development only. Saved viewer choice wins. |
| `BUZZ_DEV_OPEN_RELAY` | Development-specific override of that alias: only `1` enables; `0` explicitly opts out. Requires a relay URL and live viewer pin to have an effect. |
| `BUZZ_DEV_VIEWER`, `BUZZ_COMMUNITY_ALIASES`, `BUZZ_DEV_NOTIFICATIONS` | Existing public viewer pin, public routing aliases and dev notification override; unchanged. See the [development setup](contributing.md). |
| `BUZZ_UPDATER_PUBLIC_KEY`, `BUZZ_UPDATER_ENDPOINT` | Native release build, process environment only: two non-empty values register the updater plugin. The same public key and endpoint must reach `tauri build --config` as `plugins.updater`, and update archives must be signed by the matching private key. The macOS prerelease workflow supplies both (see [releases](releases.md)); other builds report automatic updates as unavailable. |

The three native inputs read only repository-root `.env.local` plus explicit
process values. Process presence wins, even empty. No `.env.production`, arbitrary
environment passthrough or runtime environment inheritance is added. See the
[agent-default precedence and example](agent-control.md#nonsecret-build-defaults).
Restart/rebuild native code to change compiled defaults. Restart Vite to change
broker/routing configuration. Browser-only builds have no native agent controller;
production frontend builds neither load the dev broker nor expose the auto-open
seed. Native settings do not enter Vite `define` or runtime-resource builds.

Cargo watches `.env.local` even when it is absent so creating it later is detected.
A missing watched file makes Cargo rerun the controller build script on each
invocation and can rebuild dependent native crates. To avoid that cost when no
local defaults are needed, create an empty repository-root `.env.local` once
(`touch .env.local` preserves existing contents). Do not touch it on every build;
normal edits and removal must continue to invalidate compiled defaults.

An unset provider build flag does not select Databricks on behalf of an existing
blank agent. The Create form retains its existing Databricks suggestion when no
provider floor exists. Supplying a provider floor leaves the saved selector blank
so later build defaults can take effect. Saved explicit settings remain explicit.

## Builderlab URL build input

Set `BUZZ_BUILDERLAB_URL` in repository-root `.env.local` for development, or in
the process running `bin/pnpm build` / `bin/pnpm tauri build` for packaging:

```sh
BUZZ_BUILDERLAB_URL=https://builderlab.example.com bin/pnpm tauri build
```

Vite loads this public input through its existing `BUZZ_` allowlist and exposes it
as `import.meta.env.VITE_BUZZ_BUILDERLAB_URL`. Its standard mode-specific `.env`
files also apply. The process environment takes precedence, including an explicit
empty value. When unset, the value is an empty string; the repository supplies no
deployment default. Never put credentials in it.

Restart Vite after changing development inputs. Production web and desktop
frontend builds substitute the value into compiled code: changing `.env.local`
or the launched app's environment afterward cannot override it. Rebuild and
redistribute to change a packaged value.

## Builderlab session shared with the bl CLI

The optional `block.builderlab` plugin owns the desktop account card under
Settings → Integrations → Builderlab. Its native companion is
[`tauri-plugin-builderlab`](../crates/tauri-plugin-builderlab/README.md).
Standard builds exclude the companion, its commands/permissions and the new
Builderlab frontend module. Opt in to **both** halves when developing or packaging:

```sh
BUZZ_BUILD_BUILDERLAB=1 bin/just desktop --features builderlab
BUZZ_BUILD_BUILDERLAB=1 bin/pnpm tauri build --features builderlab
```

`BUZZ_BUILD_BUILDERLAB` is a Vite build input (only `1` enables it). Cargo's
`builderlab` feature includes the native companion and catalog entry. Keep both
inputs together; a native-only feature has no frontend module to activate.
The plugin can be disabled in Settings → Plugins. Disabling cancels its pending
sign-in but does not log out a persisted session shared with the CLI.

The session lives in the store the `bl` CLI uses. When both tools resolve the
same profile and service URL, a `bl auth login` appears on the Builderlab card
without another sign-in, and signing out in either tool ends that session for
both. Open the card or select **Refresh session** to re-read external changes.
The signed-in card shows the resolved profile and service URL.

On macOS the item is the Keychain generic password with service
`com.squareup.builderbot.cli-auth` and account `<profile>@<service URL>`,
`default@https://block.builderlab.xyz/api/goose` by default. On Windows and Linux
Buzz uses `$BL_HOME/auth-sessions.json`; run `bl` with `BL_AUTH_STORAGE=file`
to share it. Buzz serializes its own storage transactions, including rollback of
a canceled write. The CLI store offers no cross-process lock or atomic file
replacement: concurrent writes by `bl`, another Buzz process or another profile
can still race. Avoid simultaneous writers. A corrupt file is reported without
silently resetting credentials; recovery requires an attended CLI/store repair.

The app resolves the key the way `bl` does, from its process environment at
launch: `just desktop` inherits the shell, a packaged app launched from Finder
sees none of these and takes the defaults. Restart the app to change them.

| Variable | Default when unset |
| --- | --- |
| `BL_HOME` | `<home>/.bl`, holding `skills.yaml`, `config.yaml` and the file store. |
| `BL_SKILLS_CONFIG` | `$BL_HOME/skills.yaml`; overrides the skills file location. |
| `BL_SKILLS_PROFILE` | `current_profile` from the selected skills file, else `default`. |
| `BL_AUTH_STORAGE` | Keychain on macOS; `$BL_HOME/auth-sessions.json` on Windows and Linux. `keyring` (macOS only), `file` and `file:<path>` select as in `bl`; `memory` is rejected because a per-call store would always be empty. |
| `BL_AUTH_STORAGE_FILE` | None; when set, the file store at that path. |
| `KGOOSE_BASE_URL` | `https://builderlab.xyz`. The `org` from `$BL_HOME/config.yaml`, `block` when absent, is prefixed onto `.xyz` and `.build` hosts, giving `https://block.builderlab.xyz`. |
| `KGOOSE_SERVICE_PATH` | `/api/goose`, or `/cash-app/goose` for a direct kgoose host such as `kgoose.sqprod.co`. |

Every request goes to the resulting service URL and the item is keyed by that
same URL, so the credential and the endpoint cannot disagree. `bl`'s own default
host is `kgoose.sqprod.co`, which does not serve the login endpoints, so run `bl`
with `KGOOSE_BASE_URL=https://builderlab.xyz` for both tools to resolve the same
key. `BUZZ_BUILDERLAB_URL` stays a frontend-only public URL; the native module
does not read it.

Expect a macOS Keychain prompt naming Buzz the first time the Builderlab card
reads an item `bl` created, and again after each `bl auth logout` and `bl auth
login`, because `bl` recreates the item and its access list trusts only the
creator; `bl` is likewise prompted in Terminal for an item Buzz created.
Ad-hoc-signed development builds prompt again after each rebuild; Always Allow
sticks for a packaged app. These prompts are expected, not defects. Deny shows
the sign-in card with "Keychain access was denied. Allow Buzz to use the
Builderlab session in Keychain and retry."; Sign in reads again. The store is
first read when the card mounts, never at launch, and an unanswered prompt
leaves the card at Checking your saved session… by design.

If checking the saved session returns an error, the card keeps **Clear saved
session** available alongside sign-in and refresh. This uses the same sign-out
operation: it attempts server revocation, then removes the local session even
when the service is unreachable. A local storage error stays visible and can be
retried. Clearing a shared item also signs the matching `bl` CLI profile out.

Only sign-in is native. Identity binding and community actions remain in the
browser-only Hosted communities card and require the development broker. Desktop
does not register that card, so signing in never triggers unsupported actions.
No native signing or `/v1/buzz/*` command is exposed by this plugin.

## Deliberate exclusions

Inventory source: `block/buzz-releases` at
`af57fbf40b50941c03cef2466b1e6970ab6bc779` (`.buildkite/pipeline*.yml`,
`scripts/build-macos.sh`, mobile helpers, `scripts/lib.sh` and publishing helpers),
compared with OG `block/buzz` at
`99c2acf90cfbb1cb2d3a8bd900c0ec1642e20540` (`desktop/src-tauri/build.rs` and its
runtime consumers). No deployment-specific values from those repositories are
copied here.

| OG/release input | Why it is not implemented here |
| --- | --- |
| `BUZZ_DESKTOP_BUILD_RELAY_URL`; packaged auto-connect | No packaged default or auto-join is configured. Native macOS, Windows and Linux use the persisted identity and restore only the selected saved community; new admission uses Add a community. Windows/Linux installed-app acceptance remains unverified. The dev broker and saved agent destinations remain separate. See [packaged identity](identity.md). |
| `BUZZ_BUILD_RELAY_RECONNECT_CMD` | No reconnect-command feature; arbitrary deployment command execution is not added. |
| Updater helper fallback aliases | Only the two canonical updater names above are read. Private signing keys never belong in app defaults. |
| `--features mesh-llm` | No mesh/provider integration in this local controller; unsupported imported mesh/team/remote agents still fail closed. |
| `BUZZ_BUILD_OBSERVER_ARCHIVE_DEFAULT`, `BUZZ_BUILD_AGENT_METRIC_ARCHIVE_DEFAULT` | Already no-ops in inspected OG: its archive capability checks return true for all builds. This app does not claim equivalent archive collection by accepting inert flags. |
| Build-command `BUZZ_ACP_ALLOWED_RESPOND_TO`, `BUZZ_ACP_ALLOWED_CHANNEL_ADD_POLICIES` | OG consumers are runtime-only; setting these around compilation does not bake them. The supported owner-only capability uses the existing local listener enforcement boundary instead. |
| Mobile `BUZZ_AGE_GATING_ENABLED`, Android `BUZZ_ANDROID_RELEASE_SIGNING=external` | No corresponding Flutter/Android target in this app. |
| CI version/tag metadata, artifact paths/upload controls, signing teams/profiles, Apple/App Store/Artifactory/Play credentials, Android signer roles/sockets, SDK/JDK/toolchain settings, Tauri bundle/config arguments | Release infrastructure and packaging controls, not product defaults. No new build-variable forwarding API. |

Ignored `.env.local` can contain unrelated development settings, but only the
three allowlisted native keys are compiled. Unrelated syntax is ignored; quoted
multiline records are skipped as a whole, including the rest of the file when
an unrelated quote is unclosed. Selected, non-overridden build assignments still
require valid dotenv syntax. Unknown keys **inside**
`BUZZ_BUILD_AGENT_ENV` fail closed instead of silently implying support. Do not
use any build input for private keys, tokens or raw agent configuration.
