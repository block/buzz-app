# Emoji aliases (draft)

Status: proposed format and executable resolver. No settings, relay publication,
live subscriptions, composer, or agent tools use it yet. This is the first slice
of a community emoji-alias feature; it must remain a draft until the publication
and integration decisions below are resolved.

## Intended experience

Settings gains an **Emoji aliases** destination alongside **Custom emoji**. A
member chooses a standard or custom emoji, enters a name, previews it, and saves.
Everyone in that community can then find the alias in completion and the picker
and use it in messages and reactions. No per-person installation is needed.
Creation, editing and deletion permissions are separate from shared use.

The list shows alias, target and creator, with search and permitted edit/remove
actions. Reuse the Settings host and its existing navigation, `Header`,
`SettingsGroup`, labelled fields and picker. Follow the design guide's
[Settings composition](../src/shared/design-system/DESIGN.md#settings-pages-and-contributions)
and [plugin boundaries](../src/shared/design-system/DESIGN.md#plugin-contribution-boundaries).
Slack import and retroactive changes to historical messages are out of scope.

## Proposed data format

Use a separate kind-30030 coordinate, `d=buzz:emoji-aliases:v1`. Existing clients
rewrite only `buzz:custom-emoji`, so their custom-emoji edits cannot erase alias
metadata. This proposal is not permission to publish the new format: the browser
broker currently rejects it, and relay/native admission must be checked before
connecting a writer.

An author's latest complete set has empty content and tags such as:

```json
[
  ["d", "buzz:emoji-aliases:v1"],
  ["alias", "project_small", "unicode", "🌱"],
  ["alias", "party_alias", "custom", "<target author hex pubkey>", "party"]
]
```

Names use the existing normalized shortcode grammar: 1–64 lowercase ASCII
letters, digits, hyphens or underscores. A set contains at most 500 unique names.
Unicode targets must exactly match an emoji sequence in the existing Emoji Mart
data, including supported skin tones, flags, keycaps and joined sequences. The
data version therefore bounds which Unicode targets this draft understands;
clients with different versions need a compatibility policy before release.
The parser rejects a malformed set in full. It validates structure, not signatures,
timestamp freshness, membership, or authority.

A custom target identifies its author's `buzz:custom-emoji` set and shortcode.
That author's image replacements affect future uses. Another author publishing
the same target shortcode cannot retarget the alias. Removing the target makes
the alias unavailable; recreating it under the same author/name restores it.

Stored targets never point to aliases. Selecting an alias in a future target
picker must copy its resolved canonical target; missing or conflicting targets
cannot be selected. This prevents chains and cycles in the stored relationship.

## Resolution and conflicts

`resolveEmojiAliases` consumes signature-verified events from one community.
The caller supplies the community boundary; this pure helper cannot infer it
from an event. It first selects each author's latest set at each coordinate,
using the NIP-01 lower-event-ID tie break. Empty and malformed replacements do
not resurrect an older set. Custom records retain the existing emoji-tag parser.

Two authors declaring the same alias produce a visible `conflict`, even if
they point at the same target. Names that overlap a standard shortcode, a
standard alias or any current custom shortcode also conflict. Existing custom
entries and built-in shortcode behavior take precedence during preparation;
publishing an invalid alias cannot disable them. Referencing an ambiguous
alias-only name fails preparation, so no arbitrary winner changes the sent emoji.
An unrelated conflict does not block preparing other names.

**This is collision handling, not ownership enforcement.** Another member can
cause a name to become unavailable by publishing a duplicate. Deleting one
conflicting declaration makes the remaining one usable. Exclusive name claims
and admin overrides require relay-authoritative rules; a client timestamp or
hidden Edit button cannot enforce those rules. Do not present this draft as
creator/admin authorization or enable live authoring until that decision is made.

## Preparing messages and reactions

The two preparation helpers return fresh content/tag values. Future callers must
run them before the outbox assigns identity or signs, then retain that prepared
payload for retries. They do not read or write a relay, mutate an outbox, or alter
already-signed events.

- Messages substitute Unicode aliases with the actual sequence. Custom aliases
  retain their text and get event-local `emoji` image tags. Keeping the alias name
  allows a message to mention both an alias's pinned target and a different
  author's same-named custom emoji without assigning two URLs to one tag.
- A reaction consisting of one alias becomes its canonical Unicode sequence or
  custom shortcode/image tag. Existing reaction folding then groups it with a
  direct reaction to that same target. No historical grouping migration is needed.
- Unknown names stay literal. HTTP(S) links use the existing tokenizer's exclusion
  rule. Other text, including code spans, follows today's shortcode semantics.
- A known alias with a missing target or ambiguous alias-only name throws before
  a future caller can enqueue it. Existing custom-image URLs remain scheme-agnostic; the
  session media resolver still decides how to display them.

## Integration work remaining

1. Decide relay-backed name ownership, create/edit/delete authority and admin
   moderation. Define admission and compatibility for the proposed coordinate,
   including unknown versions and incomplete catalogs. A bounded read must not
   claim a name is unique when other declarations may be missing.
2. Integrate aliases into the existing directory's lifetime, bounded reads,
   serialized writes and profile replay. Avoid a new poller or socket: batch the
   custom/alias coordinates in the existing read and replay path where supported.
   Document the actual fleet read cost and cover reconnect/access-loss behavior.
3. Add the Settings destination, target selection, completion and picker support.
   Keep community-specific names out of Emoji Mart's global alias state.
4. Connect message/reply/edit/reaction and agent preparation before signing.
   Keep historical tags and retry payloads stable. Include status text only if
   that behavior is explicitly included. Update the bundled help with behavior
   actually implemented, rather than this proposal.

The original delivery outline is three reviewable changes: model/persistence,
UI/discovery, then message/reaction/agent integration. This draft starts the
first change; it does not yet complete persistence. Wiring through files marked
`FOUNDATION`, including `session.ts`, needs the explicit guidance required by
the repository's [contribution rules](contributing.md#foundation-files).

Before declaring the feature usable, exercise independent community members,
name races, target deletion, mixed client versions, reconnects, signing, historical
messages and retries. Test the actual Settings/picker flows in both themes,
narrow/wide layouts, enlarged text and keyboard/pointer input. Pure tests here
exercise parsing, resolution and existing reaction folding; they do not establish
native/relay or user-interface acceptance.

This design follows the community boundary and relay authority in
[Buzz's vision](https://github.com/block/buzz/blob/main/VISION.md) and
[moderation model](https://github.com/block/buzz/blob/main/VISION_MODERATION.md).
