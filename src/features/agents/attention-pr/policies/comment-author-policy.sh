#!/usr/bin/env bash
# Shared comment-author filtering policy for pr-monitor.sh.
# Exit 0 when the event should be suppressed, 1 when it should be emitted.

comment_author_is_ignored() {
  local author="${1:-}"
  local current_user="${2:-}"
  local include_self="${3:-0}"
  local ignored_authors="${4:-}"

  local allowed_authors="${5:-${ALLOWED_AUTHORS:-}}"
  local allowlist_enabled="${6:-${AUTHOR_ALLOWLIST_ENABLED:-0}}"

  if [[ "$allowlist_enabled" == "1" ]] && ! grep -qixF -- "$author" <<< "$allowed_authors"; then
    return 0
  fi
  author="${author%\[bot\]}"
  if [[ "$include_self" != "1" && -n "$current_user" && "$author" == "$current_user" ]]; then
    return 0
  fi
  if [[ -n "$ignored_authors" ]] && printf '%s\n' "$ignored_authors" | grep -qxF "$author"; then
    return 0
  fi
  return 1
}
