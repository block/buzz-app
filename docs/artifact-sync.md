# Local artifact sync

The host saves relay records through `ArtifactStorageService`. Each plugin defines one collection and one fixed query. A Web Lock covers `{viewer,relay,owner,collectionName}`. Its owner cancels reads and waits for commits before it releases the lock.

The native transport exposes `session.artifactIncremental` when the relay advertises the exact `artifacts.incremental` v1 contract. It covers permanent channels, 100-row pages, 100-ID current reads, an 8 MiB response bound, and a 30-day checkpoint lifetime. The relay prerequisite is [PR 8523](https://github.com/block/buzz/pull/8523).

The client sends `artifact: "incremental"` requests. WebSocket sync uses `artifacts.sync` and `session.artifacts.sync()` for a complete initial set followed by live changes. Each capability works independently. The saved store uses incremental reads so a restart can resume from its last checkpoint.

The first read discovers authorized records. Later reads use a checkpoint with a 120-second overlap from the last successful server start time. Only a full paged pass saves progress. Live pushes request current-ID reads through the same collection queue. They do not advance progress or directly write saved rows. The existing outbox acceptance observer also requests a current read.

The client applies signed upserts and explicit removals. A removal uses the locally observed revision for a conditional write. It retains the body and preferences, and marks the record unavailable. A failed commit prevents progress. Empty replies never establish absence.

A policy change or an expired checkpoint requires a fresh query plus bounded revalidation of saved IDs. Missing, unmatched, and unauthorized IDs return the same unavailable result. Recovery saves progress only after both steps succeed. It does not return a hidden roster.

Refresh generations, schema checks, and owner cancellation fence each commit. Failed reads keep saved progress and data. Transient failures get three short retries, then a delay of 60–90 seconds. Invalid replies and capacity failures use that delay directly. Each long retry adds a fresh random delay of less than 30 seconds to the 60-second minimum. A persistent failure exposes `refreshError()`. Successful delta completion clears it. A 60-second repair runs independently of live traffic and respects a pending retry delay. A bounded set holds up to 1,000 live IDs; overflow requests another delta.

The 120-second overlap assumes bounded database delay. It does not prove recovery from every delayed commit. TTL retirement is outside this contract. Native end-to-end verification needs the compatible relay and client together.

## Community-scoped artifacts

When the relay advertises NIP-11 `artifacts.community_scope` version 1 and lists `nip-ar` in `supported_extensions`, `session.artifacts.communityId` is the community's id and `session.artifacts.typePolicy` is present. Otherwise both are absent, so a plugin can check `communityId` synchronously before it shows anything that needs community artifacts.

`session.artifacts.sync({ artifact: "current", scope: "community", "#type": [type] })` keeps one type's current community artifacts. It needs exactly one `#type` and no `#h`, and it has the same statuses as a channel sync; `restricted` also means the viewer lost access to the community. Community records are kind-45010 revisions with a `community` tag and no `h`. Plugins write them with `configArtifactWriter` and read a head with `snapshotRead`.

`typePolicy.read(type, signal)` returns `{ policy, revision }`, where `policy` is `everyone` or `admins` and `revision` is the id of the type's current kind-9034 command, or `null` when the type was never set. `typePolicy.set({ type, policy, prev }, signal)` signs one kind-9034 command for this community as the viewer and publishes it once. `prev` is `"0"` or the current revision. It resolves `{ id, ok, message }`: `message` is the relay's answer when the host keeps it, and empty after a transport failure. It rejects only when the change is malformed, signing fails or the signal aborts. It never retries; read the policy after every outcome to learn what the relay holds. The relay accepts the command only from a direct owner or admin.

The type policy acts with the viewer's authority, like the session's other administrative writers (`memberAdministration`, `channelLifecycle`): any plugin in an admin's session can change any type's write policy. Kind 9034 is signed only through this typed route, never through the artifact writer.
