# NIP-TT: Thread Titles

> Buzz draft. This is not an upstream standardized NIP.

NIP-TT lets the author of a channel message say that the message is only the
title of its thread: the content is in the replies. A client can then show the
message as one compact line in the channel timeline, not as a full message.

## Tag

A thread title is a regular kind `9` channel message with exactly one
`thread-title` tag, with exactly two elements:

```json
["thread-title", "1"]
```

For example, with placeholder IDs:

```json
{
  "id": "<NIP-01 event ID>",
  "pubkey": "<author hex pubkey>",
  "created_at": 0,
  "kind": 9,
  "tags": [
    ["h", "<channel ID>"],
    ["thread-title", "1"]
  ],
  "content": "Release checklist",
  "sig": "<NIP-01 signature>"
}
```

The claim holds only when all of these are true:

- the event is kind `9`;
- it is top level: it has no NIP-10 `e` tag with the `reply` marker, so it
  starts a thread rather than replying in one;
- it has exactly one `thread-title` tag, and that tag is `["thread-title", "1"]`.

Any other value, a tag with extra elements, or a repeated tag claims nothing,
and the message shows as an ordinary message. The tag is part of the signed
event, so only the author can make the claim.

## Presentation

Buzz shows a thread title as one line: the author, a thread mark, the title
text and the time. Opening the line opens the thread. The line keeps the
message's reactions, Reply and message actions, and any accessories that
describe work the message started.

The title text is the content with Markdown flattened and spoilers hidden, the
same way notifications show it.

The claim describes the content the author sent. Buzz shows the full message
instead of the line when:

- the current content, after an edit, holds more than one line;
- the content would show as an empty title;
- a message renderer handles the message.

## Compatibility

Clients that do not know the tag ignore it and show an ordinary message, which
reads the same. Authors should therefore keep a thread title's content short
and readable on its own.
