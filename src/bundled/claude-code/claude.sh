# Buzz's own copy of Claude, apart from any `claude` the user installed.
# The plugin runs it as `bash -c` (see `withScript` in setup.ts), each time
# with one of these steps:
#
#   run [ARGS...]                    runs the copy in use with ARGS
#   install VERSION PLATFORM SHA256  downloads a release and checks it
#   use VERSION                      makes a downloaded release the one in use
set -eu

# Shared by every Buzz build on this computer, so there is one download.
if [ "$(uname)" = Darwin ]; then
  dir="$HOME/Library/Application Support/Buzz/claude-code"
else
  dir="${XDG_DATA_HOME:-$HOME/.local/share}/buzz/claude-code"
fi

# Versions name folders, so only digits and dots: no `..` or `/` escapes.
valid() {
  case "$1" in "" | [!0-9]* | *[!0-9.]*) return 1 ;; esac
}

command="$1"
shift
case "$command" in
run)
  # The plugin names a release to test it before it is in use.
  version="${BUZZ_CLAUDE_VERSION:-$(cat "$dir/current" 2>/dev/null || true)}"
  # 127, as for a missing program: the plugin reads it as "not installed".
  valid "$version" || { echo "Claude is not installed" >&2; exit 127; }
  exec "$dir/$version/claude" "$@"
  ;;
install)
  version="$1" platform="$2" checksum="$3"
  valid "$version" || { echo "Invalid version" >&2; exit 2; }
  case "$platform" in
  darwin-arm64 | darwin-x64 | linux-arm64 | linux-x64) ;;
  *) echo "Unsupported platform" >&2; exit 2 ;;
  esac
  mkdir -p "$dir/$version"
  # Each download has its own temporary file, so two Buzz builds updating at
  # once do not write over each other, and a stopped one leaves nothing.
  part="$dir/$version/claude.$$"
  trap 'rm -f "$part"' EXIT
  trap 'exit 143' INT TERM
  # Give up on a stalled download rather than holding the update forever.
  curl -fsSL --speed-limit 1024 --speed-time 60 -o "$part" \
    "https://downloads.claude.ai/claude-code-releases/$version/$platform/claude"
  # The release manifest's checksum, which the plugin passes in.
  actual=$( (shasum -a 256 "$part" 2>/dev/null || sha256sum "$part") | cut -d" " -f1)
  [ "$actual" = "$checksum" ] || { echo "The download did not match its checksum" >&2; exit 1; }
  chmod +x "$part"
  # A rename, so a session starting now sees the old file or the whole new one.
  mv -f "$part" "$dir/$version/claude"
  ;;
use)
  version="$1"
  valid "$version" || { echo "Invalid version" >&2; exit 2; }
  test -x "$dir/$version/claude"
  previous=$(cat "$dir/current" 2>/dev/null || true)
  printf %s "$version" >"$dir/current.$$"
  mv -f "$dir/current.$$" "$dir/current"
  # Keep the new release and the one before it, to fall back to; remove the rest.
  for folder in "$dir"/*/; do
    folder=$(basename "$folder")
    [ "$folder" = "$version" ] || [ "$folder" = "$previous" ] || rm -rf "${dir:?}/$folder"
  done
  ;;
*)
  echo "Unknown command: $command" >&2
  exit 2
  ;;
esac
