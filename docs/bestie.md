# Bestie plugin

Enable **Bestie** and **Builderlab** in Settings → Plugins. Open **Bestie** and
sign in there. Choose a community if none is selected, then select **Set up
Bestie**. If several remote agents are already named Bestie, choose the one you
want to use; setup does not create another.

Setup registers or reuses Bestie through the existing Builderlab client, attests
and enrolls it in the community, creates a private stream, invites Bestie,
updates its instructions, and sends an introductory mention. It then opens that
channel in the normal conversation UI. Clicking Bestie again opens the same chat.

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

This minimal setup-and-chat plugin installs no workflow and embeds no workflow
editor. Use the normal Workflows page for schedules and Send Message actions.
A successful workflow run does not prove that hosted Bestie replied; check its
actual message and response when testing that path.
