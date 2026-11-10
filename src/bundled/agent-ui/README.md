# Agent cards

Shows text, tables and editable drafts inside messages.

## Getting started

1. When an agent or teammate posts a supported card, it appears inside the message.
2. Edit its fields and choose **Copy draft** to copy your current changes. Edits stay local and reset when the message changes or the card is reopened.
3. Copying does not send mail, approve work or return your changes to the agent. Paste them into your next message when you want to share them.

---

The bundled **Agent cards** plugin renders `buzz-ui` Markdown fences using
`@json-render/react` and Buzz's shared controls. It uses the conversation's
existing code-block contribution API: the host owns the frame, copying the
source, selection semantics and error recovery. Non-interactive previews and
disabled plugins retain ordinary code.

An agent can include a fence in its normal message or final reply. No separate
tool, endpoint, agent harness or signing change is needed:

````markdown
Here is the draft. Your edits stay local; copy them when you're ready.

```buzz-ui
{
  "version": 1,
  "root": "draft",
  "state": { "body": "Hello,\n\nHere is my draft." },
  "elements": {
    "draft": {
      "type": "Card",
      "props": { "title": "Review a draft" },
      "children": ["body", "copy"]
    },
    "body": {
      "type": "TextInput",
      "props": {
        "label": "Body",
        "value": { "$bindState": "/body" },
        "multiline": true
      },
      "children": []
    },
    "copy": {
      "type": "Button",
      "props": { "label": "Copy draft", "action": "copyDraft" },
      "children": []
    }
  }
}
```
````

Keep a useful prose summary outside the fence for clients without this plugin.
[example.json](example.json) also demonstrates text, a table and a single-line
field. This is an experimental presentation format inside existing messages,
not a new Nostr event kind. Coordinate protocol work with
[block/buzz#4089](https://github.com/block/buzz/pull/4089), which proposes a
dedicated native surface event.

## Version 1 contract

All properties are strict; unknown fields, component types, versions and
actions fall back to readable source. Element IDs and state keys start with an
ASCII letter and contain at most 40 letters, digits or underscores.

| Component | Properties | Children |
| --- | --- | --- |
| Card | `title`: string | Element IDs, in display order |
| Text | `text`: string | None |
| Table | `columns`: string array; `rows`: equally sized string arrays | None |
| TextInput | `label`: string; `value`: `{ "$bindState": "/stateKey" }`; optional `multiline`: boolean | None |
| Button | `label`: string; `action`: `"copyDraft"` | None |

The top-level object requires `version: 1`, `root`, `elements` and `state`.
The root is a Card. Every element must appear exactly once in a connected tree.
Bindings point to existing string state fields. Limits are 32 KiB UTF-8, 64
elements, depth eight below the root, 32 children per Card, 16 state fields,
4,000 characters per string, six table columns and 32 rows.

Authors cannot supply HTML, scripts, styles, URLs, arbitrary event handlers or
network actions. Markup-looking strings remain literal text. Any message author
may supply a card; it does not establish agent identity, authority or approval.

**Copy draft** copies the current field values in display order, including each
label. Cards with a copy button must include at least one TextInput. It uses the
shared host-aware clipboard helper and reports failures.
Edits are local, reset on message edits/unmount, and do not update the signed
message. Buttons cannot send mail, approve work, execute commands or send input
back to an agent. That requires a separately designed authenticated action path.

## Checks

```sh
bin/pnpm exec vitest run src/bundled/agent-ui
bin/pnpm typecheck
bin/pnpm design:check
bin/pnpm build
```

To try the real message row with fixture data, run
`bin/pnpm exec vite --config vite.message-gallery.config.ts --host 127.0.0.1`
and open `/tests/fixtures/message-gallery.html?group=agent-cards`. Use
`&theme=dark`, **Narrow preview**, keyboard navigation and browser zoom to inspect
the supported layouts. This gallery has no live relay identity.
