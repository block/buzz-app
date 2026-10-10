# Agent avatar packs

PNG posters and animated WebM/HEVC variants from Block's Berd avatar catalog `20260925T154625166Z`.
Berd's `scripts/avatar-manifest.mjs` and `src-tauri/src/commands/avatars.rs`
define the collections and published CDN. Source: https://github.com/block/berd.

The 49 original PNGs are unmodified and verified against the upstream manifest's
SHA-256 checksums, retained in `catalog.json`. Fuzzies has 19 images, Gloopies 23,
and Figgies 7. The latter retains the upstream `pollies` IDs; Berd renamed its
visible label from Pollies to Figgies.

Bundled posters let the creation picker and New agent tile work without remote
image requests. Saved profiles use the corresponding versioned HTTPS poster URL
from the catalog, through Buzz's existing picture field and media path, so other
clients can display them. No filesystem or app-local URL is published to a relay.
The original variants are checksum-verified against the same upstream manifest.
Native builds use Tauri’s target platform to bundle only HEVC on macOS and WebM
on Windows/Linux. Browser builds retain both formats for different engines.
Posters and the selected native codec remain bundled for offline use.
The creation preview, picker choices, and agent cards use animated variants. Reduced
motion and playback failures use the poster. Saved profiles remain portable PNG
URLs, so animation never changes the relay profile format.

Buzz includes seven Figgies: the purple characters, turtle, dog, wildcat, and clown (upstream IDs pollies-2, 9, 10, 21, 23, 24, 25). The other human figures are excluded.
