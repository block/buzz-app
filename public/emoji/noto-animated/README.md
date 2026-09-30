# Animated Noto Emoji — local preview

881 animations and static SVGs by Google, listed in
https://googlefonts.github.io/noto-emoji-animation/data/api.json
Downloaded 2026-09-30 from
https://fonts.gstatic.com/s/e/notoemoji/latest/{codepoint}/512.webp
and the corresponding `emoji.svg`. Copyright and registered symbols use
zero-padded `00a9_fe0f` / `00ae_fe0f` in their upstream URLs.

Creative Commons Attribution 4.0:
https://creativecommons.org/licenses/by/4.0/legalcode

SVG artwork is unchanged; trailing whitespace has been normalized. WebP ANIM loop counts are changed to one playback; image
frames and timing are unmodified. Duration metadata lives in noto-animated.json.
Still SVGs load for display; animations are fetched only on interaction or a new
message. Each playback has an isolated blob URL, released on completion/disposal.
Reduced-motion mode always remains static. Missing assets fall back to Unicode.

Local experiment only: roughly 309 MiB of unoptimized source artwork. No added
package dependencies, no protocol changes. Production sizing,
full validation, and native/cross-platform behavior remain separate work.
