# Agent dashboard: selected-community relationship view

## First slice

Agent dashboard is a bundled page plugin that gives an agent-first view of
currently selected community where an identity from the current Buzz agent
library is a member now or has authored activity returned by a finite verified
relay read. It is a relationship view, not a directory, ownership proof,
runtime monitor, or cross-community index.

The plugin injects `pages`, `relay`, and the shared external-object provider
registry. It reuses the session-owned agent library, identity archive evidence,
channel roster, verified finite reader and media helper. It does not create a
relay connection, cache, outbox or host route. Switching community or
reconnecting remounts its session-owned subtree using scope plus generation.

## Relationship model

`bundled/agent-channels/relationships.ts` produces three display-independent
records:

- agent nodes group exact non-archived library identity pubkeys by saved agent
  definition; definitions without an active linked identity are omitted;
- channel nodes retain channel ID, name, relay-authored type and archive state;
- edges retain exact agent/channel IDs, current/past/unknown membership, first
  and last observed activity, and observed message count.

Current membership comes only from the channel summary's relay-signed exact
member list. Activity comes only from verified or relay-accepted kind-9 events
authored by exact library identity pubkeys and carrying an authorized channel's
`h` tag; pending, unknown-delivery and failed local outbox events are excluded.
Display names never establish a relationship.

## Dashboard projection

The page projects the relationship records into one row per agent, ordered by
current channel membership and recent observed activity. Selecting an agent
centers its avatar in a bounded relationship map: channel nodes form the first
ring, and other agent avatars connect through channels they share with the
selected agent. The map deliberately limits visible nodes for legibility; the
selected agent's full channel list remains available below it and supplies the
non-visual equivalent for keyboard, touch and narrow layouts.

The dashboard summary retains current/past/unknown membership, sampled message
count and last observed activity. It does not infer presence, running state,
task status or complete lifetime work from messages.

## Pull request outcomes

The optional **Outcomes** view extracts canonical pull request links directly
from eligible agent-authored activity and retains each signed message ID,
channel, agent and share timestamp as association evidence. Repeated shares of
the same pull request are grouped rather than double-counted.

External details come through `features/objects`, a typed contribution registry
that is separate from panel presentation. The GitHub plugin registers both its
existing panel and an object provider, so Agent dashboard never imports GitHub
implementation code. The provider supplies current public state, title, author,
branch and change facts with bounded four-at-a-time loading; disabling GitHub
removes both capabilities. Private or unavailable GitHub objects remain visible
from their signed Buzz reference with a truthful enrichment error.

A shared link establishes observable association, not pull request authorship or
causation. The UI therefore says **shared by** and **associated work**, never
claims that an agent authored a pull request or caused its merge.

## Bounds and truthful states

Activity uses background-priority finite reads in bounded author and authorized-
channel batches. A shared 2,000-event request budget is allocated across all
batches, then the eligible results are merged by recency. The relationship
projection is separately capped at 10,000 edges and reports when that display
bound is reached. The read contract
does not return a historical completeness bound, so the page says **observed**
activity and never claims complete lifetime history. A channel omitted from the
current authorized roster is never displayed from activity alone.

The page exposes disconnected, connecting, unavailable library, loading, empty,
partial roster, failed update and retry states. Existing edges remain visible
when a later update fails. Archive evidence affects which saved identities are
shown; it is not channel access evidence.

## Validation

The pure projection tests cover exact identity grouping, current/past/unknown
edges, authorized-channel filtering and shared-reader inputs. App composition
covers registration, disable/re-enable and relay-session lifetime. The native
plugin manager catalogs the manifest independently so Settings and CLI reserve
and enable the same bundled ID as the browser runtime.
