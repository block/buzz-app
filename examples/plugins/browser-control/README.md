# Browser control preview

A local macOS experiment on top of Buzz's existing embedded website browser.
Normal builds have no native automation implementation. Build explicitly with:

```sh
bin/just desktop --features experimental-browser-control
```

Use Settings → Plugins → Manage plugins → Load from folder to load this folder,
then enable **Browser control preview**. Click an HTTP(S) link in a conversation.
The panel uses the existing Browser controls and a dedicated named website store
(`browser-control-preview`). Sign in manually; named persistent stores require
macOS 14 or later, as described in [the browser documentation](../../../docs/browser.md).
A more specific panel, such as GitHub, still wins link resolution.

An agent can open its own browser directly with
`browser_control` and `{ "action": "open", "url": "https://example.org/" }`.
Buzz opens a new page beside the current conversation and assigns it to that
local agent automatically. The tool returns after access is ready, so the agent
can immediately observe, click, fill or navigate. Keep the conversation visible.
**Take control** revokes access; reopening the same tab does not renew it.
Opening another page switches that agent's browser to the new page.

To share a page you opened yourself:

1. Open the website beside the conversation with a local agent running in this Buzz instance.
2. Click **Share with <agent>**, or open **Share…** and choose an agent.
3. Ask that agent to use `browser_control` with `action: "observe"`. There is no token to copy.
4. Ask it to fill a text field or click an element identified by a unique CSS selector.
5. Click **Take control**. Further requests must fail until you allow access again.

The toolbar names the agent the browser is shared with. Grants are bound to the
host-authenticated agent membership, community and conversation (including its
thread when applicable). Tokens stay inside the app and are never passed through
chat or tool arguments. Agent selection uses the session's shared choices and
requires an agent running here; an agent hosted by another Buzz instance cannot
use this browser. The toolbar explains this instead of offering a token.

Hiding, covering, closing, or replacing the view revokes control; allow it again
after returning. Grants do not survive app restarts. Takeover stops new requests
and suppresses late results; it cannot undo an action already sent to WebKit.
The UI stays usable while control is allowed. Share only one browser with the
same agent in the same conversation at a time; ambiguous requests are rejected.

The one tool supports `open`, `observe`, `click`, `fill`, and `navigate`. Observe returns
up to 20,000 characters of page text and 100 visible controls, without input values.
Click/fill require exactly one visible match. Fill supports ordinary text inputs
and textareas, and rejects password, file, hidden, read-only and disabled fields.
Native navigation keeps the existing URL policy. The guest receives neither
Tauri IPC nor arbitrary JavaScript supplied by the agent.

This is a draft prototype: DOM clicks are synthetic, so sites requiring trusted
input can reject them. Frames, screenshots, remote agents, downloads and file
uploads are not supported. A timeout is ambiguous; inspect the page before
repeating an action. Website text is untrusted input. No internal distribution or
updater pipeline is changed here.

## Disposable native acceptance

The fixture below creates only a plain host window and local HTTP test website.
It does not load Buzz's frontend, identity, relay services or Keychain:

```sh
bin/cargo run --locked -p Buzz --features experimental-browser-control --example browser-control
```

It exercises the actual Wry guest, observation, fill/click, invalid targets,
revocation, hide, and detach. It prints a PASS line and exits successfully only
when those checks pass. This does not establish real-account login persistence,
full-app plugin installation, live agent conversation, or other-platform support.
