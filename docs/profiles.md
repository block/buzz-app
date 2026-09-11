# Profiles: viewing public identities

The bundled `buzz.profiles` plugin supplies a minimal, read-only panel for any
public identity, human or agent. It uses the current session's shared profile
directory. Agents retains agent-specific configuration/operations; this slice
adds no ownership/running badge, editor, agent-library lookup or execution API.

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
  Full-key-qualified namesake occurrences also remain literal. Full edit-snapshot
  rendering compatibility is deliberately deferred.
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

Avatar, name, about and exact copyable npub only. Shared design-system Avatar and
Button are used with a scoped host-token compatibility stylesheet; no new theme
owner, second global reset or shell migration. Designers own later refinement.

Use the normal `bin/just desktop` or `bin/just web` workflow in the feature worktree
with the existing public live-mode pin; run only one dev target at a time.

## Evidence and remaining checks

`tests/browser/profiles.spec.mjs` runs real React/ChannelsPage, thread reading,
profile directory, panel registry and plugin lifecycle against a synthetic
transport. It covers avatar/mention keys, keyboard/focus, disable/re-enable,
thread-only mention enrichment, failure/retry and session replacement in Chromium
and WebKit. It also checks copy success/failure with a stubbed clipboard and
light/dark layout at 390, 900 and 1280px widths. It does not establish an OS
clipboard, live relay or native packaging result.

Focused tests cover target validation, mention ambiguity/code/link boundaries,
signed-event → fold → renderer indentation preservation, current-body edit
marking, about-only profile updates, rendering and actual
bundled registration. Broad scan and native build/package acceptance remain
deferred to an agreed integration batch. No FOUNDATION contract
or sending/signing behavior changed.
