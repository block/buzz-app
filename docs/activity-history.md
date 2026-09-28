# Saved Activity: native new-only history

Saved Activity is separate from the live RAM projection and from old Buzz's archive.
It is implemented for the current native account/relay lease. Development-broker
sessions remain live-only. No old archive is scanned, migrated, imported or modified.
Packaged/live-account acceptance is still a separate, attended gate.

## Capture and retention

The native observer route verifies the original kind-24200 signature, recipient,
agent tag, freshness, sizes and NIP-44 payload before capture. The archive stores
the unchanged signed encrypted envelope, receipt sequence/time and plaintext public
routing/index metadata. No decrypted prompts, tool input/output or responses are
written. This is encrypted-body storage, **not whole-database encryption**.

`activity-history/activity.sqlite` lives under the new app's data directory, with
private directory/file permissions. Native Rust/rusqlite owns it; plugins get no
file path, SQL, keys or general decrypt API. SQLite uses DELETE journaling, FULL
synchronization, memory-only temp storage and 4KiB pages. The main-file maximum is
120MiB; a worst-case rollback journal plus headers stays within the256MiB planning
high water. Physical capacity can evict before the logical128MiB encrypted-payload
cap. Age (30days from native receipt),20,000 envelopes and128MiB payload apply globally
across partitions, whichever is reached first. Duplicates do not refresh age/order.

Pruning runs locally at app startup and on append/read. A closed app cannot prune;
expired content is removed on next open before it is returned. Clock rollback does
not make sequence order an age index. Full/corrupt/symlink/unknown-schema storage
fails visibly without plaintext fallback or erasing a corrupt store. Physical-space
admission evicts oldest envelopes and records a gap before new writes.

A single bounded16-item worker preserves capture receipt order without synchronous
disk work in the shared socket actor. A full queue produces a live save warning and
coalesces a durable gap. Pending gap evidence remains read-visible even if persistence
is blocked or fails. The callback is best-effort telemetry, not a complete ACP log.
Storage failure does not turn live Activity into proof of saving.

## Scope and access

Each envelope is partitioned by exact viewer and canonical relay origin, deduplicated
by event ID, and indexed by every supported envelope/immediate-batch child channel.
Nested batches are unsupported and not archived. Unknown membership does not admit
scoped capture. The native session consumes verified relay-authored kind39002 rosters;
newer removal wins over an older positive response. Disconnect clears current access.

A historical read performs bounded fresh signed roster reads under the lease's captured
relay author before returning plaintext. All indexed channels in a mixed envelope need
current access. After decrypting native rederives the index and verifies exact event,
agent and scope again. An index cannot relabel ciphertext to grant access. Channel
views never inherit a parent scope for unscoped children. Whole mixed envelopes are
purged on verified removal. Cleanup is coalesced independently of read admission;
pending/failed cleanup blocks historical output, including after a later regrant.

Reads return at most100 envelopes/2MiB encrypted input per page, with native epoch and
store revision. Pages from different revisions are not combined. A whole page command
is capped at10seconds and extra mixed scopes at32. Decrypted pages are transient,
scoped to a disposable frontend session; logout, cache/access reset and disposal fence
late results. Historical records never enter live turn/typing, unread or outbox folds.

## UI and strict reply history

Profile Activity offers a collapsed **Saved Activity** disclosure. Known agents come
from `session.agentChoices`, not another archive inventory. Reads start only on explicit
expansion, with up to500 envelopes retained in that view; no startup preload, polling,
or capture activation from reads. The generic inspector also offers saved history for
its selected exact agent/scope. Current profile channel-selection policy is unchanged.

When a reply's live interval is missing, **Saved activity for this response** can inspect
up to five pages. It runs the existing strict send-boundary selector only if that bounded
retained scope is complete and not marked trimmed/gapped. This conservative bound can
make recent reply history unavailable when more/evicted evidence may contain conflicts.
It never guesses from time, prose or the most recent turn, and never substitutes general
history for a reply. Profile history can still show partial retained evidence with a gap
warning. Closing/reopening resets the read cursor and revision capture.

## Disable, clear, delete, restart

- Closing a panel does not release the plugin-owned capture lease.
- Disabling Activity stops its observer route and invalidates queued capture; ciphertext
  stays. Re-enable starts fresh live capture and permits lazy reads of retained history.
- Ordinary cache clear removes plaintext and live state, not the archive.
- **Delete saved Activity** confirms deletion of the entire current viewer/community
  partition, not only the selected agent. The native epoch fences queued writes/reads.
  A successful delete clears live RAM and renews observer demand, not the chat socket.
  Failed deletion remains visible and restores the old capture epoch; live evidence is
  not optimistically cleared.
- A persisted deletion cutoff covers the accepted five-minute clock-skew range, so
  recently deleted envelopes cannot reappear after reconnect/restart. This deliberately
  withholds saving normally timestamped new frames for up to five minutes after delete,
  reports them as **not saved**, and records that gap. Live Activity still displays them.
- Logical deletion is not forensic erasure of filesystem snapshots/backups.

## Evidence and acceptance limits

Native tests use temporary databases and synthetic identities: ciphertext/dedup/reopen,
viewer/origin isolation, current roster reads, mixed-scope denial, replay cutoff, queue
gap persistence, failed delete, read-slot-saturated purge, physical capacity recovery,
and age expiry under clock rollback. Mounted UI tests cover lazy reading, deletion
pending/failure/success, current-generation revocation, incomplete reply history and a
complete exact response interval. Socket tests independently exercise real loopback
WebSocket AUTH/encryption/DTO delivery, never a real account.

These are local checks. Attended packaged capture/restart/deletion with the user's real
account, plus required hosted integration/review, remain mandatory before MVP/release
completion. No native launch or Keychain consent is implied by creating the package.
