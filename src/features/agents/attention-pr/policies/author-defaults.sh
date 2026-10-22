# Default comment-author lists for pr-monitor.sh, sourced before its options are parsed.
# Replace this file with MONITOR_PR_AUTHOR_DEFAULTS; options still adjust the lists it sets.

# Repository owners whose own organization members are trusted when no --employee-org or --allowlist is given.
TRUSTED_ORGS="squareup block"
# Bots trusted alongside those members (exact logins).
TRUSTED_BOTS=$'builderbot-code-review[bot]\nsquare-task-list-completed[bot]\ngithub-actions[bot]'
# Routine bots whose comments are suppressed unless --no-ignore-bots.
IGNORE_AUTHORS=$'square-kochiku-worker-api\npr-preview-sync\nowner-owl'
