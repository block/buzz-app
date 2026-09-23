# Attachment delivery, first split

The development broker accepts binary POSTs at a captured community's `/upload`
endpoint and signs a Blossom PUT to that relay. It does not advertise a composer
capability yet. The existing authenticated media proxy handles downloads.

Limits: 1 byte–20 MiB per upload, two concurrent uploads across communities,
120-second whole-operation deadline, 8 KiB response. Disconnect cancels pending
work. Accepted results must match the uploaded bytes' hash, size and relay media
location. Upstream errors become stable codes without exposing server details.
The relay owns membership admission, content sniffing and metadata rejection;
browser MIME values are hints, not acceptance rules. No legacy upload fallback.

## Audit and next slices

Use one generic file model plus optional media previews, not per-extension UI.
Old Buzz (`block/buzz` at `2130920`, `crates/buzz-media/src/validation.rs`)
accepts ordinary documents/archives through a generic file path, while separately
validating images/video and rejecting dangerous recognized formats. Documents
are not universally metadata-cleaned. This source policy is not proof of the
currently deployed relay's accepted formats; deployed generic-file acceptance
still needs verification before composer enablement.

Berd (`berd-oss` at `ce48ca5`, `src/features/chat/lib/attachments.ts` and
`sendCore.ts`) uses generic file/directory chips, but folders are sender-local
path references. Remote sessions strip those references. Buzz needs shared
copies, not local paths; folder bundles are a separate product decision.

[Drive separates storage from previews](https://support.google.com/drive/answer/37603?hl=en).
[Browser MIME hints are unreliable](https://developer.mozilla.org/en-US/docs/Web/API/Blob/type).
[Directory picking returns files and relative paths](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/webkitdirectory),
not a portable archive. Apply [layered upload controls](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).

Next: existing-conversation selection/removal, upload only on Send, access checks
and recovery; then first-message conversation creation with destination-correct
uploads and retry. Keep the existing editor/mention chips. Folder bundling,
paste/drop, metadata cleaning and packaged native upload are not in this slice.

## Verification boundary

`dev/attachment-upload.test.mjs` uses real local HTTP and the production broker
with ephemeral signing keys and controlled upstream responses. It covers signed
binary upload through protected download, routing, rejection, cancellation,
admission and limits. It does not prove deployed file acceptance, a composer send,
metadata cleaning or packaged native support. No browser cases added or removed.
