# PR Beacon

An independently implemented GitHub review dashboard for Buzz, inspired by PR
Beacon, a macOS menu bar app for reviewing pull requests. It reimplements a
portable subset of that app's behavior as an external Page-API-v1 plugin,
built from public GitHub REST/GraphQL API documentation.

## What's implemented

- **Review requests** — your open, requested-review pull requests, split into
  a **Highlighted** section (VIP authors or watched labels) and an ordinary
  **Review requests** section.
- **Your pull requests, by status** — every open PR you authored, partitioned
  into Draft / Awaiting review / Reviewed with feedback / Approved-but-failing
  / Ready to merge, using only evidence GitHub's API actually reports (see
  [Known limitations](#known-limitations) — this is a portable subset, not a
  full parity implementation of any particular status engine).
- **Pull request detail** — title, branches, and a changed-files diff fetched
  via GitHub's compare API, pinned to the exact base and head commit SHAs you
  loaded (not "whatever the PR looks like right now"). See
  [Known limitations](#known-limitations) for the size/patch caps this diff
  view discloses rather than hides.
- **Approve** — a real, user-triggered `POST .../pulls/{n}/reviews` with
  `event: APPROVE`. Before submitting, it refetches the PR's current head SHA
  and refuses to approve if it moved since you loaded the diff. If the POST's
  outcome is uncertain (network error, timeout, or the view being closed
  mid-request), it never resubmits automatically — it offers a **Check
  status** action that looks up whether an approval for that exact commit
  already exists, and only enables a retry once that check affirmatively
  confirms no approval exists.
- **VIP list and watched labels** — plain comma-separated settings used to
  highlight review requests.
- **Hide/unhide** — hide an individual review request into a collapsed
  "Hidden review requests" disclosure; the hidden set persists across
  reload as a preference (not a secret) and is scoped to this browser
  origin. Hiding is explicit only in both directions: a capped or
  filtered refresh that happens not to return a hidden pull request does
  not un-hide it — only clicking **Unhide** does.
- **Explicit Refresh, and optional background polling.** Both the
  review-request and your-pull-requests lists have a manual **Refresh**
  button, available even after a failed load (disabled only while a request
  is actually in flight). A Settings checkbox additionally enables
  re-checking both lists once a minute while this page stays mounted; the
  interval is torn down on unmount and never starts an overlapping request
  while one is still in flight.
- **Agent summary** — send a pull request's title, URL, base/head commit
  SHAs, and diff to an existing Buzz agent you pick, and see its replies
  in the pull request detail view. See
  [AI summary via an existing Buzz agent](#ai-summary-via-an-existing-buzz-agent)
  for exactly how this works and its limits.

## Not implemented (explicit inventory, not a full-parity claim)

This is a first slice, not a port of every PR Beacon feature. Missing:

- **"Your VIPs' open PRs" / "Your teams' PRs" / watched-labels-as-own-section**
  feeds — watched labels only affect highlighting within the review-request
  list here, not a separate section.
- **Team-directory integrations** — no group-based VIP expansion or
  ownership/team-lookup integrations. None of that is reachable from an
  external Buzz plugin; VIPs here are a flat list of GitHub logins.

## AI summary via an existing Buzz agent

There is no built-in AI provider: this build's Content-Security-Policy
(`src-tauri/tauri.conf.json`) only allows `connect-src` to
`https://api.github.com`, so no AI vendor API is reachable from any plugin,
first-party or external, without a host CSP change. Instead, this plugin's
"Agent summary" feature reuses the public relay surface (`ctx.relay`,
`inject: ["relay"]`) that's already available to a page plugin:

1. In Settings, pick a **Summary agent** (from `agentLibrary`) and a
   **Summary channel** (from `channels.list()`) that agent is a member of.
   This selection is activation-memory only — it's plain React state, never
   written to `localStorage`, and resets whenever the relay session
   reconnects or you switch communities (an agent/channel id from a prior
   session or community can be stale or meaningless in a new one).
2. In a pull request's detail view, **Send diff to agent** posts the title,
   URL, base/head SHAs, and diff as a normal channel message
   (`session.messages.send`), addressed to that agent. Every other member of
   the channel can read it too — the UI says so before you send, alongside
   exactly which files will be included and which are omitted (and why).
3. The plugin correlates the agent's reply via the message id
   `send()` returns, reading `session.thread(channelId, eventId)` and
   filtering to replies authored by the selected agent's pubkey — never by
   guessing from timing or content.
4. The agent has no completion signal in this protocol: the view always
   shows the latest matching reply and stays listening (bounded to 60
   seconds, polling only while waiting, no overlapping refreshes) rather
   than assuming the first reply is final.

This is deliberately one fixed route (an existing, user-selected Buzz agent
over the relay) — not a pluggable AI-provider abstraction, and not a
guarantee the agent will reply at all (it must be configured and running).
The GitHub token never appears in the message sent to the agent.

## Capability model this plugin uses

This is a fully standalone external plugin: it touches no host source and
required no CSP or host-capability changes to build. Concretely:

- **GitHub API access** uses the browser's own `fetch()` directly against
  `https://api.github.com`, which the host CSP already allows. No host API
  is involved — the same mechanism the bundled `src/bundled/github` panel
  already uses for unauthenticated public lookups.
- **Authentication** is a GitHub personal access token the user pastes into
  this plugin's own Settings tab. **The token lives only in memory for the
  current activation** — a variable created inside `apply(ctx)`
  (`src/tokenStore.ts`), released via `ctx.effect` on disable/dispose. It is
  never written to `localStorage`, IndexedDB, or any log. Re-enabling the
  plugin, reloading Buzz, or restarting requires re-entering it. This is a
  deliberate trade-off for zero credential persistence, not an oversight;
  there is no per-plugin secret-storage host API to use instead.
- **Preferences** (VIP logins, watched labels — non-secret) persist to
  `localStorage` under a plugin-scoped key (`src/preferences.ts`), the same
  pattern other external example plugins use in the absence of a per-plugin
  storage capability. A failed write (quota exceeded, storage disabled) is
  caught and surfaced in Settings rather than silently lost or thrown as an
  uncaught error; the in-memory value still updates for the rest of the
  session.
- **Agent summary** uses `ctx.relay` (declared via `inject: ["relay"]`), the
  public read-model/command surface for the relay session — `agentLibrary`,
  `channels`, `messages.send`, and `thread`. No private transport, signer, or
  host-internal module is imported; the plugin never gets raw relay
  connection details, only these read models and commands.

## Known limitations

- **Own-PR status is a portable subset, not full parity.** "Ready to merge"
  requires `reviewDecision: APPROVED`, an aggregate commit
  `statusCheckRollup.state` of `SUCCESS`, and GitHub's own
  `mergeStateStatus: CLEAN` — the closest public-API evidence to "the merge
  button would work right now." It does not know about branch protection
  rules beyond what feeds those two fields, GitHub's merge queue position, or
  a required-vs-optional check distinction. Any state short of that evidence
  (checks still pending, `mergeStateStatus: UNKNOWN` while GitHub is still
  computing it, etc.) is reported as **Unresolved** rather than guessed as
  ready. Bot review/thread filtering isn't replicated — GraphQL's
  `reviewDecision` doesn't expose a human/bot distinction.
- **Diff size and content caps.** GitHub's compare API returns at most 300
  changed files and can omit `patch` text for individual files that are too
  large. Hitting either cap shows an explicit "more files exist" / "too large
  to display" notice in the UI — the diff view is bounded and discloses that,
  never presented as complete when it isn't.
- **Search result caps.** Review-request and own-PR lists page up to 250
  results (5 pages of 50); hitting that cap shows an explicit truncation
  notice rather than silently dropping the rest.
- **Approval-confirmation caps.** Confirming whether an approval exists pages
  up to 500 reviews; if a PR has more than that with no match found, the
  check reports itself unresolved rather than a false "no approval exists."
- **Agent summary size and membership caps.** The relay caps a sent event at
  32 KiB serialized; the diff is built against a conservative 24 KiB budget
  for that reason, so a large diff sends only as many files as fit, with the
  rest disclosed as omitted rather than silently dropped. Sending is blocked
  (not just discouraged) unless the relay's channel roster affirmatively
  confirms the selected agent is a member — an unknown roster blocks sending
  the same as a confirmed non-member, since "unknown" is not "safe."

## Try it

Ready to install without a build: this folder ships a prebuilt `plugin.js` and
`manifest.json` (Page API v1). In desktop Settings → Plugins → Load from
folder, select this directory (or `buzzodz plugin install .`). New installs
start disabled.

1. Enable **PR Beacon** and open its page.
2. In Settings, paste a GitHub personal access token with `repo` scope (or
   fine-grained pull-request read/write). Use a test token against a repo
   you're comfortable exercising real GitHub reads/an approval against — this
   plugin performs real API calls, not a mock. It never auto-submits a real
   approval; approving requires clicking the button after reviewing the diff.

Refresh the checked-in `plugin.js` from `dist/plugin.js` after changing the
source (see below).

## Building from source

This plugin is standalone (its own `package.json`, no workspace
dependency), but the host repo's root `pnpm-workspace.yaml` still claims
any directory under it — running `pnpm install` from inside
`examples/plugins/pr-beacon` while it lives in the host checkout gets
folded into that workspace instead of installing standalone. Copy the
folder outside the host checkout first:

```sh
cp -R /path/to/buzz-app/examples/plugins/pr-beacon /tmp/pr-beacon
cd /tmp/pr-beacon
pnpm install
```

Then generate the `@buzz/author` preview package from the host checkout
and pack it into a tarball:

```sh
cd /path/to/buzz-app
pnpm run author:build       # writes dist-author/
cd dist-author && npm pack  # writes buzz-author-VERSION.tgz
```

Back in the copied plugin folder, add the tarball and build:

```sh
cd /tmp/pr-beacon
pnpm add -D /path/to/buzz-author-VERSION.tgz
pnpm build
```

`@buzz/author` is a type-only, host-generated preview package with no
registry release, so it's intentionally left out of this package's tracked
`devDependencies`/lockfile — add it locally before building, the same way
`examples/plugins/composer-lab` does. `pnpm build` runs `tsc` then `vite
build`; the Vite config enforces the Page API v1 contract (one
self-contained `plugin.js` chunk, no bundled React/`@buzz/author`/Cordis,
must export `apply`) and builds unminified. Copy `dist/plugin.js` and
`dist/manifest.json` back over this directory's checked-in copies when
you're done.

## Tests

`pnpm test` runs the Vitest suite (`src/**/*.test.{ts,tsx}`):

- `classify.test.ts` — VIP/label matching and own-PR status partitioning,
  including the "don't guess ready-to-merge" cases.
- `github.test.ts` — GraphQL/REST request shape, auth headers, pagination
  truncation, the compare-endpoint file-diff pinning (against the base
  commit SHA, not the mutable base branch name) and its truncation flag, the
  approve flow's stale-SHA refusal, an abort-after-preflight case that proves
  the approval POST never fires once the caller's signal is aborted, and the
  paginated approval-confirmation check (including its own truncation case).
- `preferences.test.ts` / `tokenStore.test.ts` — persistence and in-memory
  session-scoping behavior.
- `PullRequestDetailView.test.tsx` — the no-agent-selected prompt in place of
  a fabricated AI summary, the stale-SHA approval refusal, the uncertain-POST
  manual-recheck flow (including that a failed or inconclusive check never
  exposes a blind retry), an unmount-mid-approve-preflight case proving no
  real GitHub mutation fires after the view closes, and a rapid
  pull-request switch proving a slow, stale response can't overwrite the
  currently selected one.
- `relaySummary.test.ts` — the agent-summary request builder's byte-budget
  behavior (including escape-heavy/unicode content and JSON-serialized size,
  not raw string length), giant-title truncation, count-only partial-coverage
  disclosure, the "no usable diff, don't send" case, channel-membership
  classification (member / not-member / unknown), and filtering replies to
  the selected agent's pubkey.
- `PullRequestDetailView.agentSummary.test.tsx` — sending correlates the
  reply to the exact sent event id and ignores replies from other channel
  members; membership is re-verified immediately before sending; the thread
  watch is disposed on unmount and on a selection change, and a stale
  callback from a watch superseded by a relay reconnect can't resurrect it;
  multiple sequential replies keep updating the displayed content instead of
  disposing on the first one; and the included/omitted file coverage is
  shown before the user clicks Send, not only after.
- `App.test.tsx` — hide/unhide (with an explicit-only contract: a
  capped/filtered refresh never silently un-hides), manual Refresh
  re-fetching the list (available even after an error, disabled only while
  loading), background polling (starts a re-check on the interval, never
  starts a second overlapping request, resumes once the in-flight request
  resolves), and that a stale, superseded request's completion can't clear
  the busy flag a newer request owns.

All fixtures use synthetic PR/relay data; no test reads a real token, sends a
real relay message, or hits the real GitHub API.
