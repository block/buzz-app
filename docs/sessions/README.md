# Sessions

Sessions are focused work conversations built on ordinary private channels.

**Direction:** [Me and Messages: channel spaces](spaces.md) records the agreed
replacement for roster-based placement and shared groups. It is a design contract,
not implemented behavior. The current iteration below remains a prototype until
explicit classification, isolated groups and relay policy are integrated.

For the existing destination-link Share implementation and its validation limits,
see [Sharing a live session](sharing.md). That operation is not Me-to-Messages
promotion.

## Current implementation (not the target space contract)

- Personal work conversations now live in **Me**, with **New session** and
  history in the shell sidebar. The old Sessions page redirects to Me and no
  longer has a primary sidebar entry. Shared sessions and historical parent-linked
  sessions remain as ordinary rows in Messages; nested creation/rows were retired
  upstream.
- This first app iteration classifies an existing private, unparented session as
  personal only when its entire roster is the viewer plus identities in their
  managed/owner-scoped agent inventory. This is placement, not proof of ownership
  or a new admission guarantee. Relay-enforced personal admission and same-ID
  promotion remain separate work. No existing access is revoked by placement.
- Canonical channel/message links still open the existing Messages reader; Me
  history uses scoped page routes. Full ingress unification is not implemented.
- Sessions are ordinary private stream channels. Creation, invitations, messages,
  roles, and membership use existing relay behavior. **No relay changes or new
  Sessions protocol are changed in this app iteration.**
- The description marker `Buzz session (buzz.sessions/v1)` identifies sessions.
  Legacy `parent:<UUID>` metadata remains readable, but Sessions no longer creates
  nested conversations and the Sessions list excludes parent-linked sessions.
  Existing content and signed membership are not changed or deleted.
- The sidebar arranges standalone sessions using the same relay-backed personal
  sections as channels. Moving an existing session changes organization only.
- Each custom section has **Session settings…** and a **+** for a new session
  in that section. Defaults include project folders, optional worktree location
  and base branch, Canvas, and optionally a copy of an existing template's lineup.
  Paths become Canvas instructions for the agent host; saving them does not create
  a worktree or change a running agent's working directory.
- Section overrides are ordinary private template records, keyed by the SHA-256
  of the section ID in the `session-section-` namespace. They use the existing
  community-scoped recipe capability; no sidebar migration or new relay event
  kind is involved. Existing personal-group template defaults are used when there
  is no Sessions override. Templates are copied, not linked for live propagation.
- Creation freezes section defaults in the existing pending-start receipt. The
  session's Canvas, section placement, and template agent invitations must succeed
  before its first message is sent. Me rejects defaults containing agents outside
  the viewer's selectable inventory before creation or invitations. A retry keeps
  the same session ID and setup;
  a different existing Canvas blocks replacement. Missing defaults or failed reads
  do not silently create an unconfigured session.
- A saved session's header **⋯ → Session settings…** edits that session's Canvas
  with the existing revision check. Changes do not update the section default or
  sibling sessions. Failed saves retain a local draft and explicit reload flow.
- Saved sessions expose **Rename** in their row and header menus.
  The existing channel-details service verifies owner/admin permissions and the
  loaded revision, then sends a name-only kind-9002 command. Session metadata,
  visibility, and lifetime remain unchanged; uncertain delivery requires checking
  the saved result before another write. Automatic generated titles are not added.
- Row menus offer **Section** destinations and **New section…**, plus **Copy** for
  the session name, ID, and ordinary Buzz channel link. The unfiled Sessions
  destination appears only for sessions currently in a custom section.
- Workspace fields round-trip through a marked block in ordinary Canvas Markdown.
  If another editor changes that block, the settings dialog exposes the full
  Canvas instead of discarding custom text.
- Me and Messages share the ordinary composer and channel-style titles. The
  separate agent picker has been removed. Me's @ menu and inline completions use
  only the viewer's selectable agent inventory, including multiple recipients;
  pasted/restored recipients are checked against the same inventory. Me sends
  without mentions do not infer an agent. Existing shared/nested session routing
  retains its earlier sole-agent fallback. Durable legacy pending sends retain
  their saved recipient intent for recovery.
- The old destination-sharing button is absent from Me; it is not promotion.
- Published replies appear in the main session conversation. Sessions uses normal
  paged channel queries and complete message overlays, without new relay filters.
  Existing thread replies are also presented inline.
- Detailed activity remains private to the agent's owner. Do not build a shared
  activity feed for today's individually owned agents. Shared cloud agents may
  introduce a different visibility model later.
- Use real conversations and agents. No sample activity, fake sends, inferred
  permissions, or new execution/scheduling infrastructure.

## Ownership and protocol

- `src/bundled/me` owns personal navigation; `src/bundled/sessions` supplies the
  reused conversation and section UI.
- `src/bundled/channels` retains ordinary channel access to historical sessions.
- `src/features/sessions` owns composition, recipient selection, workspace settings,
  frozen setup, and presentation. Existing relay capabilities own all writes.
- `src/features/relay/work-sessions.ts` uses the existing durable outbox for private
  stream creation (kind 9007), invitations (kind 9000), and receipt recovery.
- `browser-host/session-commands.mjs` restricts the host signing boundary to these exact
  command shapes. No custom relay operation or migration is needed.
- `session-window.ts` loads ordinary channel rows and complete message overlays
  with bounded paging. Signed membership remains the authority for reads.

## Validation and scope

The upstream evidence below does not validate the Me integration. Its iteration
currently has passing TypeScript, frontend build, formatting and diff checks;
full automated suites and live Me behavior remain deferred for human iteration.

Focused tests cover signed create/invite/send, duplicate-creation recovery,
independent memberships, rejected invitations and retry, parent revocation without
child revocation, flat conversation reads, Enter submission, recipient precedence,
and agent mention rendering. Real-agent creation and replies have been exercised
in the native app.

Archive/completion and richer prompt-linked activity remain future product work.
[Live sharing](sharing.md) retains independent memberships and each agent owner's
private detailed activity.

### Interactive section/workspace iteration

Targeted coverage includes section save/restore/retry, hiding parent-linked
sessions, workspace serialization, revision conflicts, and withholding the first
message until inherited setup succeeds. Native UI checks cover the section
workspace dialog and existing session reads. Live cross-device inheritance and
agent execution from the configured paths still require acceptance testing;
those acceptance checks remain deferred for this integration.

Section deletion uses the active grouping store: native legacy sections receive a
section tombstone (including the development broker), while personal groups use the existing revision-checked recipe
writer. Sessions and channels are retained and return to the unfiled list; shared
channel-sidebar sections disappear there as well. Hosts without the removal
capability disable the action. Coverage includes native readback, personal-group
removal, source-change rejection, and UI failure/retry. Live deletion of user
sections has not been exercised. Section expansion uses interruptible 180ms motion,
with immediate keyboard and reduced-motion behavior.

New-session headers expose local draft settings before first send. These overrides
survive reopening, retain section agent defaults, and are frozen into the existing
start receipt. Canvas setup must complete before the first message is sent;
opening or saving the draft settings does not create a remote session.
