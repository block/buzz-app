# Scheduled messages

When the relay advertises `buzz-scheduled-messages-v1`, the composer shows an
arrow beside Send. Choose tomorrow at 9 AM, Monday at 9 AM or a custom local time
within 120 days. Confirm the timezone and full date before scheduling. The draft
clears only after relay acceptance; a concurrently edited draft stays intact.
Attachments finish uploading before the queue accepts the message.

Enable the bundled **Drafts & sent** plugin to manage messages in one place.
Its **Drafts** tab lists unfinished messages saved automatically by the composer;
**Scheduled** lists queued messages and **Sent** shows recent sent messages.
The sidebar shows a draft count and a clock with the scheduled count. No separate
Scheduled messages sidebar entry is needed. Scheduled rows support editing,
rescheduling, sending now, cancelling to drafts and deleting. The main composer
preserves formatting, mentions, attachments and thread destinations. Editing a
queued message retains its original destination and attachment tags.

Draft conversion currently supports text, formatting, mentions and root-thread
replies. It refuses attachments, nested reply parents, media targets, explicit
model/effort settings and unaddressed slash commands, preserving the scheduled
message instead of silently changing its delivery. Ordinary drafts remain local
to this device; cross-device draft sync is not part of this change.

The session's `scheduledMessages` service prepares ordinary kind:9 messages
through the existing message builder. A native or browser-host signer signs the
exact approved event with its future `created_at`; the plugin receives no keys.
The native URL allowlist and broker use the fixed `/scheduled-messages` POST
route, authenticated with ordinary NIP-98 admission. Signing and requests are
revoked when the session closes. Scheduling continues on the relay after that.

The relay owns revisions, timestamps and delivery state. Lost create responses
retry the same UUID/event; stale revisions fail visibly. Refresh the queue after
uncertain responses before making a different change. A failed delivery stays
visible for review. Queue support is absent on older relays, so the composer
keeps its ordinary sending behavior there.

The relay implementation and mandatory two-phase enablement procedure are in
[block/buzz's scheduled-message protocol](https://github.com/block/buzz/blob/main/docs/scheduled-messages.md).
Do not enable during a mixed-version relay rollout. Pending messages retain their
selected event timestamps if an outage delays delivery.

For isolated end-to-end verification, start a local relay with scheduling enabled
and run `BUZZ_SCHEDULED_TEST_RELAY=http://127.0.0.1:3000 pnpm exec vitest run
src/features/relay/scheduled-messages.live.test.ts`. This test refuses remote
hosts and uses fictional random identities. Browser fixtures additionally cover
the date dialog, invalid time, refusal, retry and draft preservation in Chromium
and WebKit. Native runtime behavior still requires human testing before release.
