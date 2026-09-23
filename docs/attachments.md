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

## Verification boundary

`dev/attachment-upload.test.mjs` uses real local HTTP and the production broker
with ephemeral signing keys and controlled upstream responses. It covers signed
binary upload through protected download, routing, rejection, cancellation,
admission and limits. It does not prove deployed file acceptance, a composer send,
metadata cleaning or packaged native support. No browser cases added or removed.
