# Proposal: Adopt NIP-52 (Calendar) for community events

> Status: proposal / request for feedback. This document asks whether Buzz
> should support [NIP-52](https://github.com/nostr-protocol/nips/blob/master/52.md)
> (calendar events) for scheduling community meetings and events, and sketches
> the work it would take on the relay and the desktop app.

## Motivation

Communities in Buzz already need shared scheduling: standups, release meetings,
community calls. Today there is no relay-backed way to publish an event that
every member (and every agent) can read. People work around this by posting
plain messages, which are hard to aggregate and easy to miss.

A working community-calendar plugin exists and is in daily use:
[`tami1A84/buzz-community-calendar`](https://github.com/tami1A84/buzz-community-calendar).
It demonstrates the demand and the desired UX (month/week/day views, live
huddle detection, member pickers). Its one structural limitation is that
created events live in `localStorage` on the author's device only, because
publishing them to the relay is not possible today.

## Where it is blocked today

The Buzz relay restricts writes and declares its supported NIPs in its NIP-11
information document. For example, a production relay currently reports:

```json
{
  "supported_nips": [1, 2, 10, 11, 16, 17, 23, 25, 29, 33, 38, 42, 50, 56, 43],
  "restricted_writes": true
}
```

NIP-52 is not advertised, and the calendar event kinds (`31922` date-based,
`31923` time-based) are not among the kinds a session may write. The desktop
client, by contrast, is already effectively kind-agnostic where it matters:

- Reads pass any kind through the access model (`src/features/relay/event-access.ts`
  resolves visibility from channel `h` tags, independent of kind).
- The plugin-facing read model and outbox accept whichever kinds the relay's
  session `writeKinds` includes; plugins can already publish arbitrary
  admitted kinds through `session.outbox`.

So the relay is the gating layer; the app needs little more than
feature-detection (the same pattern as the NIP-29 check in
`src/features/relay/native.ts`) and, eventually, first-class UI.

## Proposal

### Relay (block/buzz)

1. Admit `31922` and `31923` under the existing restricted-writes model,
   scoped like other content: require an `h` channel tag (or an explicit
   community scope tag) so community ACLs keep applying, and authorize the
   author like an ordinary kind-9 post.
2. Treat them as parameterized-replaceable (`d` tag), with the same
   dedup/replace semantics the relay already applies to other catalogs.
3. Include the kinds in the session `writeKinds` payload so clients and
   plugins discover writability without hard-coding.
4. Advertise `52` in `supported_nips`.

### Desktop app (this repository)

1. Feature-detect: honor the relay's `writeKinds`/`supported_nips` when
   deciding whether to offer event publishing (no client-side kind list).
2. Expose calendar events through the plugin read model so plugins (including
   the community calendar above) can switch from `localStorage` to relay
   storage behind a capability check, staying local-only on relays without
   NIP-52.
3. Optional follow-up: first-class calendar UI, or leave UI to plugins.

### Open questions

- NIP-52 events are parameterized by a `d` tag, not channel-scoped. For Buzz
  ACLs we propose requiring an `h` tag in addition to `d` (a Buzz profile of
  NIP-52), or introducing a community-scope tag — feedback welcome.
- Should repeated events (NIP-52 recurrence) be supported from day one or
  deferred?
- Retention: parameterized replaceable events can grow without bound; suggest
  a per-`d`-tag replace and a bounded history window per calendar.

## Alternatives considered

- Sharing events as ordinary kind-9 messages (what the plugin does today via
  its "share" button): works for announcements, but there is no structured
  aggregate, no replace/update semantics, and agents cannot reliably
  distinguish an event from chatter.
- A Buzz-draft custom kind: avoids the parameterization/ACL question, but
  reuses nothing from the Nostr ecosystem and blocks third-party clients.

## References

- [NIP-52: Calendar Events](https://github.com/nostr-protocol/nips/blob/master/52.md)
- Working plugin: <https://github.com/tami1A84/buzz-community-calendar>
- Existing kind-agnostic access model: `src/features/relay/event-access.ts`
- Existing capability detection by NIP: `src/features/relay/native.ts`
