# Convert a DM to a channel thread

The channels plugin owns this feature. Its menu and message action open the
shared Dialog form; request cards render inside the existing conversation host.
Navigation owns the addressable `dmMove` dialog and its dismissal visits. The
feature service stays mounted for the community even when the DM is not open.
Partial conversion starts only from a top-level DM message. Thread replies cannot
start a conversion; whole-DM conversion still preserves existing reply structure.

## Consent and publication

A request names an immutable source roster, destination, scope boundary and
approval deadline. Every human signs their own approval; a verified local-agent
owner approves for their agents. Responses bind to the signed request event ID.
An approving device's durable worker ID selects which device may post.

Until everyone approves, the deadline applies and no destination writes occur.
After unanimous approval, the initiator waits for online presence and a fresh
ready response from each approving device. A signed commit records the cutoff
before invitations, the opening post or copies. Only the initiator may cancel
before that boundary. Private destinations require existing membership for all
source authors; public destinations add missing authors after commit. An
existing guest, or a destination admitting new guests, cannot promise writable
participation and is rejected before approval.

Each app signs its human's copies with the existing session outbox. Local-agent
copies use native custody and authenticated agent publication, with prepared
signed bytes retained before publication. No private keys cross IPC. Hosted
agents and patches are unsupported. Attachments retain their current file links
and metadata within the same community, including attachment edits. A move is currently bounded to
5,000 loaded source events; oversized or incomplete reads stop the conversion.

Source reads use writer consistency and the production edit/delete fold. The
commit cutoff bounds which original messages participate; edits are refreshed
before copying. Copies preserve the original author, text, mention display
bindings, emoji, order and reply parents. They do not repeat mention pings.
Provenance changes display order, never event timestamps or read-cursor evidence.
Each copy displays its original date and time in the viewer’s local time zone as
“Originally sent”; its ordinary message timestamp remains the copy’s posting time.
Deleted parents are followed using IDs previously observed by the device. If a
deleted link is missing and a surviving ancestor cannot be verified, the move
stops instead of guessing the reply structure. The ancestry cache retains no deleted content; pending delivery receipts are retained until resolved.

## Recovery and relay load

The per-community/viewer journal retains signed controls, worker identity,
ancestry IDs and copy receipts. Cross-window locks serialize a request. The
existing outbox persists human intents with recovery keys and renewed admission
guards; native agent receipts retain the signed event for identical retries.
Uncertain old copies are checked against the writer before reuse. Changed,
unaccepted copies cannot be replaced while their old delivery window remains
open. Expired guarded copies may be retired only after fresh writer readback.

On connection, a short randomized delay precedes one combined paginated control query covers active DMs, resuming
from the saved cursor with the existing relay clock-skew overlap. Live controls,
copies and presence drive work. An active move has a jittered 30-second backstop;
errors back off exponentially up to five minutes. Each owned active pass reads
its controls and destination metadata; ready/posting phases also read bounded
source history and accepted copies. Pending and unowned requests do no background
per-request reads. A failed request does not stop another request from advancing.

Each new conversion requests fresh consent and creates a separate thread. Earlier
conversion notices are excluded in every state, including completed and cancelled
requests. They do not offer the message action to convert from that point.

Coordination events are kind 9 with a versioned topic. Only request events become
cards; other valid controls are omitted by the message fold and excluded from
ordinary incoming notifications and agent live listeners.

## Validation and trying it

Focused Vitest coverage exercises production folding, authorization, expired
approvals, cancellation, readiness workers, source edits/deletes, guarded retries,
and two real relay sessions sharing a signed fixture transport. The multi-client
journey covers public invitations, actual copy authors, notification suppression,
local-agent owner approval and completed restart deduplication. Presence is a
controlled adapter in those tests; they do not prove native lifecycle behavior.
The native tests exercise the real Tauri IPC handlers with synthetic credential
backing and a loopback TLS endpoint: custody restoration, valid signatures,
identical retries after uncertain receipts, NIP-98 authentication, and denied
custody. Capability tests allow the main window and reject other webviews. These
tests do not exercise the OS Keychain or packaged webview.

The browser journey targets menu portals, focus/history integration and dialog
layout in light/dark and wide/narrow views. A fixture relay is not a production
relay or a full native app run. See the change's validation report for executed
checks and gaps; test source alone is not evidence of a passing run.

For acceptance, use disposable identities and a local relay only:

1. Open the same DM in two app profiles. Include a local agent owned by one
   participant to exercise native signing. Join only the initiator to a public
   destination channel.
2. Choose **Convert to thread**, keep the default 24-hour approval window, and
   request approval. Before the other approval, confirm there is no destination
   post or added member. Exercise decline and initiator cancellation separately.
3. Edit one source message and delete another. Approve on the other profile.
   Confirm the missing participant is added and a new channel thread contains
   the latest source text, actual authors and nested replies, omitting deletion.
4. Repeat with a participant offline after approval. The move must wait without
   expiring. Reconnect that approving app and confirm automatic completion.
5. Restart an approving app during a partial copy; reconnect and confirm that
   each original appears once. Disconnect during signing and edit/delete its
   source before retrying; stale copies must not publish automatically.
6. Repeat with a private destination missing a participant and with an existing
   guest. Both must fail before destination writes. Exercise Back, Forward,
   explicit Cancel, keyboard controls, enlarged text and both color themes.

Human testing and an actual native multi-client run remain required before
marking a pull request ready for review. Do not add `buzz-review-completed` based
on fixture tests alone.
