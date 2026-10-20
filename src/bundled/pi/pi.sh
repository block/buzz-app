# Buzz's Pi host on Mac and Linux: this finds Node, which the app's PATH may
# lack, then runs launch.mjs on it. The plugin runs it as `bash -c` (see
# `start` in pi.ts) with LAUNCH, the launcher's source; stdin is the
# launcher's. Windows starts `node` itself.
set -eu

# Pi's packages need Node 22.19 for `node:sqlite`. The app's PATH has
# Homebrew's folders; a version manager's are set up by a login shell.
usable() {
  [ -n "$1" ] && [ -x "$1" ] && "$1" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)' 2>/dev/null
}
node=$(command -v node || true)
usable "$node" ||
  node=$("${SHELL:-/bin/sh}" -lc 'command -v node' </dev/null 2>/dev/null || true)
usable "$node" || {
  echo "Pi needs Node.js 22.19 or later. Install it from nodejs.org or with Homebrew, then try again." >&2
  exit 127
}

exec "$node" --input-type=module -e "$1"
