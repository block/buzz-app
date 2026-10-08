// Temporary worktree-recovery fix; see lefthook-recovery.md before changing this pin.
description = "Lefthook with isolated worktree recovery"
repository = "https://github.com/evilmartians/lefthook"
binaries = ["lefthook-runner"]
requires = ["go-1.27.0"]
strip = 1
source = "https://codeload.github.com/evilmartians/lefthook/tar.gz/cc9969c2e2198aafff8accc63ee1aee30e9a2aa4"
sha256 = "f8e6e7d01e77d0814a00d0cfadd9db08f05ce526252c8b388201c02fffeb55db"
version "2.1.18-buzz.3" {}

on "unpack" {
  copy { from = "lefthook-recovery.patch" to = "${root}/recovery.patch" }
  run {
    cmd = "/bin/sh"
    args = ["-s"]
    stdin = "set -eu; unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR; export GIT_CEILING_DIRECTORIES=\"$(dirname \"$PWD\")\"; git apply recovery.patch"
  }
  // bin/lefthook provisions Go before entering Hermit's unpack lock.
  run {
    cmd = "/bin/sh"
    args = ["-s", "--", "${root}/../go-1.27.0/bin/go"]
    stdin = "export GOTOOLCHAIN=local CGO_ENABLED=0; unset GOROOT; exec \"$1\" build -trimpath -buildvcs=false -o lefthook-runner ."
  }
}
