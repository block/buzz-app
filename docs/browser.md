# Browser capability

The Browser capability lets plugins display HTTP(S) websites inside Buzz's existing side panel. The page and its address field, Back, Forward and Reload controls appear beside the conversation. Website rendering, navigation controls and native permissions belong to the host; plugins register the panels and choose which links they handle.

## Author contract

```ts
import type { Context } from "@buzz/author";

export const inject = ["react", "panels", "browser"];

export function apply(ctx: Context) {
  ctx.panels.register({
    id: "documentation",
    title: "Documentation",
    matches: (target) =>
      ctx.browser.available && target.startsWith("https://example.org/"),
    // Catch-all band: a panel specific to one site on this host wins by default.
    order: 100,
    component: ({ target }) =>
      ctx.react.createElement(ctx.browser.View, { url: target }),
  });
}
```

`browser.View` is a host-provided React component accepting `{ url: string; storage?: string; label?: string; sessionKey?: string; toolbar?: ComponentType<BrowserToolbarProps>; builderlab?: BuilderlabViewerSession; canResumeUrl?: (url: string) => boolean }`. `label` names the tab until the website has a title. `sessionKey` keeps views with the same URL and storage apart. `toolbar` is a plugin contribution beside the address bar (see Plugin browser control below). `builderlab` and `canResumeUrl` serve Builderlab's bundled app panel. It owns the controls, website viewport and native session for its mounted lifetime. It needs a flex container with available height, as supplied by Buzz's panel card. Plugins do not import internal host modules or invoke native commands directly. This preview API is not a stable compatibility contract.

`browser.available` is currently true only in the macOS desktop application. Web, Windows and Linux builds leave existing link handling unchanged. The Windows native positioning path is unverified; Linux needs a different embedding implementation. URLs must use HTTP(S), contain no credentials, and fit the 2,048-byte limit after URL normalization. Native validation also rejects Buzz's own application and development origins. Invalid addresses leave the existing page visible and show an error.

The example only matches links when the capability is available. It declares the catch-all `order: 100`, so a default-band panel such as GitHub handles the links it recognises regardless of which plugin activated first; see [resolution order](plugin-architecture.md#resolution-order). Modifier-key clicks retain the host's existing behavior. This does not replace every external-link call site or the operating system's default browser.

Each mounted view has its own native website session, which keeps its page while hidden in a background tab or on a pane still sliding into place. Up to four sessions are open at once; past that, the least recently shown hidden one closes, and its view reopens its last page in a new session when shown. Back/Forward retain history while a session lasts. There are no saved history or bookmarks. Temporarily hiding the website for an application dialog does not end its session or stop its network activity.

Closing or replacing the panel, changing community, or disabling the plugin unmounts the view and discards its session and website storage, unless the view names a `storage`. `storage` names a website storage kept between opens and restarts: 1-64 lowercase letters, digits, `-`, `_` or `.`. Views naming the same storage share cookies and site data, so a website sign-in survives closing the panel. Native code derives a dedicated data store from the name, apart from Buzz's own. It requires macOS 14; earlier macOS and other platforms keep the private session. Plugin JavaScript is trusted, so this separates storages by name, not by plugin.

A view with a `storage` also keeps its session for ten minutes after it unmounts, hidden. A view mounted with the same `url` and `storage` in that time, such as the same tab after visiting another channel, takes that session over as it was, mid-sign-in included.

Reloading Buzz's main document ends the website session. An attachment queued before that reload cannot replace a session opened by the new document.

Builderlab's bundled app panel passes a `builderlab` viewer lifetime instead of a
shared website sign-in. The browser host uses its credential only for a native
request to the compile-time Builderlab API origin, then installs the restricted
HttpOnly/Secure viewer cookie on the tenant's fixed Apps domain with the server's
absolute expiry. This is the same cookie as browser login, so login/consent repair
replaces it instead of creating a conflicting second cookie.
If the native exchange is unconfigured or its endpoint returns 404, the same
account-isolated guest opens through browser login. Other errors stay closed.
The guest stays blank until installation or this fallback finishes and its account lifetime is checked. No
credential or generic cookie/header capability is exposed to the guest. Each
account selects its own storage, kept across sign-ins and restarts so a browser
login made through this fallback persists. Each sign-in is a separate lifetime;
aborting it closes its live and parked guests, including a guest whose attach
finishes after cancellation.
Normal website views retain the storage behavior above.

## Native ownership

The controls are ordinary trusted React UI in Buzz's main webview. Website content is a separate raw Wry child view positioned over the panel's website viewport, created without a Tauri IPC handler, custom protocols or host initialization scripts. It uses a nonpersistent data store, or the named persistent store described above. The main window's content-security policy is unchanged.

The mounted view reports its viewport bounds and visibility to native code. Native code validates and clips bounds to the main webview. Resizing, scrolling and opening application overlays update guest placement or visibility. The guest stays shown while the Buzz window is in the background or behind another app's window. Session identifiers prevent delayed callbacks or cleanup from controlling a replacement view.

This distinction is required by the locked Tauri implementation: its built-in channel-data fetch command bypasses ordinary command ACL checks. Empty Tauri capabilities alone would not establish a guest with no native IPC. The raw guest has no Tauri bridge to invoke that command.

The generated app-command manifest makes native permissions explicit. Only the main webview receives attachment, positioning, navigation, action, status and detachment commands, and the four agent-control commands `browser_control_available`, `browser_control_grant`, `browser_control_revoke` and `browser_control_execute`. Capabilities target its webview label, not the containing window; Tauri combines window and webview matches with OR. A sibling guest must not inherit the main webview's commands.

URLs submitted through the API/address field and navigation requests surfaced by the native engine pass the URL policy. Back/Forward use native history. Popups and downloads are unsupported. Camera/microphone requests are denied natively; permission behavior requires native acceptance checks on each supported platform. This is not a claim that websites cannot make network requests or that trusted plugin JavaScript is sandboxed.

Changes to the locked Tauri/Wry versions require native navigation, resize, teardown and permission checks on supported desktop platforms. Browser tests in Chromium/WebKit do not establish those native guarantees.

The macOS webview currently lacks detailed network-failure reporting through the shared Wry callbacks. A failed TLS/network navigation can leave a blank page; the address field and Reload remain available. The toolbar reads native loading state rather than leaving its loading indicator pending indefinitely. File upload is unavailable on macOS. Rejected website navigation may originate in a subframe, so it is blocked without attributing a top-level page error; an invalid address submitted through Buzz's controls still reports its validation error.

## Verification

Host tests cover view ownership, browser controls and generated native permissions. Native acceptance must additionally exercise link opening inside the main window, navigation, panel/window resize, overlay visibility, close/reopen, guest IPC absence and rejected navigation against the actual application. PR evidence records the platform and exact checked commit; untested platforms remain unverified.

## Try the capability with a local plugin

Start the macOS desktop app from a checkout containing this capability with `bin/just desktop`. Create a local folder containing these two files. This JavaScript example needs no build step or additional repository.

`manifest.json`:

```json
{
  "id": "example.browser-preview",
  "name": "Browser example",
  "apiVersion": 1
}
```

`plugin.js`:

```js
export const inject = ["react", "panels", "browser"];

export function apply(ctx) {
  ctx.panels.register({
    id: "example-site",
    title: "Example site",
    matches: (target) =>
      ctx.browser.available && target.startsWith("https://example.org/"),
    order: 100,
    component: ({ target }) =>
      ctx.react.createElement(ctx.browser.View, { url: target }),
  });
}
```

In Settings → Plugins → Manage plugins → Load from folder, select that folder and enable **Browser example**. Click `https://example.org/` in a message. The website and navigation controls should appear beside the conversation; a default-band panel that also matches the link, such as GitHub for a GitHub URL, wins instead. Other links keep their existing behavior.

Check address entry, Back/Forward/Reload, resizing, opening an account menu, closing/reopening the panel, and disabling the plugin. Web, Windows and Linux keep their existing link handling. The example requires a host that provides `browser`; older hosts cannot activate it.

## Plugin browser control

Normal macOS builds provide a native capability that lets an agent read and operate a website guest. The guest keeps its existing IPC isolation. Native grants are revocable, and actions require a visible guest. Hiding the panel, covering it with a Buzz dialog, menu or popup, resizing the window, or closing the guest revokes access. The Buzz window in the background or behind another app's window does not revoke access. The agent's later calls then fail with `not_visible`, which tells it to open the page again, until a page is shared with it again. A Share of that page with another agent makes them fail with `unavailable` instead. Arbitrary agent-supplied JavaScript is not accepted.

The [Browser plugin](https://github.com/squareup/buzz-plugin-browser) owns the agent tool, the sharing toolbar, recipient selection and the page-opening workflow. It contributes a toolbar to `ctx.browser.View`, and ordinary views have no sharing controls. The host provides the active session and status, a native presentation barrier, shared UI primitives, and authenticated grant, execute and revoke operations. It does not open agent pages or choose recipients. Installing the native capability registers no agent tool and gives no access to any page.

### Requests and Snapshots

`execute` takes one request and resolves to a Snapshot:

| action | fields |
|---|---|
| `observe` | `scope`, optional: `page` (default) or `viewport` |
| `click` | `ref` |
| `fill` | `ref`, `text`, `submit`, optional (default false) |
| `select` | `ref`, `value` (1 to 1,024 UTF-8 bytes) |
| `press` | `key`: `Enter`, `Tab`, `Escape`, `Backspace`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `PageUp`, `PageDown`, `Home` or `End` |
| `scroll` | exactly one of `direction` (`up` or `down`) and `ref` |
| `navigate` | `url` |
| `back`, `forward`, `reload` | none |
| `wait` | `for`: `"load"` or `{ref}`, and `timeout_ms`, optional: an integer from 0 to 10,000 (default 5,000) |

Native code rejects unknown actions and fields. A `ref` matches `^r[1-9][0-9]{0,9}e[1-9][0-9]{0,5}$`, `text` is at most 8,192 UTF-8 bytes, and `url` must pass the URL policy above.

A Snapshot is `{url, title, revision, loading, text, elements, truncated}`:

- Native code sets `url` (at most 2,048 bytes), `title` (at most 200 characters), `revision` and `loading`. A hostile page cannot change them. A longer title or URL is cut and sets `truncated`.
- `revision` counts documents. It changes each time a guest commits a new document, from one counter shared by every guest since app start.
- `loading` is true while WebKit loads a page, and when a new document committed while native code built the Snapshot. The Snapshot can then be out of date.
- `text` holds at most 20,000 characters of visible page text, on-screen text first. It leaves out input, textarea, select, script, style and contenteditable content.
- `elements` lists at most 150 visible links, buttons, fields, selects, headings and elements with an explicit `role`, on-screen ones first. Each element is `{ref, role, name, inViewport, href?, checked?, disabled?}`. Each visible `<select>` also lists up to 30 of its options with role `option`. Names never read a field's value or editable content. `href` appears only for HTTP(S) links of at most 2,048 bytes.
- `truncated` is true when the Snapshot left out or cut any content.

A ref is `r<revision>e<n>`. It names one element until the guest commits a new document, and only listed elements get refs. A ref from an older revision, or one whose element left the document, fails with `stale_ref` before the action runs. The message then adds a newline and a fresh Snapshot.

Page script builds `text` and `elements`, so native code parses that part into fixed types and checks every limit again. A reply that breaks a limit fails with `unavailable`. Every reply, `stale_ref` messages included, is at most 128 KiB.

`click` and `fill` check, in order: visibility, disabled state (`:disabled` or an `aria-disabled="true"` ancestor), element kind, and read-only state. A hidden element fails with `not_interactable` before its kind is checked. `fill` takes text, search, email, URL, telephone and number inputs and textareas. It fails with `unsupported_input` on passwords, file inputs, contenteditable elements, other input types, and fields that change the text, such as letters in a number input. `click` fails with `unsupported_input` on a file input and with `not_interactable` on an option.

### Forms, keys and scrolling

`click`, `fill` and `select` focus their element first.

`select` works on a native `<select>` only, and fails with `unsupported_input` on anything else. It takes the first option whose value equals `value`, then the first whose trimmed label does. No match fails with `invalid_request`. A disabled match, including an option in a disabled `<optgroup>`, fails with `not_interactable` and leaves the selection unchanged. Native code does not look past it for another option. Otherwise the option is selected, the only one in a multiple select, and the select gets bubbling `input` and `change` events.

`press` sends `keydown`, then `keypress` for Enter only, then `keyup` to the focused element. WebKit runs no default action for script events, so two keys get emulated ones, unless the page cancels `keydown` or `keypress`:

- Tab moves focus to the next element in tab order.
- Enter on a button or a link calls `click()`.
- Enter on a text, search, email, URL, telephone or number input runs implicit submission for its form owner, in these steps from the HTML standard:
  1. Find the default button: the first submit button in tree order whose form owner is the form. A submit button is a `<button>` of type `submit`, or an input of type `submit` or `image`.
  2. When the default button is disabled, stop. A later enabled button is not used.
  3. When the default button is enabled, call `click()` on it. Its `click` handlers, `formaction`, `formmethod` and `formnovalidate` apply, and it is the `submit` event's `submitter`.
  4. When the form has no submit button, count its inputs of type text, search, tel, url, email, password, date, month, week, time, datetime-local and number. With more than one, stop.
  5. With one, call `form.requestSubmit()`.

Enter anywhere else, and every other key, sends events only. So Enter on a `<select>` or a `<textarea>` does not submit a form unless the page's own handler does, and `PageDown` does not scroll.

`fill` with `submit: true` fills the field, then sends Enter in a second script evaluation. Page microtasks from the `input` event, such as one that enables the submit button, run in between. Native code checks the grant again before the second evaluation. The Enter step runs only when the document still holds the filled ref. After a new document committed in between, it sends nothing, and the Snapshot shows the new document. When the Enter step fails, the new value stays in the field. When the `input` event started a navigation that has not committed yet, WebKit can drop the form submission; the Snapshot then shows the page that load reaches.

`scroll` with `direction` scrolls the nearest scrollable ancestor of the element at the viewport center, or the document when there is none, by that container's height. `scroll` with `ref` scrolls the element to the middle of the viewport and fails only when the element is not visible. Both scroll at once, even on pages that ask for smooth scrolling. A container at its end does not move.

### Settle, history and wait

Every action except `observe` and `wait` ends with a settle step before its Snapshot. Native code polls the guest every 50 ms. When a new document committed, it waits until loading ends. When the document did not change, it stops once the guest has been idle for 300 ms. It stops 1 s before the deadline and returns the Snapshot with the current `loading`. So `navigate` and `back` return the page they led to, and each page-changing action takes at least 300 ms when the document stays the same.

`back`, `forward` and `reload` run the same native history as the toolbar's Back, Forward and Reload, so the person and the agent move one history. With no history entry, `back` and `forward` change nothing and return the current Snapshot.

`wait` with `for: "load"` polls `loading` every 50 ms until it is false. `wait` with `for: {ref}` checks the element every 100 ms until it is visible and enabled, and it never fails with `not_interactable`. `timeout_ms` bounds the condition, and `timeout_ms: 0` tests it once. The Snapshot after a met condition gets 1 s more, so a `wait` call can take up to 11 s. This departs from the 10 s `wait` limit in the product requirements, because a 10 s cap on the whole call would leave a `timeout_ms` of 10,000 no time for the Snapshot. Every other call has one 5 s deadline for the action, the settle step and the Snapshot.

Each poll checks the grant and visibility again, so a revoke or a detach ends a wait within one poll with `not_visible`.

One action runs at a time on a page. A second call fails with `busy` until the first one ends, on any outcome, a timeout included. `wait` and the settle step count as running.

### Logging

Native code writes one stderr line per call, `browser_control execute action=<action> outcome=<ok|code> ms=<n> session=<first 8 characters of the session ID>`. It also writes one line per grant, and one per revoke of a live grant with `reason=hide|resize|command`. The lines never hold page text, values, URLs, refs or tokens. They show only when Buzz runs from a terminal.

### Error codes

Every failure message is `<code>: <one sentence>`:

| code | meaning |
|---|---|
| `invalid_request` | The request breaks the schema or a limit, or names no matching option. |
| `invalid_url` | The URL fails the URL policy. |
| `unavailable` | No page is shared with the caller here, or the reply was malformed or too large. |
| `not_visible` | The page was hidden, covered by a Buzz overlay, resized, closed, replaced or evicted, or its access was revoked. |
| `revoked` | The person took control. The plugin raises it. |
| `busy` | Another action runs on the page. |
| `stale_ref` | The ref is from an older revision, or its element left the document. |
| `not_interactable` | The element fails its action's precondition. |
| `unsupported_input` | The action cannot operate this kind of element. |
| `timeout` | The 5 s deadline passed, and the action may have run. |

`BrowserAccess` grant errors keep their unprefixed sentences, because the toolbar shows them to the person.
