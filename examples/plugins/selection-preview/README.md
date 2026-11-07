# Selection preview example

Install this folder in a desktop build with `conversation.registerSelectionPreview`.
Enable it, then select `EX-42` in a message body. The host shows the preview beside
the selection. Ordinary prose does not match. Copy works with the preview open.

The matcher runs locally. The plugin requests no native capabilities or network
access. The host owns the popup, chooser, placement and dismissal. Several matching
previews remain available in a chooser, ordered by `order`, then contribution key.

This example requires the new host contract; older builds do not support it.
