# Bestie plugin

Enable **Bestie** and **Builderlab** in Settings → Plugins. Open **Bestie** and
sign in there. Choose a community if none is selected, then select **Set up
Bestie**. If several remote agents are already named Bestie, choose the one you
want to use; setup does not create another.

Setup registers or reuses Bestie through the existing Builderlab client, attests
and enrolls it in the community, creates a private stream, invites Bestie,
updates its instructions, and sends an introductory mention. It then opens that
channel in the normal conversation UI. Clicking Bestie again opens the same chat.

Setup also saves three paused workflows in that private channel: hourly memory
review, nightly reflection at **09:00 UTC**, and daily check-in at **17:00 UTC**.
These are editable configuration presets. They do not establish hosted execution
or the full OpenClaw/Muse behavior set. If workflow setup fails, **Open Bestie
conversation** still opens the completed chat; **Set up Bestie workflows** retries
only the missing configuration. Existing setups can use those same actions.

The existing enrollment, membership, channel, navigation and Outbox services own
their operations. Bestie saves setup identifiers and receipts scoped to the
Builderlab server/account, community and Buzz identity. Retries reuse the agent
and channel. Setup confirms the private roster contains only the owner and Bestie
before updating instructions or sending the introductory message. Existing
custom instructions are replaced on first setup; save them before proceeding.
Ordinary reopen preserves instructions.

## Try it

From this worktree, use the native development path:

```sh
BUZZ_DEV_VIEWER= BUZZ_BUILDERLAB_URL=https://test.blockstaging.build bin/just desktop --port 1459 --no-watch
```

Select `wss://buzz.test.blockstaging.build`, enable the plugins, then open Bestie.
Sign in on that page and select **Set up Bestie**. Choose an existing Bestie if
prompted. Working means the app opens a private channel with you and that agent,
then Bestie answers the introductory message. Send another message and verify
its reply. Reopen Bestie and confirm the same channel opens without another agent.

## Workflows

BuzzApp already supports programmatic configuration through
`connection.session.workflows.save({ channelId, yaml, existing? })`; the returned
ID identifies a save operation, not confirmed delivery. Follow the existing
operation status and definition readback. Pass the saved definition as `existing`
when updating; a new save allocates a new workflow.

Open **Workflows**, choose Bestie's private channel, and inspect the three named
presets. Confirm all three are paused. Edit schedules and text in the normal
editor. Reopen Bestie and confirm the same channel and workflow IDs remain;
reopening does not overwrite edits or re-enable schedules. Definitions remain
available independently of the Bestie plugin; disabling it does not cancel
workflow runs or erase the companion.

The configured hosted source admits owner-signed messages; an ordinary relay-signed
workflow message has no matching owner authority. The separate hidden-wake bridge
has no verified deployment receipt and requires an installation binding. This
BuzzApp-only PR does not change that admission policy, invent the binding, or
install unsupported wake actions. The presets remain paused because that runtime
boundary is unresolved. Do not enable recurring execution on the strength of a
successful definition save.

After a compatible hosted runtime is available, enable a preset deliberately,
press **Run**, and verify the actual Bestie response or a memory write/readback.
Run is unavailable while paused. A successful relay run alone proves its own
action outcome, not Bestie execution. Send Message ticks are visible in chat even
when the agent chooses silence; private hidden maintenance needs the wake bridge.

Setup journals each save event and workflow ID in its existing scoped record and
confirms a signed definition before marking it installed. Unknown delivery never
starts another new save. Use **Check saved configuration** in Workflows after a
lost receipt; retrying Bestie can then adopt that confirmed definition, including
later edits. A definitely rejected intent may be replaced only after durable
manual dismissal and fresh absence readback. Setup preserves deliberate removal
of a previously confirmed workflow and asks for review instead of recreating it.

For the workflow candidate, launch this worktree on a separate free port:

```sh
BUZZ_DEV_VIEWER= BUZZ_BUILDERLAB_URL=https://test.blockstaging.build bin/just desktop --port 1461 --no-watch
```

The basic demo gate remains native sign-in → setup/choose existing → private chat
→ real Bestie reply → reopen same channel. The workflow configuration gate adds
three paused definitions with stable IDs; automatic execution is a separate gate.
