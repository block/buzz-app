# Browser capability

The external [Browser example](../examples/plugins/browser/README.md) opens HTTP(S) links inside Buzz's existing side panel. The page and its address field, Back, Forward and Reload controls appear beside the conversation. No second window is created. Website rendering, navigation controls and native permissions belong to the host.

## Author contract

```ts
import type { Context } from "@buzz/author";

export const inject = ["react", "panels", "browser"];

export function apply(ctx: Context) {
  ctx.panels.register({
    id: "documentation",
    title: "Documentation",
    matches: (target) =>
      ctx.browser.available && target.startsWith("https://example.org/docs/"),
    component: ({ target }) =>
      ctx.react.createElement(ctx.browser.View, { url: target }),
  });
}
```

`browser.View` is a host-provided React component accepting `{ url: string }`. It owns the controls, website viewport and native session for its mounted lifetime. It needs a flex container with available height, as supplied by Buzz's panel card. Plugins do not import private host modules or invoke native commands directly. This replaces the earlier proposal's `browser.open()` window API; the preview API has not shipped as a stable contract.

`browser.available` is currently true only in the macOS desktop application. Web, Windows and Linux builds leave existing link handling unchanged. The Windows native positioning path is unverified; Linux needs a different embedding implementation. URLs must use HTTP(S), contain no credentials, and fit the 2,048-byte limit after URL normalization. Native validation also rejects Buzz's own application and development origins. Invalid addresses leave the existing page visible and show an error.

The example only matches links when the capability is available. Existing first-match panel precedence remains: an earlier GitHub panel can still handle a GitHub link. Modifier-key clicks retain the host's existing behavior. This does not replace every external-link call site or the operating system's default browser.

One native website session is supported at a time. Closing or replacing the panel, changing community, or disabling the plugin unmounts the view and discards that session's website storage. Back/Forward retain history while the same panel remains open. There are no tabs, saved history or bookmarks. Temporarily hiding the website for an application dialog does not end its session or stop its network activity.

## Native ownership

The controls are ordinary trusted React UI in Buzz's main webview. Website content is a separate raw Wry child view positioned over the panel's website viewport, created without a Tauri IPC handler, custom protocols or host initialization scripts. It uses a nonpersistent data store. The main window's content-security policy is unchanged.

The mounted view reports its viewport bounds and visibility to native code. Native code validates and clips bounds to the main webview. Resizing, scrolling, hiding the document and opening application overlays update guest placement or visibility. Session identifiers prevent delayed callbacks or cleanup from controlling a replacement view.

This distinction is required by the locked Tauri implementation: its built-in channel-data fetch command bypasses ordinary command ACL checks. Empty Tauri capabilities alone would not establish a guest with no native IPC. The raw guest has no Tauri bridge to invoke that command.

The generated app-command manifest makes native permissions explicit. Only the main webview receives attachment, positioning, navigation, action, status and detachment commands. Capabilities target its webview label, not the containing window; Tauri combines window and webview matches with OR. A sibling guest must not inherit the main webview's commands.

URLs submitted through the API/address field and navigation requests surfaced by the native engine pass the URL policy. Back/Forward use native history. Popups and downloads are unsupported. Camera/microphone requests are denied natively; permission behavior requires native acceptance checks on each supported platform. This is not a claim that websites cannot make network requests or that trusted plugin JavaScript is sandboxed.

Changes to the locked Tauri/Wry versions require native navigation, resize, teardown and permission checks on supported desktop platforms. Browser tests in Chromium/WebKit do not establish those native guarantees.

The macOS webview currently lacks detailed network-failure reporting through the shared Wry callbacks. A failed TLS/network navigation can leave a blank page; the address field and Reload remain available. The toolbar reads native loading state rather than leaving its loading indicator pending indefinitely. File upload is unavailable on macOS. Rejected website navigation may originate in a subframe, so it is blocked without attributing a top-level page error; an invalid address submitted through Buzz's controls still reports its validation error.

## Verification

Host tests cover view ownership, browser controls and generated native permissions. The standalone example has its own tests/build. Native acceptance must additionally exercise link opening inside the main window, navigation, panel/window resize, overlay visibility, close/reopen, guest IPC absence and rejected navigation against the actual application. PR evidence records the platform and exact checked commit; untested platforms remain unverified.
