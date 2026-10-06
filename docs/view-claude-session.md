# View a Claude Code session started by Buzz

Buzz runs Claude Code through `claude-agent-acp`. Claude Code saves transcripts
as JSONL under `~/.claude/projects/<project>/<session-id>.jsonl`. The project
directory derives from the agent's working directory, with non-alphanumeric
characters replaced by `-` (long paths also get truncated and hashed). For
example, `/Users/alex/.buzz` becomes `-Users-alex--buzz`.

If the agent has `CLAUDE_CONFIG_DIR` set in its Environment, use that config
directory instead. `CLAUDE_CODE_PROJECT_DIR_NAME` overrides the project name when
set alongside `CLAUDE_CONFIG_DIR`. Run the commands below on the machine that runs
the agent, with `rg` and `jq` installed.

## Find the session

Start from the Buzz link to the thread. In its `buzz://message` link, take the
64-character `thread=` value, or `id=` when the link has no `thread=`. That is
the thread root. Search transcripts for the context Buzz sent to Claude:

```sh
root='<thread-root-id>'
claude_config_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
rg -l -F -e "Thread root: $root" -e "Event ID: $root" \
  "$claude_config_dir/projects" -g '*.jsonl'
```

Usually exactly one session matches. A channel-scoped session can contain several
Buzz threads; subagent transcripts and restarted sessions can also match. Check
the working directory, timestamps, session ID, and actual recorded model:

```sh
session='/path/to/matching-session.jsonl'
jq -r 'select(.type == "user" or .type == "assistant") |
  [.timestamp, .sessionId, .cwd, .type, .message.model // "-"] | @tsv' \
  "$session"
```

If the Buzz link is unavailable, search for a distinctive part of your message
using `rg -l -F 'distinctive message text' "$claude_config_dir/projects" -g '*.jsonl'`.
JSON escaping can prevent a literal match for text containing quotes or newlines.

## View messages and tool activity without resuming

```sh
jq 'select(.message != null) |
  {timestamp, type, model: .message.model, content: .message.content}' \
  "$session" | less
```

This shows user messages, assistant text, tool inputs, and tool results. Match
`tool_use.id` with `tool_result.tool_use_id` to follow a command and its output.
It reads the saved file without sending a prompt or starting another Claude
session. The transcript is not a complete capture of the system prompt or launch
environment; use Buzz's agent configuration and process log for those details.

For an empty Buzz reply, inspect the send command and its tool result. A failed
producer in `producer | buzz messages send --content -` can leave Buzz with empty
stdin while the final command still succeeds. Shell aliases can also affect
commands when their target programs are absent from the agent's PATH. Successful
CLI exit or `accepted: true` alone does not prove that the intended text arrived;
check the Buzz thread as well.

## Open in Claude Code and export text

For a readable export, stop the agent in Buzz first so it cannot write to the same
session concurrently. Use the Claude CLI installed in Settings (its sign-in
instructions show the executable path if `claude` is not on your terminal PATH).
Use the same `CLAUDE_CONFIG_DIR` if the agent overrides it:

```sh
session_id=$(jq -r 'select(.sessionId != null) | .sessionId' "$session" | head -n 1)
CLAUDE_CONFIG_DIR="$claude_config_dir" claude --resume "$session_id"
```

Inside Claude Code, run `/export session.txt`. This produces a plain-text
conversation export. Resuming opens an interactive session; sending a prompt
there can invoke tools and change the conversation. The standalone CLI does not
recreate Buzz's launch environment or tool configuration. Use the read-only
commands above when diagnosing a running agent.

Keep transcripts and exports local unless you intend to share their contents.
Claude's JSONL schema is internal and can change between releases. Missing files
can also reflect retention or disabled persistence. See [Claude Code session
documentation](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)
for storage overrides, retention, and supported export interfaces.
