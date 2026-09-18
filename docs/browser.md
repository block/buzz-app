# Browser capability

The external [Browser example](../examples/plugins/browser/README.md) opens HTTP(S) links in a Buzz-owned desktop window. It uses the public `browser` capability and the existing panel registration API. Website rendering, navigation controls and native permissions belong to the host.

## Author contract

```ts
import type { Context } from "@buzz/author";

// Call from a user action in a plugin declaring inject = ["browser"].
async function openDocumentation(ctx: Context) {
  return ctx.browser.open("https://example.org/docs");
}
```

`browser.available` is false in the web application. `open(url)` returns `opened`, `unavailable`, `invalid-url` with a reason, or `failed` with a reason. `opened` means the native window accepted the request; it does not certify that the remote page loaded successfully. URLs must use HTTP(S), contain no credentials, and fit the 2,048-byte limit after URL normalization. Native validation also rejects Buzz's own application and development origins.

The example only matches links when the capability is available. Existing first-match panel precedence remains: an earlier GitHub panel can still handle a GitHub link. Modifier-key clicks retain the host's existing behavior. This does not replace every external-link call site or the operating system's default browser.

One browser window is reused. It has an address field, Back, Forward and Reload. Closing it discards its browsing session. Disabling the plugin removes link interception; a window already opened by the user remains open until closed. There are no tabs, saved history, bookmarks or background browsing service. An opened page remains active while its window is unfocused.

## Native ownership

The toolbar is an app-owned Tauri webview. Website content is a separate raw Wry child view, created without a Tauri IPC handler, custom protocols, host initialization scripts or the toolbar's webview configuration. The guest uses a nonpersistent data store. The main window's content-security policy is unchanged.

This distinction is required by the locked Tauri implementation: its built-in channel-data fetch command bypasses ordinary command ACL checks. Empty Tauri capabilities alone would not establish a guest with no native IPC. The raw guest has no Tauri bridge to invoke that command.

The generated app-command manifest makes native permissions explicit. Main retains its existing application commands and gains `browser_open`. Only the `browser-controls` webview receives navigation, action and status commands. Capabilities target that webview label, not the containing window; Tauri combines window and webview matches with OR.

URLs submitted through the API/address field and navigation requests surfaced by the native engine pass the URL policy. Back/Forward use native history. Popups and downloads are unsupported. Camera/microphone requests are denied natively; permission behavior requires native acceptance checks on each supported platform. This is not a claim that websites cannot make network requests or that trusted plugin JavaScript is sandboxed.

The child-view integration uses Tauri's `unstable` API. Changes to the locked Tauri/Wry versions require native navigation, resize, teardown and permission checks on supported desktop platforms. Browser tests in Chromium/WebKit do not establish those native guarantees.

The macOS webview currently lacks detailed network-failure reporting through the shared Wry callbacks. A failed TLS/network navigation can leave a blank page; the address field and Reload remain available. The toolbar reads native loading state rather than leaving its loading indicator pending indefinitely. File upload is unavailable on macOS/Linux; Windows can display the system picker after a website's user-initiated request.

## Verification

Host tests cover public result handling, browser-control state and generated native permissions. The standalone example has its own tests/build. Native acceptance must additionally exercise link opening, navigation, window reuse, resize, close/reopen, guest IPC absence and rejected navigation against the actual application. PR evidence records the platform and exact checked commit; untested platforms remain unverified.
