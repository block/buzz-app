# Notifications

The host provides one `notifications` service for built-in messages and trusted
plugins. Settings → Notifications stores account-local choices: alerts are on
by default, subject to system permission; master off preserves category choices.
Browser sound uses the Notification API. Desktop sound is managed in OS settings;
there is no separate audio player.

```ts
export const inject = ["notifications"];
export function apply(ctx) {
  const updates = ctx.notifications.register({ id: "updates", label: "Updates" });
  // In response to a real domain event:
  // await updates.submit({ sourceKey: event.id, target: typedOpenTarget });
}
```

Categories use existing installation ownership. Disabled/replaced plugins cannot
submit new alerts. A browser notification click belongs to the host; opening never enables
a missing destination plugin. `submit()` means a candidate was accepted for policy
checks, not that an OS banner was displayed or read.

## Running-app behavior

- Built-in mentions, DMs and participating-thread replies consume the selected
  community's verified live traffic and existing unread/visibility facts. No new
  socket, unread engine or background-community subscription is added.
- History, initial/reconnect replay and own messages stay quiet. Candidates older
  than two minutes (or over 30 seconds in the future) are ignored. Unknown read
  readiness waits; off/access loss cancels pending candidates. Visibility is checked
  after UI presentation, without publishing read intent.
- Permission is requested explicitly from Settings where a browser needs a user
  gesture. A fresh pending candidate is reconsidered after Allow; a newer off
  choice still wins. Observable API errors are reported, never auto-retried.
- Running-session dedup is bounded to 2,048 source identities/two minutes; pending
  candidates are capped at 128. Browser presentation retains at most 128 active
  alerts, closing the oldest before retiring its callback. These are not durable
  exactly-once or cross-window guarantees.
- Browser clicks use the existing typed, account/community-scoped navigation path. It owns
  membership/provider checks and exact opening. Changing account invalidates old
  callbacks; changing community does not turn an old alert into a dead click.
  Clicks never mark a message read.

There is no notification database, Recent notifications UI, cold/reload receipt
protocol, uniform OS withdrawal subsystem, or closed-app push. Preferences are
persistent; notification candidates are not. Built-in message banners show the
sender and conversation plus a short, plain-text preview on both browser and
desktop. This sends those details to the OS, where lock-screen/preview settings
control their visibility. Titles use the current shared profile/channel cache,
with a key fragment when a name is unavailable; optional names never delay an
alert or trigger additional reads. Previews use at most the first 4,096 source
characters, flatten CommonMark to at most 200 Unicode code points, omit raw HTML
and link destinations, and label images without fetching them. Empty or overly
deep content falls back to “New message”. This is an arrival preview, not a live
copy of subsequent edits. Plugin categories without message details retain their
generic category text.

## Current acceptance limits

The browser adapter works only in a running tab with the Notification API.
Desktop builds use the official Tauri notification plugin for macOS, Linux and
Windows, with the same eligibility, master/category choices and default-on policy.
Only the plugin's permission and send commands are granted to the main window.

The stock desktop plugin does not expose actual OS permission state, per-banner
sound suppression, or message-click navigation. Settings therefore describes
permission/sound as system-controlled and does not offer an ineffective desktop
sound toggle. Browser exact-message opening is unchanged. No custom native
activation or cold-start recovery is added to supply those missing capabilities.
The public desktop send API is fire-and-forget: a returned call is **not** proof
of delivery, and asynchronous native/OS failures are not observable by the host.

Real banners still require OS permission, an available notification service and
appropriate app packaging/installation. macOS development notifications can be
attributed to Terminal; Windows development notifications may use PowerShell's
identity. Test the packaged app identity before claiming release acceptance.
Chromium/WebKit fixtures replace only the OS Notification API; adapter tests do
not prove real OS permission dialogs, appearance, sound or focus behavior. Native
build results and real banner observations must be reported per platform.
