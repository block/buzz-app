#!/bin/sh
# Cargo runner for `just desktop me` on macOS: sign the debug build with the
# local development certificate, so the Keychain helper recognizes it, then
# start it. See scripts/dev-credential-helper.mjs.
set -eu
binary=$1
shift
if ! output=$(/usr/bin/codesign --force --sign "$BUZZ_DEV_HELPER_SIGNING" \
  --identifier xyz.block.buzz.desktop.dev "$binary" 2>&1); then
  printf 'Could not sign %s for the Keychain helper:\n%s\n' "$binary" "$output" >&2
  exit 1
fi
exec "$binary" "$@"
