# Message bubbles

An installable, off-by-default appearance experiment. Requires a Buzz build that
includes `conversation.registerAppearance`; older hosts report a clear activation
error. API version 1 alone does not imply this capability is available.

## Try it

1. In the updated desktop app, open Settings → Plugins → Load from folder.
2. Select this `message-bubbles` folder and install **Message bubbles**.
3. Enable it, then open an existing conversation.
4. Disable it to restore the default message layout immediately.

The host owns rendering, message data, delivery, attachments and interactions.
This plugin only selects the `bubbles` preset: left-aligned bubbles, distinct
own-message colors in light/dark modes, compact same-author groups, bottom-aligned
avatars, and inset name/delivery labels. Attachment, reaction and Retry polish
is shared app UI and remains when this plugin is disabled.

No build step, network access, private CSS selectors or DOM mutations are needed.
Installing copies these files; edits are not watched. Load the folder again to
update; use Roll back to return to the previous installed revision.

The gallery's **Message bubbles** toggle previews the same host preset. It does
not install a plugin or exercise native plugin storage.
