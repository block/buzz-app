# Huddles plugin

**Huddles** is enabled by default on macOS desktop and can be turned off in
Settings → Plugins. Click the headphone button immediately after members in a
channel or DM header to join the latest available Huddle or start one when none
is found. The Huddle window opens and receives focus by default once connected. The mini
player stays visible beside search at the same time. Closing the window or using
its minimize control keeps audio connected; the mini player can reopen and focus it. If opening fails, the mini player stays available to retry. No side panel opens
and the header shows a green headphone/divider/chevron capsule only in the chat
where your call is connected. Its headphone changes to a leave icon on hover or
keyboard focus, and clicking leaves the call. Elsewhere the neutral headphone
focuses the existing player. Its menu opens the existing channel
member picker through a guarded host callback, or copies a Buzz channel link.
The link opens the chat in the recipient’s selected community; members click the
headphone to join. It does not auto-join audio or grant access. Adding someone
uses the existing channel membership flow; DM membership cannot be expanded here. Microphone access follows the explicit click.

The mini player matches the neighboring 28px shell controls, with matching internal
buttons, 16px regular-weight icons and 20px avatars. Its end buttons sit flush
against the outer edges, with 4px between controls. Waveform and avatar content has
4px padding, with an extra 4px on the waveform’s left side. It uses the shared
primary glass material from the shell controls and offers audio activity, an
avatar stack of actual participants, mute, and a text-only Leave button. Leave keeps its Red 10 label with a muted red
fill on hover and is separated from mute by a subtle divider with spacing on both sides.
The neutral glass controls use the white chrome hover in light mode and its dark-mode counterpart.
The proposed `text-call-leave` role preserves the requested Red 10 in both themes.
It is a documented contrast exception for these controls: the light-mode Leave
label measures 3.09–4.37:1 across its opaque fills; dark-mode APCA is Lc 35.2–40.4.
Glass depends on its backdrop and is not certified by those opaque measurements.
The separate window uses matching neutral gray controls for microphone and Leave,
with a Red 10 Leave icon.
New arrivals slide
and scale into the front of the stack; reduced motion removes that movement. The
latest four avatars remain visible, with a matching avatar showing the count for other participants. Click the
waveform or avatars once connected to open the
separate Huddle window. The window borrows mobile’s avatar-cloud layout: you are centered alone, then
move left as other participants gather on the right. Up to ten peers use the
mobile-inspired cluster’s varied avatar sizes, with an overflow count for larger calls.
Names appear on hover or keyboard focus. Nearby portraits shift aside for the
active name capsule, then settle back when it closes. Only one name is shown
at a time; reduced motion makes the layout change immediate.
A soft halo around each speaker eases between audio levels with a restrained expansion,
responding to their own microphone or received audio,
then fades after speech stops. The window uses these halos instead of a footer
waveform; the compact player keeps its waveform. Muting clears only your halo.
Arrivals fade and scale in; reduced motion removes those transitions. Closing that window or navigating to another conversation
keeps audio connected. Leave releases the microphone and closes the companion.
Native call completion also retires it after a renderer reload/crash. The companion
has no identity, signing or microphone permissions. Connection failures appear
beside the player; the headphone button can retry them.

Disabling the plugin, losing channel access, replacing the relay session, or
switching community ends the local call. If the UI disappears, the native call
expires after its client heartbeat stops. A failed audio connection exposes a
manual join retry. Recent-room discovery is advisory: it uses signed lifecycle
events, and the audio relay checks current membership, creator linkage and archive
state before admission. A rejected recent candidate is removed for this plugin
activation when the relay says it is inaccessible or ended; the generic admission
response does not reveal whether it was archived. No microphone or discovery work
runs on startup.

## Conversation panels and cards

The chat button between microphone and Leave opens a panel beside the avatar
cloud. The shared tabs separate **Thread** from **Live transcript**. Thread uses
the existing relay session for message history, sending, and failed-message
Retry/Discard. Closing this panel or minimizing the window does not end audio or
cancel an accepted message delivery. Drafts survive tab changes; closing the panel
discards its unsent draft. The transcript tab is a placeholder: local speech
generation is deferred and no transcription is recorded by this version.

Start/end events appear as cards in the parent conversation. Active cards show
elapsed time, known participants and Join (or Open for your current call). View
opens the saved Huddle conversation in a side panel. Archived rooms remain
read-only. The display is bounded to the latest 200 messages and says when history
is limited; it does not delete earlier messages.

New rooms carry a parent marker in their relay-owned metadata. Marked rooms stay
out of ordinary sidebar destinations, and the discussion reader verifies that
marker before reading or sending. Older clients' unmarked rooms remain unchanged
and currently show an unavailable message in this panel. The marker and lifecycle
cards use the existing relay protocol; no server changes are part of this slice.

## Ownership and compatibility

- `bundled/huddles` owns the channel launcher, mini player and companion using existing panel
  contributions. It is enabled by default in both the frontend and native catalogs.
- `features/huddle` owns the reusable client controller, bounded Web Audio
  capture/playback, discovery and native adapter. A controller outlives panel
  mounts and is disposed with its plugin activation.
- `src-tauri/src/relay/huddle` owns one native audio connection, identity-bound
  admission, purpose-bound event construction, Opus and socket cleanup. Signing
  stays in the existing IdentityHost. Commands are available only to the main
  application webview.

This is a client-only implementation. It uses the existing private ephemeral
channel creation event (9007, TTL 3600), parent announcement (48100), authenticated
`/huddle/{room}/audio` endpoint and v2 Opus wire format. The relay owns participant
join/leave and last-person teardown. Before an announcement is attempted, a failed
creation is rolled back by archiving its temporary room. After the announcement
may be visible, the client never archives the room on a failed connection: others
may already have joined, so existing relay socket/TTL cleanup owns it.

The macOS bundle includes the microphone purpose string and audio-input entitlement.
Browser-only, Linux and Windows hosts do not expose the launcher in this slice.
Agent voices, transcription generation, screen sharing, device selection and automatic reconnect
are outside this first version.

## Checks and tryout

`src/features/huddle/*.test.ts` covers cancellation, scoped session replacement,
plugin disposal, microphone denial and lifecycle discovery. Native Huddle tests
cover wire encoding/decoding, roster handling and command input validation.
`tests/browser/huddles.spec.mjs` exercises the header and mini player in Chromium/WebKit and real
Web Audio capture with Chromium's synthetic microphone. The local fixture is
`/tests/fixtures/huddles.html`; `?audio` requests a local microphone and sends no
audio or events to a relay.

These checks do not prove a live two-person call or packaged OS permission behavior.
The native tryout must verify start/join against another existing Huddle client,
two-way audio, mute, switching conversations, leaving, plugin disable and
community switching. Production audio remains unverified until that live tryout passes. A relay rejection
that audio is unavailable is an operator deployment issue, not microphone permission
failure. Every endpoint that can receive `/huddle/{room}/audio` must support the
relay’s Huddle routing; mixed server pools can make admission intermittent.
