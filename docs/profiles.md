# Profiles: viewing public identities

The bundled `buzz.profiles` plugin supplies a profile panel for any
public identity, human or agent. It uses the current session's shared profile
directory. Agents retains agent-specific configuration and its page-local editor. Profiles
can dispatch existing local Start/Stop/Restart commands for an exact managed
identity in the active community; profile metadata and library hints grant no authority.
When Agent Activity is enabled and the host supplies conversation context, **View
activity** opens its raw panel for this exact identity and originating channel.
The Info tab's “Latest activity” card shows up to three recently updated assistant
messages or tool titles/statuses from the existing session-owned records, restricted
to this exact public key and originating channel (including threads). Retained text
chunks are joined by session/turn/message identity; without a message identity,
tool updates separate text segments within that turn. Tool updates reuse the tool
identity.
Each item shows at most 600 trailing characters of retained text, with a marker
when the preview clips that text, and renders at most three lines. Earlier chunks
may have left the session journal; the preview cannot identify missing history.
Plain text only: no HTML, images or active links.
Prompts, thinking, arguments, raw results and unsupported records are omitted;
“View activity” retains the raw destination. This is a bounded preview, not a full
transcript or history backfill. The timestamp includes visible content updates as
well as turn signals. It uses a short date and time rather than
a relative age that could become stale between snapshot updates. No context means
no preview, never an all-channel fallback. Connecting, disconnected, unavailable
and empty states are explicit. Counts and detailed explanations stay in the
activity panel; the preview does not infer idle state or successful completion.

This action is offered for any public identity: it does not infer that the identity
is an owned/running agent. Public agent hints never grant telemetry access. The
existing observer admission and session access-reset/generation fences remain the
authority; the child adds no library read, capture lease, socket, timer or store.
Disabling Agent Activity removes the preview/action and clears capture. Profile
opening subscribes only to the existing snapshot; it never starts telemetry.
Raw records, channel switching and live-feed retry remain in the activity panel.

Guarded invitations that fail or have an unknown outcome remain saved in the
outbox. Its generic Retry action is withheld for these records. Retrying the
add from the managed-agent profile rechecks current eligibility and reuses the
exact saved event while it is still within the relay's 15-minute timestamp
window. The ordinary channel composer uses a separate invitation path; it does
not renew or reuse these guarded profile invitations. After expiry, check
membership; if absent, remove the expired “Add agent” item from Outbox and
add the agent again from the managed-agent profile. Older unguarded invitation
records can be promoted to guarded intent when reused through that profile flow.
Remove from outbox does not revoke an invitation already dispatched to the relay.

## Boundaries

- Shared message UI recognizes author-avatar targets and identity-bound mentions.
  Ordinary `canOpenLink` / `onOpenLink` props advertise availability and dispatch.
  Channels resolves active contributions at click time and owns the right slot.
- `nostr:npub…` is the exact public-key target, with no relay hint or authority.
  Opening uses the current community session, never another connection or cache.
- Display names bind only against the message's signed `p` keys, longest first.
  Unknown, ambiguous, untagged and incomplete names stay plain text. Code/link
  contexts are conservatively excluded on the full body, before URL rendering.
  This is not a Markdown parser or a notification change.
- Replacement edits remain readable but their mentions are not clickable: old
  Buzz can change body identity bindings without changing original recipients.
  Full-key-qualified namesake occurrences also remain literal. Bodies changed by
  Markdown image removal do not bind clickable mentions either: stripping an image
  can create a name that never appeared in the signed prose. Image attachments and
  signed notification recipients are unchanged. Full edit-snapshot rendering
  compatibility is deliberately deferred.
- Disabling Profiles removes its panel and clickable affordances without changing
  prose, drafts, delivery or recipient intent. Re-enable does not reopen it.
- Profile enrichment in channels and threads remains a background batch. The
  panel fetches only its selected missing key, with explicit failure/missing retry.
  Community/session replacement disposes the old view. About metadata stays in
  the existing bounded directory and follows about-only replacements/removal.
- A profile replaces the existing thread/object slot, not a second parallel dock.
  Close/Escape returns focus to the original control, falling back to the stable
  originating thread control if opening the profile unmounted the thread.

## UI and iteration

Avatar, name, about, exact copyable npub, and an optional compact activity preview/action. Shared design-system Avatar and
Button use the host-loaded styles directly. The profile content marks its
`data-buzz-ui` boundary and uses shared heading/body/mono roles; its stylesheet
owns layout, not component overrides. No new theme owner, second global reset or
shell migration. Designers own later refinement.

Agent hints change avatar shape, not authority:

- Profiles, mentions, participants and membership avatars use squircles for
  self-declared `is_agent`/`isAgent` metadata or exact keys in the loaded session
  library; otherwise they use circles. My Agents cards always use squircles.
- Message authors also use these hints. An original kind-40002 envelope is enough
  on its own and keeps that treatment through edits.
- Library hints are lazy: opening or refreshing Agents loads them; clearing the
  library removes that fallback. Avatars never fetch the library or scan telemetry.

None of these hints proves ownership or running state. One bundled SVG mask scales
across sizes and clips only artwork, leaving the profile button's focus ring intact.

Use the normal `bin/just desktop` or `bin/just web` workflow in the feature worktree
with the existing public live-mode pin; run only one dev target at a time.

## Evidence and remaining checks

`avatar-shapes.spec.mjs` covers painted pixels and focus across sizes, themes and
viewports in Chromium/WebKit, including the artwork inside participant/membership
overlap borders (pictures and initials). Shape attributes alone do not prove that
inset artwork is clipped. Completion tests cover loaded-library changes without
another keystroke; profile-directory tests cover marker-only updates.

`tests/browser/profiles.spec.mjs` runs real React/ChannelsPage, thread reading,
profile directory, panel registry and plugin lifecycle against a synthetic
transport. It covers avatar/mention keys, keyboard/focus, disable/re-enable,
thread-only mention enrichment, failure/retry and session replacement in Chromium
and WebKit. It also checks copy success/failure with a stubbed clipboard and
light/dark layout at 390, 900 and 1280px widths. It does not establish an OS
clipboard, live relay or native packaging result. `profiles-appearance.spec.mjs`
additionally exercises the compiled app and host appearance owner: shared type,
color, compact-button styling, keyboard-only focus and single-scaled typography
at narrow, intermediate and wide widths in both modes.

Focused tests cover target validation, mention ambiguity/code/link boundaries,
signed-event → fold → renderer indentation preservation, current-body edit
marking, about-only profile updates, rendering and actual bundled registration.
The CI repair also narrows channel catch-up cancellation to top-level timeline
heads: `live-session.test.ts` forces overlapping unread reads for 1, 2 and 130
channels; `sidebar-unread.spec.mjs` holds unread evidence through real EOSE and
checks its badges without retries. Access-loss/disconnect cancellation is unchanged.
Broad scan and native build/package acceptance remain deferred to an agreed
integration batch. The earlier read-only profile slice changed no sending/signing
behavior; the managed-agent admission described below does.

## Info, channels and linked instances

The profile's Channels tab uses the current viewer's `session.channels`
list and exact `ChannelSummary.members` from relay-authored rosters. It excludes
archived, hidden, DM and session conversations. Only positively identified stream
and forum rows render; when a matching roster lacks a recognized type, that
membership is unclassified and omitted from the channel rows. Ready empty copy
qualifies this uncertainty for the viewed identity, including partial lists.
Verified classified rows remain visible
alongside a transient list error; loading/error/partial discovery is not an
empty membership claim; retry uses `refreshList`. Rows navigate using the existing
scoped conversation destination when a valid community scope and navigation
capability exist, otherwise remain plain text.

On native hosts, linked instances use `agentControl`'s exact managed `pubkey` and
normalized `relayUrl` for the active community. The subsection is absent without
native control or a valid community scope. Agent identity hints gate loading and
visibility, never ownership; exact native matches alone supply instance rows. The
section stays hidden for a non-agent without a match. It never derives ownership
from the old Buzz library, self-declared profile markers, or names. The Agents
page route opens management, not a per-instance page.

The Info tab keeps the public key and linked instances. The Channels tab offers
**Add to channel** only for an exact native-managed identity in this community
that is also a managed session choice. It offers loaded, classified stream/forum
channels with a roster, excluding archived, hidden, read-only and already-member
rows. On submission it refreshes native evidence, then checks current agent,
session and channel eligibility across the fresh roster read and at publisher
entry. The relay still decides permission; local evidence does not grant it.
Before publisher entry, navigation or loss of eligibility stops the write. Once
publication begins, leaving the tab cannot undo the request; the session outbox
retains its outcome and an unconfirmed result requires checking membership
before attempting again. Neither list is a cross-community/global directory.

## Owned local agent actions

`ProfileAgentActions` observes the app-owned `AgentControl` injected into Profiles.
It mounts only in Info, alongside the linked-instance child; changing tabs releases
the actions view without cancelling an admitted app-owned command. Returning to
Info observes current host evidence without restoring focus from the retired view.
It matches the exact public key and canonical active-community scope to one native
ID; namesakes, other-community identities, ambiguous matches and browser-only
profiles get no runtime actions. It adds no controller, relay scan or agent editor.
Profiles and Agents share `useAgentControl` for observation. While mounted it
refreshes host evidence every five seconds when visible/ready; errors stop polling and expose explicit Retry status. Unmount
releases observation, never native execution.

Start/Restart require ready host evidence, an available runtime and no pending
operation or process transition. Stop uses the controller's existing recovery
policy, including stale evidence and pending launch/credential waits; it is the
intentional exception to disabling pending actions. A pending Stop cannot repeat.
Host failures remain visible with snapshot uncertainty for the matched agent.
Known unmatched profiles suppress unrelated controller errors; an initial read
failure still offers Retry while ownership is unknown. Start stays focusable but
inactive while pending, and moves focus to Stop if success removes the focused
Start button. It does not steal focus moved elsewhere during the wait. Stop and
Restart retain focus when disabled or pending without allowing activation.
`agentLaunchBlock` centralizes the launch gates used by Profiles and Agents.
Retired relay
presentations cannot dispatch commands. The separate runtime child owns badges
and runtime detail; actions do not infer relay readiness.

Edit ingress is deferred: Agents currently registers no specific editor route;
its editor selection is page-local state. No invented route or second editor is
added. Mounted React regression tests exercise exact dispatch, pending/failure/
recovery and profile/community lifecycle through the real controller projection
with a synthetic native host. Live process/credential handover and rendered native
acceptance remain attended checks, not established by these tests.
