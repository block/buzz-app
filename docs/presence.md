# Periodically refreshed community presence

Profiles show Active, Away, or Offline with text, while avatar badges use
solid status fills. Pending, failed, stale, or unavailable evidence renders no
status; it is not relabeled Offline. Message and thread bylines display badges
and demand presence when mounted, as do one-to-one DM avatars in the sidebar.
This describes recent Buzz session status in this community, not proof that a
person is available or an
immediate live-status stream. The relay stores one status per community/pubkey:
multiple devices are last-writer-wins, so an idle device can report Away even
while another is active. A crashed connection's lease can remain for up to 180
seconds; refreshing the snapshot does not prove that the session is still alive.

## Your status

The avatar dot shows your locally chosen/derived status, not an authoritative
relay readback. Its account dropdown keeps Settings and adds **Automatic**,
**Away**, and **Appear offline**, using the shared keyboard-accessible radio group.
Automatic returns to Active on input/foreground return and Away after ten idle
minutes. Manual Away/Offline wins over typing until Automatic is selected.

The one app activity owner stores `auto | away | offline` per viewer in
`buzz-presence.v1:<pubkey>`. Same-origin windows observe storage changes; all
retained communities use that viewer's intent. Startup restores it before opening
a session. Storage failure applies only to the current window and displays a
warning. This is device-local, not cross-device arbitration: another device or
CLI can overwrite the relay's last-writer-wins status.

The existing authenticated publisher sends bare kind:20001 status. An accepted
Offline clears presence once without renewal; locally unsent/refused/unconfirmed
clears retry on the existing cadence, and reconnect or lock handoff publishes
current intent again. A failed publication does not roll back the saved choice
or imply confirmed delivery. There is no durable invisible policy on the relay.

## Ownership and bounds

- One app input source derives Away after ten minutes without Buzz input. Focus
  loss and changing communities alone do not mean Away. Foreground return counts
  as activity; capture-phase input also observes editors that stop bubbling,
  including input without a keydown. Same-origin windows share
  recent input through BroadcastChannel; no machine-idle or cross-device claim.
- Each retained connected session owns one volatile presence directory. Mounted
  profiles, message bylines, and one-to-one DM sidebar rows demand authors. At
  most 256 unique authors are selected; profiles take priority, then existing
  selections and stable acquisition order. Overflow has no visible status.
- Initial/new demand coalesces for 100ms behind a five-second start gate. Successful
  views refresh after 60–65 seconds. Evidence expires 75 seconds after request start.
  Empty demand makes no request; removed authors lose their evidence. Hidden views,
  disconnect, access/cache invalidation and disposal invalidate observations.
- One bounded complete snapshot is validated before any status changes. The
  configured relay must sign each unique requested subject; only a successful
  complete response can make omitted subjects Offline. This is read-time evidence,
  not the relay's remaining lease. Invalid or failed responses mean Unknown for
  the whole snapshot. Valid relay-signed unsupported statuses mean Unknown only
  for that subject; canonical peers and complete-response omissions remain usable.
- The development broker permits one optional HTTP flight, a principal-wide
  five-second start gate, 256 subjects, a 20 KiB request and 1 MiB response, and
  a ten-second request lifetime. Optional work never uses ordinary read slots or
  dispatch credit. Local busy skips retry after 5–6 seconds; network failures wait
  60–65 seconds, honoring longer server cooldowns.
- Renewal uses the existing authenticated socket, with a Web Lock per scope/viewer
  serializing same-origin windows. Publication is lossy and bounded; it never
  enters the durable outbox, replays missed ticks, or publishes Offline on close.
  Hidden observation does not stop connected-community renewal. Actual shared
  relay cooldowns still take priority. A locally unsent publication
  retries current status after 5–6 seconds through the same renewal timer; refused
  or unconfirmed publications retain the 60–65 second interval.

Bounded presence reads and publications can run during ordinary HTTP work and
channel subscription setup; neither waits for the entire host to become idle.
Unavailable evidence can persist during relay cooldowns or unavailability. These limits bound
client work; they do not
promise zero CPU/network/backend cost, instant transitions, or a delivery SLA.
There are no presence REQs, added sockets, relay changes, or direct-adapter parity.

## Validation

Owner tests live with `features/presence`, relay transport/admission and the broker.
`tests/browser/presence.spec.mjs` exercises the built app and production broker with
modeled upstream and ephemeral keys: held profile snapshots versus chat,
byline presence/demand, avatar choices and reload, and real same-origin preference
synchronization/Web Lock handoff while Offline. `settings.spec.mjs` retains the
account disclosure, keyboard traversal and Settings journey in both engines. `channel-opening.spec.mjs` includes matched-thread
measurement support. See [browser measurement limits](browser-testing.md).

These fixtures do not certify deployed relay capacity, native-window behavior,
attended account use, or cross-device availability. Full production-broker browser
idle/publication integration remains unverified; controlled DOM owner tests cover
captured input, idle, foreground return, disposal, overrides, storage failure,
viewer isolation, Offline retry/no-renewal/reconnect and derived publication.
The isolated source preview also exercises idle/input through the avatar indicator.
