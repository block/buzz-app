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

1. Click **Allow agent control** in the browser toolbar.
2. Copy **Browser control token** into a private conversation with a local agent.
3. Ask it to use `browser_control` with that token and `action: "observe"`.
4. Ask it to fill a text field or click an element identified by a unique CSS selector.
5. Click **Take control**. Further requests using that token must fail.

The token grants access to that browser session, including signed-in pages, until
revoked. It is a capability, not an agent identity: any local agent given it can
use it. Do not post it in a shared channel. Creating another grant replaces the
previous token. Hiding, covering, closing, or replacing the view revokes control;
allow it again after returning. Grants do not survive app restarts. Takeover stops
new requests and suppresses late results; it cannot undo an action already sent
to WebKit. The UI stays usable while control is allowed.

The one tool supports `observe`, `click`, `fill`, and `navigate`. Observe returns
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
