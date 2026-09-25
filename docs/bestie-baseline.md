# Bestie baseline

This branch adds a runnable first version of Bestie to the existing app: three
onboarding recipes, an owner-private memory tree, cited dream reflections, and
three independently enabled background purposes. It uses existing agent controls,
message publication, encrypted engrams, ACP heartbeats, and relay workflows.

## Try it

Use the development desktop and the normal relay/account setup in the repository
README. This first version needs Python 3 on the agent's PATH and a model harness
with shell/tool access. macOS is the tested local environment; packaged and Windows
support are not established. Rebuild the desktop for the native heartbeat change:

```sh
bin/just desktop
```

1. Open Bestie → **Setup Bestie**. Enter the absolute path of this checkout.
2. Choose **Configure new Bestie**, select your working model/harness configuration,
   and create the agent. Existing Agents creation owns key custody, owner binding,
   configuration and profile publication. The preset does not configure credentials.
3. Create a private channel for yourself and this new agent. Select Bestie from
   mention autocomplete and send a greeting. This adds/starts it through the existing
   app path. Its first owner message establishes its single home channel.
4. In Bestie, connect that channel ID, then open **Journey** and choose the exact
   Bestie identity. Refresh after the agent responds. The ordinary **Memories**
   dialog remains available for raw relay documents.
5. Try: “Alex is my brother. Jo is my friend. We are the Thursday walking group.
   Remember the people and the group, including their links.” Then ask for a small
   useful task, a reminder, or a dream reflection.

The Journey controls send readable owner requests with an exact agent mention.
They show a queued request, never optimistic confirmation of saved state. Outbox
owns publication status. A failed or ambiguous send should be inspected there before
retrying. The agent's verified memory revision determines displayed progress.

The agent workspace is the checkout because the prompt invokes
`python3 scripts/bestie/state.py`. Do not delete/move the checkout while that agent
is configured to use it. Other teammates use their own checkout, owner, agent and
private channel; no machine-specific paths or test identities are shipped.

## Preview without an agent

```sh
bin/pnpm exec vite --config tests/fixtures/agent-control.vite.mjs
```

Open `http://127.0.0.1:1444/tests/fixtures/bestie.html`, click Journey, and select
Sample Bestie. This isolated fixture reads no environment file, credentials or
real relay data. It demonstrates the UI only; its controls cannot publish messages.
Use `--port 1458` if the default port is occupied.

## State and the transition contract

`State × Event → validated State + Effects` lives in `scripts/bestie/state.py`.
The model proposes JSON operations. Pure validation checks source-message channel,
owner and exact quote, link reachability, legal recipe transitions, background
eligibility, and memory budgets before applying one engram update. The helper reads
back the actual saved value. It does not send messages or own a scheduler.

`mem/bestie` is one versioned, encrypted aggregate. Its logical tree contains people,
groups, relationships, facts, commitments, correction revisions, source notes,
dreams, recipe progress, cadence state and recent run receipts. This avoids partially
writing a multi-record update. These branches are **not independent relay slugs**.
`core` remains small identity/context plus a pointer. No existing memory is migrated.
Group records describe groups privately; they do not grant group members access.

Corrections append versions under stable IDs and preserve omitted links and workflow
IDs. Dreams retain cited synthesis and questions under `reflection-not-fact`;
they cannot promote personal facts during a heartbeat. Owner turns can revise facts.
Evidence validation checks that a quote exists, not that an inference logically
follows from it. The model must preserve scope and ask about uncertainty.

Recipe completion has structural evidence requirements: a source message, stored
memory for remember-world, and a read-back workflow for check-in. A saved workflow
is not proof of delivery or task completion. Small-task content quality and the
semantic match between a request and its result remain model responsibilities.

There is no automatic destructive consolidation. The helper stops at 48 KiB or
30 dreams and asks for an explicit archive policy. Notes and fact revisions survive;
only the recent run list rolls at 40 receipts. This is a deliberately bounded baseline.
Hash checks are client-side conflict detection, not an atomic relay lock. Run one
listener per identity. The helper is cooperating-agent discipline, not a shell sandbox.

## Background behavior

The preset enables the existing ACP heartbeat every 3600 seconds. Native startup
keeps its pool ready when this setting is nonzero; otherwise the ordinary lazy pool
and 15-minute idle sleep remain unchanged. This is necessary because ACP skips
heartbeat ticks while its pool is asleep. There is no new timer or scheduler.

All three purposes start paused. The owner can enable/pause each or run it now:

- Onboarding review records a possible next step privately; it does not nag or
  advance progress without owner input.
- Commitment review examines existing commitments/workflows and records issues;
  it does not create or resend reminders on its own.
- Dream reflection produces one bounded, cited private synthesis and a run receipt.

The model still wakes hourly when every purpose is paused, and that call can cost
money. To stop all automatic model wakes, edit the native agent's Advanced environment:
set `BUZZ_ACP_HEARTBEAT_INTERVAL` to `0`, save, then restart it. The allowed interval
is 0 or 3600–86400 seconds. `BUZZ_ACP_HEARTBEAT_PROMPT` is the only other newly allowed
ACP variable; identity, routing and prompt-file overrides remain reserved.

Closing the Journey dialog does not stop the agent. Native Stop/Quit controls own
process lifetime. Pausing reviews does not cancel existing reminder workflows.
Automatic reviews require the running app/listener and model access. No offline
catch-up, exactly-once effect delivery, or automatic retry guarantee is added.
The owner can request a manual operation while its recurring cadence is paused.

Reminders use ordinary relay workflows with readable saved text. Bestie creates,
updates or disables the same workflow ID through the CLI. The relay can deliver
that saved text with the model stopped. Fresh reasoning requires a running model.
Inspect the actual definition and run history in Workflows, selecting the home channel.
Relative reminder times use `state.py due EVENT SECONDS`: the source message timestamp
anchors the deadline, rather than the time the model finishes its work. An already
passed deadline is rejected so the agent can ask for a new time.

## Validation and remaining boundaries

```sh
python3 -m unittest discover -s scripts/bestie -p 'test_*.py'
bin/pnpm exec vitest run
bin/cargo test -p buzz-agent-controller
bin/pnpm typecheck
bin/pnpm exec playwright test --config tests/browser/playwright.config.mjs bestie.spec.mjs --project chromium --project webkit --no-deps
```

The browser case proves modal focus, keyboard disclosure and narrow layout in
Chromium/WebKit; state/authority permutations stay in unit tests. The sample fixture
is not live runtime evidence. Native environment tests establish constructed launch
settings, not an observed hourly wake. The existing ignored bundled-runtime test still
requires prepared immutable resources. Full native creation/restart through the rebuilt
GUI, a real hourly soak, other model harnesses, and packaged deployment need separate
acceptance. Owner-view memory reading currently requires the development broker;
packaged signer-only transport reports unavailable.

A local relay acceptance run exercised two people, a linked group, two completed
recipes, a cited dream, restart persistence, a corrected relationship, reminder
delivery and explicit completion, and all three manual review purposes. The reminder
was disabled and the isolated listener stopped afterward. That run exposed an
incorrect relative deadline; the timestamp helper fix has unit and live read-only
validation, but a new scheduled delivery using that fix has not been observed.

Architecture sources: `src/bundled/bestie`, `scripts/bestie`,
`crates/agent-controller/src/{config,runtime}.rs`, and the existing
[agent controls](agent-control.md), [memory reader](agent-memories.md), and
[workflows](workflows.md) contracts.
