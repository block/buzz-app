# Builderlab

The bundled `block.builderlab` plugin adds Settings → Integrations → Builderlab.
With a configured native federated authority, it also registers
`block.builderlab/builderlab` in Agents2's new-agent type picker.
This type has empty configuration and no execution handler yet; existing remote
agents remain in Settings until the later migration.

- Shared [`federated-identity`](../../features/federated-identity/) owns the
  public login projection and UI. Native Rust owns browser handoff, exchange,
  verification, secure persistence, and cancellation. Plugins receive no token.
- `agents/` consumes scoped `federatedIdentity.request()` and public session
  revision. API controls are unavailable until the same-origin NIP-FA extension
  and API authentication contract are agreed. Sign-out and navigation discard
  late results. Existing catalog agents are not automatically registered into
  Buzz communities. Existing operation behavior below is retained for that API
  contract; it is not claimed as enabled by an adapter-only login.
  Creation registers a name, then attests its key using the host's existing
  owner authorization. When a community is selected, attestation includes its
  WebSocket URL to enroll with Beekeeper; Personal space omits it. An unattested
  row offers **Finish setup**; no second registration is needed. Pending
  registration UUIDs survive restart and are scoped to server, verified account
  and name. Retry the same name after an
  uncertain failure within the server's seven-day replay window. Credentials
  and owner proofs are never stored.
  With a connected community selected, activation is followed by owner-signed
  kind-30177 registration through the session's durable outbox. Completion waits
  for relay acceptance and shared agent discovery. Names use the existing shared
  naming service; picker, archive and membership policies remain in their owners.
  Pending enrollment intent is scoped to server, account, community and Buzz
  identity. Opening Settings after reconnect/restart resumes intended Active
  creations; **Retry community setup** reuses a pending publication without
  registering or attesting again. Personal space skips relay registration.
  Creation never adds channel membership.
  Optional **Agent instructions** are saved through Beekeeper's `update-agent`
  after activation and community setup. Active rows offer **Edit**
  with Save and Cancel; saving replaces the text, and an empty value clears it.
  `list-agents` requests `include_instructions: true` to populate the editor.
  Instructions affect newly accepted tasks and are never published to the relay.
  Drafts stay in memory across setup/save retries and refreshes; a failed save
  can be retried on the same agent without creating another. Navigation, restart
  or sign-out discards drafts. Text is limited to 20,000 characters.
  **Delete** confirms owner-signed kind-5 deletion of the selected
  community's registration, refreshes discovery, then deletes the runtime through
  Beekeeper. Personal space only deletes from Beekeeper. Failure leaves the row
  available for manual retry; an already-missing Beekeeper agent counts as success.
  Account-scoped deletion tombstones (`buzz.builderlab.deletion.v1:`) persist to
  fence new enrollment after restart or in another community. They contain only
  server/account scope and agent pubkey. Standard Web Locks, also used by the
  app's read-state sync, order registration and deletion
  for the same scope across app windows; deletion waits for an issued registration
  attempt to settle, even when its caller cancels. If that session retires, the
  lock drain ends without confirming or discarding its receipt; a ten-second
  bound also covers disposal without notification. Setup requires Web Locks.
  Successful deletion retires failed or confirmed registration receipts.
  Deletion does not archive identities, remove channel memberships, erase history,
  or clean registrations in other communities.

Deletion follow-ups requiring shared relay/outbox support:

- Relay acceptance alone does not prove coordinate absence: clock skew can leave
  a newer registration advertised after the runtime is deleted. A fresh strong
  relay-only read is needed; `session.read()` includes local evidence. Failed
  discovery reads currently stop backend deletion, but are not absence proof.
- Web Locks do not cover other devices or survive process exit. A request whose
  delivery becomes unknown may arrive after its lock is released. The tombstone
  fences later admission, not that issued request; durable reconciliation is
  needed to compensate late arrival. Unknown registration receipts are retained
  because the shared outbox cannot safely retire them, and still consume a slot.

The native authority uses the public
[`BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG`](../../../docs/configuration.md#federated-identity-build-input)
build descriptor. Standard NIP-FA routes preserve its adapter prefix. Native
sign-in uses `return_to` and S256 handoff, with verification through `/v1/session`.
The API client uses the descriptor's relative API prefix without upstream headers.

The former plugin `oauth/browser.test.ts` and `oauth/session.test.ts` credential
coverage moved to native `federated_identity` protocol/storage/lifecycle tests and
`oauth_callback` real loopback tests. Shared `Login.test.tsx` owns pending,
cancel/retry, optional email, and plugin unmount behavior. Shared service tests
exercise Cordis registration/disposal and stale native events. Agent client,
enrollment, and RemoteAgents tests retain their operation/idempotency contracts.
Generic proxy and Buzz-managed CLI acceptance remain explicitly deferred.
