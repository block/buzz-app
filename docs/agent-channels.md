# Agent channels: selected-community relationship view

## First slice

Agent channels is a bundled page plugin that lists authorized channels in the
currently selected community where an identity from the current Buzz agent
library is a member now or has authored activity returned by a finite verified
relay read. It is a relationship view, not a directory, ownership proof,
runtime monitor, or cross-community index.

The plugin injects only `pages` and `relay`. It reuses the session-owned agent
library, identity archive evidence, channel roster, verified finite reader and
media helper. It does not create a relay connection, cache, outbox or host route.
Switching community or reconnecting remounts its session-owned subtree using
scope plus generation.

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

The list is one projection of this model. A later node-and-edge visualization can
consume the same nodes and edges without changing relay ownership or scraping UI.

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
