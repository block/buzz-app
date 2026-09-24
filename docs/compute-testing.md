# Test the Compute development branch

This is a branch for developer testing, not an organization rollout or a released
installer. Build it locally on macOS. Do not send the generated app bundles to
another person: their launchers reference your checkout, and each tester needs
their own account configuration. No pull request is required to try the branch.

## Requirements

- A macOS development machine with Xcode command-line tools and the repository's
  [Tauri prerequisites and Hermit setup](contributing.md).
- Access to `block/buzz-app` and its pinned Mesh LLM Git dependencies.
- Existing Buzz accounts signed in through the old desktop app. This development
  integration reads existing credentials from macOS Keychain; it has no independent
  packaged sign-in flow. Do not export or paste private keys into this checkout.
- Both test accounts admitted to the same compatible Buzz community, with signed
  membership/owner records and explicit relay authority. Ask the community owner
  for membership if needed. A community URL alone does not grant access.
- Enough RAM and disk for the provider's model. First sharing startup can download
  the model and verified native runtime. The consumer does not load a local model.

Two apps on one Mac test separate identities and isolated runtimes. For a real
cross-machine test, build locally on both Macs and use the Provider on one and
Consumer on the other. Cross-machine/network recovery is not yet fully validated.

## Get the branch and build

```sh
git clone https://github.com/block/buzz-app.git buzz-app-compute
cd buzz-app-compute
git switch --track origin/feat/community-compute-plugin
source bin/activate-hermit
pnpm install --frozen-lockfile
node scripts/build-compute-pair.mjs
```

The builder creates `.scratch/compute-pair/Buzz Compute Provider.app` and
`Buzz Compute Consumer.app`. Keep the checkout and dependencies in place. The
build may take a while; the SDK adds a substantial Rust dependency tree. These are
local debug bundles, not signed distributable releases. Follow local development
policy if macOS prevents launch; do not disable system security protections.

## Configure your own accounts

Create `.scratch/compute-pair/account-env.sh` locally. The launcher sources this
file after setting `BUZZ_COMPUTE_ROLE`. Replace every placeholder below. Use
**public** user IDs (hex or npub) and the exact existing Keychain service name for
each signed-in profile. The ordinary installed Buzz account uses `buzz-desktop`;
development profiles can use `buzz-desktop-dev.<profile>`. Do not create a service
name by guessing: check the profile's configuration or its Keychain item metadata.

```sh
export BUZZ_RELAY_URL='wss://YOUR-COMMUNITY-HOST'
if [[ "$BUZZ_COMPUTE_ROLE" == serve ]]; then
  export BUZZ_DEV_VIEWER='PROVIDER_PUBLIC_USER_ID'
  export BUZZ_DEV_CREDENTIAL_SERVICE='EXISTING_PROVIDER_KEYCHAIN_SERVICE'
else
  export BUZZ_DEV_VIEWER='CONSUMER_PUBLIC_USER_ID'
  export BUZZ_DEV_CREDENTIAL_SERVICE='EXISTING_CONSUMER_KEYCHAIN_SERVICE'
fi
```

Keychain may ask for access when the broker starts. The account pin must match the
credential; a mismatch fails closed. Never commit this local file, Keychain exports,
runtime state, logs, or generated bundles. Each app has separate plugin preferences,
owner identity and ports, but uses the existing account you selected.

## Connect and prove inference

1. Open Consumer, then Provider. In **each** app use the community selector to
   select/add the same community. Account configuration and selected community are
   separate; do not leave either app on Personal space.
2. Enable Compute in Settings → Plugins if needed.
3. Open Settings → Compute in either app. Once the selected community is ready,
   the app connects to community compute automatically and shows its connection
   state on the page.
4. In Provider, choose an available model, then turn on **Share this machine**.
   Wait for model startup and the sharing status. Consumer uses the same page;
   its sharing switch stays off unless you opt in.
5. Initial device registration may change the verified owner roster and stop an
   existing session. The affected app reconnects when its Compute page is open;
   if Provider sharing is stopped, turn **Share this machine** off and on to
   refresh admission. This does not require new keys.
6. Send a test request from the Compute page in either app. Verify a reply and activity/token growth on the
   Provider widget. The CPU icon appears only on the actively sharing Provider;
   Consumer has Compute settings but no sharing widget icon.

## Optional: try the simulated credits flow

In Consumer, open Settings → Wallet (demo) and add demo credits. In Provider,
open the same page and leave it open while testing a request from Consumer. The
local demo ledger then moves one credit per 1,000 served tokens from Consumer to
Provider, using the Provider session counter. The Consumer page also has a manual
demo-spend control that transfers credits to Provider. Both apps show the shared
balances and ledger. Reset from either app to clear the simulation.

This is a same-machine development simulation only. It does not gate requests,
create a real balance, or represent redeemable value; the Provider Wallet page
must stay open to sync live tokens. The session counter and its credit conversion
are illustrative, not production accounting.

The built-in test currently allows only 128 output tokens. A reasoning model can
use that budget before producing visible text, yielding “The provider returned no
text.” To separate this from a connection failure, try the consumer's local API
with a larger budget (while its connection is running):

```sh
curl --fail-with-body --max-time 120 http://127.0.0.1:19338/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"mesh","messages":[{"role":"user","content":"Say hello in one short sentence."}],"max_tokens":1024,"stream":false}'
```

Only use this endpoint locally. The consumer can route to other verified providers
in the community too; a reply alone does not prove which machine served it. Watch
your Provider's activity and counters, or test in a community with only that provider.
Do not share raw runtime status responses: they may contain operational credentials.

## Optional: run an existing agent in Consumer

Direct shared inference above does not need an agent. Agent hosting currently
supports **one explicitly configured existing owner-only `buzz-agent` identity**
using the shared-compute provider. It is not a general editor or launcher for every
saved agent/harness. See [agent runner constraints](agents.md).

Build trusted old Buzz runtime binaries using that repository's build instructions.
Supply a directory containing `buzz-acp`, `buzz-agent`, and `buzz-dev-mcp` when
building the Consumer bundle:

```sh
BUZZ_COMPUTE_BUILD_ROLE=client \
BUZZ_AGENT_RUNTIME_SOURCE='/absolute/path/to/old-buzz/target/debug' \
  node scripts/build-compute-pair.mjs
```

Add these variables inside the Consumer `else` block of `account-env.sh`:

```sh
export BUZZ_RUNNER_AGENT='EXISTING_AGENT_PUBLIC_KEY_HEX'
export BUZZ_RUNNER_LIBRARY='/absolute/path/to/profile/agents/managed-agents.json'
export BUZZ_RUNNER_WORKDIR='/absolute/path/to/agent/workspace'
```

Use that profile's existing definition and Keychain service, owned by the consumer
account. Its linked definition must select `relay-mesh`; its authorization must
be an unconditional owner attestation. The host verifies these before launch.
The Agents page uses this library too; `BUZZ_AGENT_LIBRARY` is an optional explicit
library override. Do not point the grid at a different account's library.

Stop the identity's runner in old Buzz, then close that old app. Reopen Consumer to
load launcher changes, connect Compute, and choose **Start agent** on the matching
Agents card. The bundled runtime now hosts it without the old desktop being open.
Do not run both hosts for the same identity. After disconnect/restart, reconnect
Compute and explicitly start the agent again; there is no agent auto-start.

Open the DM for the exact running identity and send a new message. Normal
one-to-one DMs address that member without needing an @ mention. Replies appear
in the message thread. If two agents have the same name, check their identities;
the wrong one will not wake. Conversation options → **Hide from sidebar** hides
an unused DM locally; **Restore hidden DMs** restores it without deleting history.

## Widget and troubleshooting

- Open the Provider widget from the top-right CPU icon or Compute settings.
  Left/Right cycles designs. Number keys preview states; **Escape returns to live
  activity**. A manual preview can otherwise mask a real request.
- A timeout or changed community admission stops compute rather than continuing
  with stale permission. Reconnect and restart the agent. Automatic recovery after
  sleep or network interruption is not yet implemented/verified.
- The pair uses web ports 1451/1452, API ports 19337/19338, and console ports
  13131/13132. Close an older copy of these test apps if a port is occupied; the
  launcher deliberately refuses to attach to an unrelated process.
- Blank windows named Buzz Foundation may belong to a separate development app.
  The pair is named **Buzz Compute Provider** and **Buzz Compute Consumer**.
- Local logs live next to the bundles as `serve-broker.log`, `client-broker.log`,
  `serve-app.log`, and `client-app.log`. Runner logs live in the Consumer app-data
  directory under `agent-runner/runner.log`. Inspect locally; redact credentials,
  account identifiers and conversation content before sharing excerpts.

## Report a test result

Include the branch commit, macOS/hardware, one-Mac or two-Mac setup, model,
whether direct inference worked, whether the agent replied, widget behavior, and
steps to reproduce a failure. Do not include keys or full account/runtime dumps.
Current evidence is a local macOS two-account test with real inference and agent
replies; this is not production readiness, cross-platform validation, or a release.
