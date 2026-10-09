# Information-flow control

The policy library is ported from `block/buzz` at
`c94c7128dd6c5cf12486cad0ed767b4ac21ca56a` (PR #8226).

- `ifc-core` supplies reader-set labels, their flow ordering, and accumulated
  flow state. It has no Buzz dependencies.
- `buzz-ifc` derives execution domains from verified Buzz facts and labels
  resources from their own conversation. Domains compare structurally; event
  IDs, topics, and membership ordering do not affect equality.
- `IfcSession` preserves a domain's flow state and checks reads, non-publishing
  calls, and publications. `AuthorizedPublication` owns the exact checked bytes.

These APIs perform no I/O. A broker must verify signatures, establish the
community and current membership, and retain the IFC session for as long as the
corresponding agent state survives. Domain equality is not a temporal epoch.
Unknown inputs remain recorded and block publication.

The port retains the source policy, public APIs, doctests, and regression tests.
Its only adaptations are local Cargo dependencies, the app's Nostr version,
and a local UUID-backed `CommunityId`, avoiding the relay's `buzz-core` crate.
The [design paper](practical-information-flow-for-buzz-agents.md) describes the
model and its assumptions. Adding these crates alone does not mediate Agents2.

## Opt-in native history read

The first integration mediates one operation: the recent history included in a
Claude Code Agents2 turn in a selected DM, when the trigger is not a thread
reply. It uses the existing native agent broker and its credential custody.

Set `BUZZ_APP_IFC_READ` in the native app's environment before starting it:

```sh
BUZZ_APP_IFC_READ='{"agent_pubkey":"<agent hex public key>","relay":"wss://<community host>","community_id":"<trusted community UUID>","channel_id":"<DM UUID>","relay_pubkey":"<trusted relay hex public key>"}' just desktop
```

The IDs and relay key must come from trusted host configuration. The configured
relay must equal the agent's saved community origin. Absent configuration leaves
the current path in place; malformed configuration rejects history requests.
Only the specified agent and DM opt in. Browser and Codex agents are outside this
slice.

Native verifies the trigger and the relay-signed kind-39000 metadata and
kind-39002 membership. It requires an active private DM and current agent and
requester membership. It derives the domain from the complete member set and
labels the resource independently from that conversation's readers. It checks
`channel.read` and `IfcSession::read`, fetches at most 13 signed messages of kind
9 or 40002, and rechecks current policy before returning any of them. The whole
native operation has a four-second deadline; existing response-size limits apply.

One retained `IfcSession` holds a native generation UUID for the selected DM.
Reissued policy events and topic edits preserve it; a changed domain rotates it.
The Claude runtime clears both the live process and saved model session before
accepting a new generation, including its first read after a runtime or app
restart. Rejected reads abort the prompt, clear that conversation's model state,
and use the existing failure reporter to ask for another attempt. The next valid
read can start fresh. No permanent invalidation, membership cache, request
journal, or lifetime budget is introduced.

Instructions, files, memory, thread reads, other tools, and publications remain
unmediated. The IFC session is marked as having unknown input. This read hook
does not establish an end-to-end noninterference property or detect membership
changes that occur and revert between policy observations.

For acceptance with an agreed isolated agent and DM, enable the configuration
and send a non-thread mention. History should reach a fresh Claude session.
Change only the topic and send another mention: the same model session should
continue. Change the members and send another valid mention: Claude should start
a new session with recent history. A refused read should show a failure reply,
deliver no prompt, and allow a later attempt. Runtime and human acceptance are
deferred on this draft; local tests were not deliberately run.
