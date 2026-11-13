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
client is already kind-agnostic on the read path:

- Reads pass any kind through the access model (`src/features/relay/event-access.ts`
  resolves visibility from channel `h` tags, independent of kind).

The write and routing paths, however, are not kind-agnostic yet:

- The desktop's native relay writer advertises a fixed client-side kind list
  (`nativeWriteKinds`, `src/features/relay/native.ts`; plus 9007 when NIP-29 is
  advertised). A broker-session writer does honor the relay session's
  `writeKinds` (`src/features/relay/transport.ts`), but neither path means
  "no client-side kind list".
- Channel subscriptions and routing use fixed kind lists too
  (`CHANNEL_KINDS` / `channelSourceKind`, `src/features/relay/channel-kinds.ts`),
  so `31922` and `31923` would not reach community timelines without app
  changes.

So authorization is relay-side, but adopting NIP-52 does require client code
changes: admitting the kinds in the writer lists and in channel routing.

## Scope

The initial proposal covers the event kinds only: `31922` (date-based) and
`31923` (time-based). NIP-52 also defines calendars (`31924`) and RSVPs
(`31925`); those are deliberately out of scope here and would follow the same
path later if wanted. Note the NIP's format requirements, since a relay-side
validation profile needs them: date-based events carry `start`/`end` in ISO
`YYYY-MM-DD`; time-based events carry `start`/`end` as unix seconds plus the
required `D` day tag (day-granularity unix days).

## Proposal

### Relay (block/buzz)

1. Admit `31922` and `31923` under the existing restricted-writes model,
   scoped like other content: require an `h` channel tag (or an explicit
   community scope tag) so community ACLs keep applying, and authorize the
   author like an ordinary kind-9 post.
2. NIP-52 events are addressable: one stored version per (kind, author, `d`),
   with the same dedup/replace semantics the relay already applies to other
   catalogs.
3. Include the kinds in the session `writeKinds` payload so clients and
   plugins discover writability without hard-coding.
4. Advertise `52` in `supported_nips`.

### Desktop app (this repository)

1. Feature-detect: offer event publishing only when the relay advertises NIP-52
   (`supported_nips`) and the kinds are writable. Where the broker-session
   writer applies, honor the session `writeKinds`; the native writer's
   `nativeWriteKinds` and the `channel-kinds.ts` routing lists need the new
   kinds added, gated on the relay's advertisement.
2. Expose calendar events through the plugin read model so plugins (including
   the community calendar above) can switch from `localStorage` to relay
   storage behind a capability check, staying local-only on relays without
   NIP-52.
3. Optional follow-up: first-class calendar UI, or leave UI to plugins.

### Open questions

- NIP-52 events are addressable by (kind, author, `d`), and the NIP's `a`
  coordinate has no channel dimension. For Buzz ACLs we propose requiring an
  `h` tag in addition to `d` (a Buzz profile of NIP-52), or embedding the
  channel scope in the `d` value — otherwise one author reusing the same `d`
  in two channels would silently overwrite across them. Feedback welcome.
- Retention: addressable events are bounded per (kind, author, `d`), so
  growth comes from the number of distinct `d` values, not history; suggest a
  bounded count of distinct calendar events per channel.
- Recurrence: NIP-52 intentionally omits recurring events ("Intentionally
  Unsupported Scenarios") and pushes clients to publish separate events per
  occurrence. Proposal: follow the NIP and treat recurrence as out of scope;
  a Buzz extension (or plugin-side expansion) can revisit it later.

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
