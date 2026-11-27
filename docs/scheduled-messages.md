# Scheduling messages from a plugin

Use `ctx.relay.snapshot().session.messages.scheduled` on a ready relay session.
The service is present when the relay advertises `buzz-scheduled-messages-v1`.
Obtain it from the current snapshot for each account or community. An older
relay leaves the capability undefined.

- `create(message, sendAt)` accepts an `OutgoingMessage` and a Unix timestamp
  in milliseconds, up to 120 days ahead. It uses the ordinary message builder
  for channel and thread messages, mentions and uploaded attachments. It
  rejects composer chips. Wait for this promise before clearing a draft.
- `list(signal?)` returns the owner's scheduled, failed and recent sent
  messages. It loads the revisions needed to change queued messages.
- `reschedule(id, revision, sendAt)` keeps the message content and destination
  and changes its time. `cancel(id, revision)` removes a queued message.
  Refresh the list for the next revision.

The native or browser host signs the message and authenticates the relay
request. The relay stores the exact signed event and owns delivery, including
after Buzz quits. A retired session refuses new operations. If a create's
response is lost, retry the same message and time on that session to reuse
the signed event and operation ID. After reconnecting, check the queue before
retrying a create with an uncertain outcome.

The composer send gate is synchronous. A gate must make its decision without
awaiting a request. Use an explicit scheduling action that can wait for relay
acceptance.

The [relay implementation](https://github.com/block/buzz/pull/9335) documents
the queue protocol and deployment order. To exercise delivery with an isolated
loopback relay that has scheduling enabled, run:

```sh
BUZZ_SCHEDULED_TEST_RELAY=http://127.0.0.1:3000 \
  bin/pnpm exec vitest run src/features/relay/scheduled-messages.live.test.ts
```
