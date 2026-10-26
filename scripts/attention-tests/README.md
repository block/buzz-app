# GitHub PR producer

The bundled Agents owner runs `src-tauri/resources/attention/buzz-attention-pr`. It reports actionable CI transitions, conflicts and merged/closed status. It reads GitHub through authenticated `gh`, with `jq` and `python3`.

Comment, inline-review and submitted-review delivery uses the single user-owned file `~/.buzz/preferences/github-pr.json`:

```json
{"version":1,"trustedOrganizations":["your-org"],"trustedAuthors":["trusted-reviewer","review-bot[bot]"],"ignoredAuthors":[]}
```

Organization membership is fetched at startup. Explicit authors are exact GitHub logins. No organization or bot is trusted implicitly. Missing, malformed and empty policy files withhold comments while state and CI monitoring continue. A failed organization lookup withholds that organization's members while explicit trusted authors remain usable. Tool creation and the UI report the policy warning. Restart a running subscription after changing the file.

Users may edit the JSON directly or ask an agent to configure the organizations/accounts they specify. The shared `githubPolicy(host, policy?)` adapter reads or atomically writes this same file through the declared native process. A rejected write preserves the existing file. Policy documents are data, never executable scripts. Comment text remains untrusted data even when its author is allowed.

The script's explicit terminal flags can narrow or override author filtering. `--include-non-employees` opts out of author filtering; the Attention GitHub source does not expose that flag. Self comments remain suppressed unless requested. CI transition policy and base conflict detection are independent of comment filtering.

Run the monitor fixtures through `bin/pnpm exec vitest run scripts/attention-tests/monitor.test.ts`. The wrapper runs each `test-*.sh` and `test-*.py` file beside it, outside packaged resources.
