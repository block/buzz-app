# A primary agent for each Solo chat

**Proposal, October 20, 2026.** This is a design for review, not a description
of shipped behavior. Implementation PRs can link here and refine the contracts.

## TL;DR

A Solo chat should work like a session: choose a harness, model and effort,
then talk without tagging an agent on every message. A chat has one **primary**
agent role, independent of its signing identity or native harness session.
Named agents remain useful presets, but creating one is optional.

Explicit agent tags replace the implicit primary for that message. Switching
harnesses keeps the conversation and orders its turns across the switch.
Converting to a channel ends automatic replies: everyone tags the agent there.
Pi would be a separate agent-type plugin, using Pi's RPC subprocess protocol.

## Why this belongs in Solo

People arriving from session-based agent tools expect a conversation to retain
its harness, model and effort. They should not need to configure a named agent
or keep its tag in the composer just to continue that conversation.

Solo already supplies the channel, history, membership, Canvas and conversation
surface. Keep those owners. This proposal adds a primary binding and resolves
recipients through the existing send and agent-delivery paths; it does not add
another chat store, composer, permission system or general-purpose scheduler.

```text
Solo chat (existing channel ID, history, Canvas and signed membership)
  |
  +-- revisioned primary binding (owner-authorized configuration)
  |     stable role -> harness/type -> saved or automatic identity
  |     chat defaults: harness + model + effort
  |
  +-- message recipient resolver
  |     no explicit agent tags -> primary
  |     explicit agent tags    -> exactly those agents
  |     ordinary agent reply  -> context, unless it tags the primary
  |
  +-- existing signed send + recipient-keyed model/effort picks
        |
        +-- ordered primary turns for this chat
              |
              +-- harness native session, scoped to this chat
                    switch harness -> history handoff, not tool replay
```

Here, **harness** means the execution integration, such as Codex or Goose;
**identity** means the agent's signing identity; **native session** means the
harness's working conversation. A **saved agent** is a user-configured agent
with a reusable name and settings. The primary is a chat role, not a new kind
of account. See [Agents](../agents.md), [Solo](README.md) and
[shared sessions](../sessions/README.md) for the existing boundaries.

## Starting point on main

The following references pin the inspected `main` snapshot,
[`5273f9f`](https://github.com/block/buzz-app/tree/5273f9f20f6448416f75f2515ee604648048c9ed),
an ancestor of this PR's base, so later implementation can distinguish the
baseline from the proposal. These are snapshot claims, not a moving-main audit.

| Existing behavior | Owner at that snapshot |
| --- | --- |
| The owner's Solo composer requires an explicit agent mention. | [`Conversation.tsx:266–277`](https://github.com/block/buzz-app/blob/5273f9f20f6448416f75f2515ee604648048c9ed/src/features/conversation/Conversation.tsx#L266-L277) |
| A new draft chooses a default agent and starts through ordinary channel setup/send. The default is a device/account/community preference, not an existing chat's primary. | [`SoloDraft.tsx:240–292`](https://github.com/block/buzz-app/blob/5273f9f20f6448416f75f2515ee604648048c9ed/src/features/solo/SoloDraft.tsx#L240-L292), [`default-agent.ts:7–55`](https://github.com/block/buzz-app/blob/5273f9f20f6448416f75f2515ee604648048c9ed/src/features/solo/default-agent.ts#L7-L55) |
| Other Solo senders can infer a sole agent from complete participant evidence; multiple agents require an explicit choice. This is not a primary binding. | [`MessageComposer.tsx:1149–1165`](https://github.com/block/buzz-app/blob/5273f9f20f6448416f75f2515ee604648048c9ed/src/features/messages/MessageComposer.tsx#L1149-L1165), [`recipients.ts:4–41`](https://github.com/block/buzz-app/blob/5273f9f20f6448416f75f2515ee604648048c9ed/src/features/solo/recipients.ts#L4-L41) |
| Composer model/effort controls discover the selected agents' catalogs. Signed picks are keyed by recipient and require that recipient's `p` tag. | [`ComposerModels.tsx:30–70`](https://github.com/block/buzz-app/blob/5273f9f20f6448416f75f2515ee604648048c9ed/src/features/messages/ComposerModels.tsx#L30-L70), [`messages.ts:28–34,82–93`](https://github.com/block/buzz-app/blob/5273f9f20f6448416f75f2515ee604648048c9ed/src/features/relay/messages.ts#L28-L93) |
| The runner honors per-message picks only from the agent's owner. Unsupported picks or failed model discovery can currently leave an override unapplied. | [`runner.ts:123–157`](https://github.com/block/buzz-app/blob/5273f9f20f6448416f75f2515ee604648048c9ed/src/features/agents/runner.ts#L123-L157) |
| Another agent carrying the owner's `auth` tag wakes an agent only by directly naming it; watches do not bypass that loop guard. | [`runner.ts:1445–1487`](https://github.com/block/buzz-app/blob/5273f9f20f6448416f75f2515ee604648048c9ed/src/features/agents/runner.ts#L1445-L1487) |
| Agent memory is keyed by community scope and pubkey, and Goose injects that identity's core at session start. | [`core-memory-cache.ts:56–65,89–107`](https://github.com/block/buzz-app/blob/5273f9f20f6448416f75f2515ee604648048c9ed/src/features/agents/core-memory-cache.ts#L56-L107), [`runtime.ts:574–585`](https://github.com/block/buzz-app/blob/5273f9f20f6448416f75f2515ee604648048c9ed/src/bundled/goose/runtime.ts#L574-L585) |
| Agent creation requires a name, and changing an agent's type affects that identity rather than one chat's primary. | [`service.ts:1425–1439`](https://github.com/block/buzz-app/blob/5273f9f20f6448416f75f2515ee604648048c9ed/src/features/agents/service.ts#L1425-L1439), [`service.ts:1990–2039`](https://github.com/block/buzz-app/blob/5273f9f20f6448416f75f2515ee604648048c9ed/src/features/agents/service.ts#L1990-L2039) |
| Convert to channel changes details without replacing the channel, removes the Solo label and clears Solo workspace filing. It has no primary lifecycle yet. | [`ConvertToChannel.tsx:129–222`](https://github.com/block/buzz-app/blob/5273f9f20f6448416f75f2515ee604648048c9ed/src/features/solo/ConvertToChannel.tsx#L129-L222) |
| Goose exposes model choices but no effort choices in its catalog, and its per-turn session options accept model rather than effort. | [`setup.ts:204–227`](https://github.com/block/buzz-app/blob/5273f9f20f6448416f75f2515ee604648048c9ed/src/bundled/goose/setup.ts#L204-L227), [`sessions.ts:212–230`](https://github.com/block/buzz-app/blob/5273f9f20f6448416f75f2515ee604648048c9ed/src/bundled/goose/sessions.ts#L212-L230) |

Build on the merged work in
[#1186 (per-message Goose picks)](https://github.com/block/buzz-app/pull/1186),
[#1250 (saved thinking level)](https://github.com/block/buzz-app/pull/1250),
[#1266 (AI defaults and Goose configuration)](https://github.com/block/buzz-app/pull/1266),
[#1367 (Goose model discovery)](https://github.com/block/buzz-app/pull/1367) and
[#1348 (harness defaults naming)](https://github.com/block/buzz-app/pull/1348),
rather than introduce a parallel model/effort protocol. Preserve shared conversation ownership in
[Shared conversation composition](../conversation-composition-vision.md).

## Who answers a message

A Solo chat has one primary. With automatic responses enabled, it answers every
untagged human message with execution authority and every authorized message
deliberately delivered from another session, without requiring a visible tag.
Delivery still requires membership and execution authority; a session link is not a delivery.

| Message | Proposed recipients |
| --- | --- |
| Human message with no agent tags | Primary |
| Human message tagging another agent | Only that agent |
| Human message tagging another agent and primary | Both explicit recipients |
| Authorized cross-session delivery without agent tags | Primary |
| Ordinary tagged agent's reply without a primary tag | No new primary turn; context for its next turn |
| Agent reply directly tagging primary | Primary, subject to the existing agent-to-agent naming guard |
| Edit, reaction, typing or activity event | Not a new conversation turn |

Explicit recipients **replace**, rather than union with, the implicit primary.
A human mention is not an agent recipient. Resolve from the shared
`session.agentChoices` evidence and current membership, not a second inventory.
With multiple members, do not infer the primary from roster order or recency.

No visible mention does not mean no protocol recipient. Resolve and sign the
primary recipient, retaining the existing recipient-keyed picks and direct-tag
guard. The signed event must also distinguish **implicit primary targeting**
from an explicit mention; a bare `p` tag cannot carry that distinction. Bind any
one-message picks to that resolved recipient. The transport owner should choose
the marker encoding and legacy compatibility, not a parallel send protocol.
The runner must check current Solo metadata for marked implicit turns, even if
a stale client supplied the recipient after conversion. Ambiguous legacy targeting
must fail closed, not be assumed explicit merely because it has a `p` tag.

A tagged agent's response remains visible in the conversation. The primary
reads it when next invoked but does not automatically answer it. A deliberate
cross-session message must be distinguishable through trusted delivery metadata
from that ordinary reply; arbitrary message text or a claimed session ID cannot
create execution authority or bypass the existing name-required agent-to-agent guard.
That guard requires a direct tag; this proposal does not claim an existing hop-count limit.
An owner `auth` tag alone never qualifies as deliberate cross-session delivery.
The exact delivery envelope needs agreement with its existing transport owner.

Automatic replies must have a discoverable **mention-only** option in chat
settings. Show the active primary and response mode before sending, including
in accessible composer labeling rather than visible chrome alone. Do not
silently change the behavior of existing chats during rollout; adoption and
legacy behavior need an explicit migration policy.

## One primary role, reusable identities

At creation, choose either:

- A harness, model and effort directly. Buzz provisions the backing identity;
  there is no separate naming or agent-creation prerequisite.
- An existing saved agent as a preset for the primary. Its instructions and
  permissions stay with that agent; the chat gets its own run defaults.

For direct selection, provision one automatic identity per
**owner + community + harness**, and reuse it across that owner's chats.
Hide it from ordinary saved-agent management, not from the signed member roster,
message authorship, access inspection or activity needed to understand a run.
Keep it in `session.agentChoices` identity/selection evidence and composer catalog
discovery, subject to the existing membership and archive policies. Hide it from
unrelated saved-agent choosers through that shared projection, not per-surface
filters; bound-chat targeting and catalog discovery still need its evidence.
It must have a readable display label even before it is saved as a named agent.
Provisioning and retry must converge on that identity, including across devices.
How its key/config is synchronized belongs to the existing agent config owner.

Sharing an identity must not share a native session, conversation history or
mutable run defaults. Each chat keeps its own native session mapping and workspace
settings; users may deliberately choose the same filesystem checkout. Two chats
using the same automatic identity can choose different models and efforts without
changing one another.

Automatic identities also require **chat-scoped memory**. Include the channel ID
in the existing memory owner's namespace and cache key, partitioning reads,
writes and core injection by community, identity and chat. Never seed a chat from
identity-wide core memory or fall back to it when chat scope is missing. The
baseline `CoreMemoryCache` keys by scope and pubkey, and Goose injects that core
at session start; separate native sessions alone do not isolate it. Keep automatic
identity reuse disabled until this boundary works. Explicitly shared memory would
require a future disclosed owner opt-in; it is outside this proposal.

Switching harness can switch signing identity. The chat's primary role, history
and pending-turn order remain stable. Do not retype the shared identity in place:
that would also change other chats using it. A one-message harness override uses
the requested harness identity for that turn, then leaves the sticky choice intact.
Any needed membership admission is visible and owner-authorized, not a side effect
of sending. For a saved primary, both sticky switches and one-message overrides
must preserve its applicable instructions and permission restrictions without
expanding authority. If the target cannot represent them, make the switch or
override unavailable with an explanation;
never silently replace the saved agent with an unrestricted automatic identity.

## Proposed channel-scoped binding

The following is a **logical record**, not an adopted wire format, database
schema or instruction to add a new store. Maintainers should shape its storage
and revision checks with the existing channel and agent configuration owners.
It belongs to the channel, not the viewer's Solo workspace filing.

```text
PrimaryBinding
  channelId, communityRef
  revision                         # conflict-checked update version
  ownerPubkey                      # who may choose/change the binding
  primaryRoleId                    # stable within this chat
  agentTypeRef                     # harness plugin/type, fully qualified
  identityRef                      # saved agent or automatic harness identity
  responseMode                     # automatic in Solo | mention-only
  chatDefaults
    modelId, effortId               # explicit supported choices/default policy
```

`agentTypeRef` is the sticky harness selection. Change its identity and compatible
model/effort defaults together in one revision. Do not apply another harness's
model ID on switch-back; retain a compatible explicit choice or ask the user.

Native-session handles remain in the harness's existing session owner, keyed by
chat and execution target; they are not portable configuration or credentials
in this record. A turn admission receipt should capture its binding revision,
resolved recipients and effective harness/model/effort. Whether that receipt
extends existing message metadata or runner state is an implementation question.
For every primary turn, including an authorized non-owner or cross-session turn,
load chat defaults from the owner-authorized binding at admission, not from the
sender's picks or the shared identity's mutable defaults. Keep one-message picks
owner-scoped. The runner needs the captured choices; unreadable binding defaults
mean pending/error, never execution with identity defaults.

Only the binding owner can change it. A write compares the revision it read;
a stale editor reloads instead of overwriting a newer choice. Creation, membership
admission and binding publication need recoverable receipts: interruption must
not start an unbound run or provision a second identity. Missing or unreadable
binding state means pending/error, never a guessed primary.

## Harness, model and effort in the composer

Treat the three as equal first-class choices, sticky **per chat**, changeable
at any time. Reuse `ComposerModels`, its agent-type catalogs and existing
recipient-keyed picks. Expand that owner to show the implicit primary and a
harness choice, instead of adding a separate send path or raw model-ID field.

The composer distinguishes **chat defaults** from **this message only**.
A one-message override does not mutate the binding or saved agent. Explicitly
tagged secondary agents retain their own recipient-specific picks; the chat's
primary defaults must not overwrite them. Changes to a saved agent's global
model settings must not silently replace a chat's stored choices.

Resolve choices before signing/submission, then preserve them on retry and in
queued turns. A saved preset seeds chat defaults at creation using its effective
choices (agent override, device provider default, native default); it is not a live
fallback that can later retarget the chat. Precedence thereafter is an explicit
one-message choice, chat default, then a deliberately selected harness-default policy.
Codex's existing `sendDefaults` supplies concrete displayed picks even without a
user override. Preserve that distinction: refreshed binding defaults must replace
stale displayed defaults, never be submitted as intentional one-message overrides.
Unspecified is not an invitation to choose a different provider. Validate the full
combination against the current catalog.
If the harness is disabled, model unavailable, effort unsupported or discovery
incomplete, explain the problem and let the user correct or retry it.
**Never silently fall back to a different harness, model or effort.**
This is a stronger contract than the baseline runner's best-effort overrides.

A choice made while a run is active affects newly admitted turns, not the
in-flight turn or previously queued messages. Show which choices a pending turn
will use. Harnesses may steer compatible messages within an active native run;
a changed harness or incompatible model/effort must wait for the turn boundary.
[Codex's existing queue decision](https://github.com/block/buzz-app/blob/5273f9f20f6448416f75f2515ee604648048c9ed/src/bundled/codex/runtime.ts#L598-L615)
is a starting point, not cross-harness ordering by itself.

## Ordering and history across harnesses

These are implementation invariants, not promises supplied by a configuration
record alone:

1. **One ordered primary lane per chat.** A switch cannot start a new harness
   beside an unfinished primary turn. Preserve admission order across identities,
   reconnects and execution-device ownership. Secondary agents remain independent.
2. **Submitted turns are immutable.** Capture effective choices and binding
   revision at admission. Changing defaults never retargets accepted work.
3. **Stop is not completion.** Settle cancellation and output from the old turn
   before admitting execution in the replacement harness. Surface failed or
   ambiguous handoffs; do not start two turns to recover an uncertain receipt.
4. **History is input, not replay.** Start/resume a chat-scoped native session
   using an ordered transcript through a known message boundary. Preserve authors,
   explicit recipients, attachments and tool-result provenance where supported;
   never re-execute historical tools or re-deliver old messages as new triggers.
5. **Resume only compatible state.** A native session belongs to its harness.
   Switching away and back must reconcile intervening history before resuming it.
   If a transcript is too large or has unsupported content, show the handoff
   limitation and obtain a deliberate continuation choice; do not silently omit it.
6. **One-message switches obey the same rules.** Handoff into the temporary
   harness and reconcile its output before returning to the sticky harness.
   A one-message override is not an ordering or history exception.

Extend existing runner queues and session mappings at their owners. Establish
one execution-device owner before running a turn; maintainers should confirm the
claim mechanism and recovery boundary. Do not make every harness plugin implement
a competing primary scheduler. Reconcile with the landed
[#1314 (Solo follow-up queue)](https://github.com/block/buzz-app/pull/1314), including its
`follow-up-queue.ts` and `QueuedFollowUps.tsx` owners, before extending ordering;
this proposal does not prescribe a second queue.

## Membership, sharing and conversion

Signed channel membership remains access authority. The primary binding is
execution configuration, not a grant to read a channel, use a harness account,
change its tools or impersonate the owner. Provision/add the chosen identity
through ordinary membership admission before starting it. Removing membership,
archiving or disabling the agent must prevent new runs, even with a stale binding.
A different device must obtain that execution ownership rather than run the same
primary twice; this is a proposed invariant, not a claim of existing cross-device fencing.

[Share](sharing.md) keeps a Solo chat a Solo chat. Human messages there can
address its primary, but access to history alone does not authorize spending the
owner's harness account. The proposed default authorizes the owner and deliveries
authenticated on the owner's behalf; other senders need an explicit execution
grant, separate from membership. This adds an authorization contract beyond the
baseline's sole-agent recipient inference. Refuse unauthorized invocation visibly
instead of treating membership or the binding as consent. Show the restriction before submission;
receiving an unauthorized message must not start a primary turn or post an agent
reply merely to announce refusal. For a stale sender or a grant changed after
composition, report the runner refusal through run/activity status visible to the
sender and owner, without exposing private grant details. Per-message model/effort control remains
owner-scoped unless separately authorized; sharing must not weaken that boundary.
Adopting this proposal in an existing shared Solo chat can restrict guests' current
explicit mentions; migration must disclose that change and obtain owner adoption.

**Convert to channel** keeps the same channel, history, Canvas and members.
Offer optional creation of a named saved agent from the primary during conversion;
skip that step if it is already saved. If the user declines, keep a visible,
mentionable identity for the retained agent without requiring a reusable preset.
Do not rename a reused automatic identity globally just to name it in one chat;
the exact promotion/label mechanism needs agreement with the identity owner.

On successful conversion, switch to **mention-only for everyone, including the
owner**. Like moving from a one-to-one conversation into a group, people now
address the agent explicitly. Cross-session delivery must not retain an implicit
Solo wake-up path either. A mention still passes execution-authority checks. The
execution grant after conversion is scoped to the retained former-primary identity
in this channel. Preserve its grant evidence independently of primary binding
release; refuse execution if that evidence is absent or unreadable. Conversion
does not expand access or redefine unrelated saved agents' ordinary channel policy.
Automatic admission is effective only while current verified channel metadata
still carries `buzz.solo`; both resolver and runner enforce it at turn admission.
Any authorized label removal cuts off implicit admissions immediately, even from
an older client or if binding cleanup is interrupted. Unknown metadata cannot
authorize automatic execution. Mention-only governs new admissions; previously
admitted turns retain their captured choices unless explicitly cancelled.
Carry the binding forward explicitly in mention-only mode, or explicitly release
it while retaining the ordinary member; never leave an invisible automatic trigger.
Conversion, promotion and binding updates still need recoverable receipts; their
cleanup must not be the safety cutoff for automatic replies.

## Pi as another harness

Add a distinct agent-type plugin, not a saved-agent label or a claim that an ACP
preset runs Pi. [Pi's RPC documentation](https://github.com/earendil-works/pi/blob/fdce48eb404ec014adaf2ac10a3a53bc6b1740c2/packages/coding-agent/docs/rpc.md)
describes a long-lived `pi --mode rpc` subprocess with newline-delimited JSON.
Command acceptance is distinct from turn completion; subscribe before sending
and use the documented settlement events rather than assuming a prompt response
means the turn finished. The documented `disposition: "handled"` response is an
exception: the command completed without starting a turn, so no turn settlement follows.

[Agents](../agents.md) already documents Pi transcript support and a `pi-acp`
session banner. Keep that existing ACP path distinct; the proposed plugin exposes
Pi's RPC capabilities directly and does not replace or silently relabel ACP presets.

The proposed plugin owns process lifetime, command correlation, streaming,
cancellation, model/effort discovery and chat-scoped native-session recovery.
Map its supported operations to the existing agent-type interface, including
visible errors and actual usage where available. Unsupported capabilities stay
unavailable, not simulated by a preset. Verify the exact Pi version and RPC
behavior in that plugin's implementation PR; no live Pi validation is claimed here.
Coordinate with the open
[#1227 (shared ACP client/server pool)](https://github.com/block/buzz-app/pull/1227) and
[#1251 (generic ACP agent type)](https://github.com/block/buzz-app/pull/1251) at shared lifecycle boundaries,
without expanding this proposal into an ACP rewrite.

## Delivery as independent default-branch PRs

Each slice branches from then-current main, not another open implementation PR.
Land prerequisites first and keep each PR useful and reviewable on its own.
No slice should enable automatic sends before its required safety contracts work.

| Slice | Contract and focused acceptance evidence |
| --- | --- |
| Primary binding and recipient resolver | Revisioned owner writes; no-tag primary; explicit tags replace it; ordinary agent replies do not loop; mention-only opt-out. Cover stale/missing binding, owner-authorized defaults for other signers, legacy behavior and signed-recipient integration. Signed implicit-versus-explicit targeting and conversion's runner-enforced verified-label cutoff must survive stale clients and interruption. Include execution grants (owner-only default, visible restriction and runner refusal without a reply) and the trusted cross-session envelope; disable those admissions until their enforcement is present. |
| Automatic harness identities | Idempotent owner/community/harness provisioning and membership; distinct native sessions and chat-scoped memory reads/writes/core injection. Prove private chat A's memory cannot enter shared chat B using the same identity, including warm caches and restart; gate identity reuse until this holds. Cover cross-device retry/recovery and no named-agent prerequisite. Add optional saved-agent creation during conversion, skipping an already saved primary and preserving other chats using the automatic identity. |
| Chat-scoped defaults UI | Reuse composer catalog/pickers for harness/model/effort and one-message overrides; snapshot binding defaults for every authorized signer; reject unsupported choices visibly; no global preset mutation. Harness selection at creation can ship first; gate switching and temporary harness overrides on the ordering/history slice. |
| Cross-harness ordering and history | Extend existing queue/session owners; prove switching while busy, cancellation, reconnect, switch-back and temporary override without duplicate execution or tool replay. Enable switching only when these hold. |
| Goose per-message effort | Advertise only genuinely supported efforts; carry an owner-authorized per-turn effort through the existing delivery/session path without mutating unrelated chats. |
| Pi agent-type plugin | Exercise real RPC startup, streaming, settlement, cancellation, supported choices and recovery, including process failure; prove a useful chat end to end. |

## Questions for maintainers

- **Configuration home and schema:** which existing channel/config event or store
  should own this revisioned binding? How does it interact with config sync in
  the open [#1226 (agent/team config sync)](https://github.com/block/buzz-app/pull/1226)? Which fields need to be
  readable by remote runners for owner-authorized defaults on other signers' turns,
  and how are concurrent owner devices reconciled?
- **Legacy clients:** how do older senders preserve explicit recipients and avoid
  ambiguous untagged sends? Should rollout require a capability/version marker,
  with existing chats mention-only until explicitly adopted? How should signed
  implicit-target markers preserve existing recipient-keyed picks while preventing
  older clients from accidentally turning implicit sends into explicit mentions?
- **Legacy targeting scope:** how should ambiguous targeting fail closed in
  primary-bound or converted Solo chats without changing unrelated channels?
- **Chat workspace ownership:** should existing Solo Canvas or per-agent settings
  own chat workspace storage and seeding, especially across harness switches?
- **Inherited defaults:** when concrete native defaults cannot be discovered, how
  should inherited policy remain distinct from intentional one-message overrides?
- **Visible mentions and protocol tags:** should recipient terminology always
  distinguish visible agent mentions from signed protocol `p` tags?
- **Identity promotion:** when conversion optionally creates a saved agent, should
  it retain the automatic key or create a separate identity and transfer the role?
  Either choice must preserve authorship, membership and other chats using that key.
- **Pi identifiers:** how should provider/model pairs map to catalog IDs and the
  existing model-tag grammar/64-character limit? Prefer an agreed unambiguous
  encoding over truncation, display-name matching or a parallel tag format.
- **Cross-session authority:** which existing transport should carry explicit
  destination, deduplication and provenance, distinguishing a requested turn from
  an informational agent reply without weakening the loop guard?

These are proposal details to resolve in review alongside the implementation
PRs. This document changes no runtime behavior, storage or access permissions.
