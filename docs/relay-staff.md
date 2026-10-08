# Relay staff console

`buzz.relay-staff` is an enabled-by-default bundled Settings plugin. Settings →
Plugins can disable it. It contributes the `console` card to the selected
community's administration section through `ctx.settingsCards.register`, and
reads the selected community and viewer from `communityReader`.

The plugin owns the UI only. Every admin request goes through the native admin
client in `src-tauri/src/relay_admin/` (contract in
`src/features/relay-staff/contract.ts`). The webview names a route and supplies
typed fields; native code discovers and validates the admin host, builds the
URL, enforces the address policy and signs with NIP-98. See the "Packaged
connection" section of [identity.md](identity.md) for the address rules.

## Visibility and access

1. The card appears only when the selected relay's NIP-11 advertises an
   `admin_api` host. Discovery is unsigned.
2. Opening the card sends the first signed request, `probe`. Its result is
   remembered per (identity, admin host): reopening the card does not probe
   again. The card follows the selected community's relay and the signed-in
   identity; changing either one, including an identity switch on the same
   relay, replaces the console and probes for the new identity unless its role
   is already remembered.
3. A 401 or 403 from any signed request the console sends (reads, writes,
   attachment previews and Save) re-probes in the background. An unchanged
   result keeps the current session so open views do not reload and the
   re-probe cannot repeat itself.
4. Probe outcomes: authorized, access denied (shows the key to give an
   operator), no admin API on the advertised host, or unreachable
   (network, TLS, DNS, or a VPN or SSO gateway).
5. A relay running with admin auth disabled is read-only: every write control is
   disabled (`canMutate` is `authMode === "nip98"`).
6. Browser and dev-broker builds show that the console needs the desktop app.

## Screens

- **Reports**: the whole deployment's queue (`scope=all`), grouped by community,
  with a status filter. A report offers only the actions its target allows
  (event: delete, kick when it has a channel, ban, timeout, dismiss, escalate;
  pubkey: ban, timeout, dismiss, escalate; blob: dismiss, escalate). Each action
  says who receives the reason. A failed enforcement can be cancelled, which
  reopens the report.
- **Feedback**: list, detail and status (new, reviewed, archived). At most five
  attachments and 50 MiB are shown. Images preview inline; every attachment can
  be saved through the native Save dialog.
- **Communities**: the directory searched by host prefix, with the connected
  community pinned and cursor paging. Each community page has Reports,
  Restrictions (lift a ban, clear a timeout), Members and Actions (ban, timeout,
  delete a message after an event preview).
- **Operators** (operators only): add, change and remove staff. Staff set in
  relay configuration can't be changed here, and a read-only relay shows the
  list without any controls. Changing your own entry re-probes.

A relay that answers a route with a complete, empty 404 or 405 lacks it. The
console says so in place ("This relay doesn't support community browsing yet.",
"This relay doesn't support direct actions yet.") and keeps the feature
available.

## Writes

Every write (resolve, reopen, cancelling a failed enforcement, direct actions,
lifting a restriction and operator changes) is held in an in-memory store for
the app session, keyed by the identity, admin host and relay it was made for.
The store, not the screen, owns the request, whether it is sending and its last
outcome. Screens subscribe to it, so a reply that arrives after a screen was
left, the card was closed and reopened, or access was lost and regained still
shows up, and a write that is sending can't be sent again, discarded or
replaced. A held write is never offered or sent under another identity or admin
host. Nothing is saved to disk.

Resolve, reopen and direct actions freeze the whole request, including a
`requestId` minted once, and **Retry** resends it exactly, without reading the
form again. The other writes have no `requestId`, so a new attempt sends the
current form. A write stays held while any attempt is unresolved (`unresolved()`:
an ambiguous response, or a `pending` direct action). Before any such attempt,
anything else settles it, including a request native code never sent. After one,
only the relay's own answer to a request that was sent settles it: a retry that
was never sent, or was refused for authorization, leaves the write held with
the same `requestId`. `request_id_conflict` is shown as an error and is never
resent under a new ID without the user starting a new action.

A late answer to a read is dropped once the identity, admin host, community or
search it was made for has changed: a new search or identity cancels it, and a
new relay or community replaces the view that asked. Search and reason fields
refuse a pasted `nsec` on the device.
