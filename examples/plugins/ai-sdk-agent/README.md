# AI SDK agent

A Buzz plugin that contributes one agent type, "AI SDK assistant", built on the
plugin agent types API (`ctx.agentTypes.register`) and the Vercel AI SDK.

An agent of this type runs when a message mentions it. Without a workspace it is a
chat assistant. With one it is a coding agent: it reads and edits files and runs
commands in a folder on its owner's computer, for up to 128 rounds of tool calls
or 30 minutes.

## What a run does

- **Replies.** Each stretch of text the model writes is published once, as one
  message (kind 9) in the mention's thread. Nothing is edited afterwards.
- **Live view.** While the run is going, its thinking, tool calls and the text
  being written show above the composer, in the owner's window only
  (`delivery.live`). The view goes away when the run ends.
- **Failures.** A run that fails, runs out of time or reaches the step limit says
  so in the thread, because the live view does not outlast the run.

## Tools

Always:

- `read_messages`: the thread or the channel, read through the owner's session
- `post_message`: a separate message in the same channel, signed as the agent

With a workspace, the tool set of the pi coding harness:

| Tool | What it does | Built on |
| --- | --- | --- |
| `read` | A text file, 2000 lines or 50k characters at a time | `workspace.readFile` |
| `write` | Creates or replaces a file | `workspace.writeFile` |
| `edit` | Exact replacements, each matching once | `readFile`, `writeFile` |
| `ls` | One directory | `workspace.list` |
| `bash` | Any command; returns the end of long output | `workspace.exec` |
| `grep` | File contents, with `rg` or `grep` | `workspace.exec` |
| `find` | Files by glob, with `rg` or `find` | `workspace.exec` |

## Settings

- **Provider, model, instructions**: the plugin's own form, saved as the agent's
  config.
- **API key**: a secret named `API_KEY` that the type declares. The host draws the
  field, stores the value and never shows it again; the plugin reads it at the
  start of each run with `agent.secret("API_KEY")`.
- **Workspace**: a folder the owner enters. The type sets `workspace: true`, and
  the host draws the field.

## Requires

A Buzz desktop build from branch `art4/coding-agent`. It has all of these, none of
which is on `main`: plugin agent types, `ctx.host.fetch`, live runs, secrets,
concurrency and the agent workspace. The workspace works on macOS and Linux only.

## Build and test

```sh
npm install
npm run types   # generates @buzz/author types from this checkout
npm run check
npm test        # builds dist/, then runs the tests
```

`dist/` holds `manifest.json` and one self-contained `plugin.js`. Load that folder
from Settings → Plugins → Load from folder, then enable the plugin. Create an agent
of type "AI SDK assistant", give it a key and a workspace folder, add it to a
channel and mention it there.

The tests run the real AI SDK and provider code against a canned Messages API
stream, and the tools against a real temporary directory and a real bash. They do
not run the desktop app.

## Layout

- `src/plugin.ts`: the agent type, its settings form, and the wiring to `ctx`
- `src/run.ts`: one run: the AI SDK `ToolLoopAgent`, the two chat tools, and the
  model's stream turned into live steps and published messages
- `src/tools.ts`: the seven coding tools and the limits on what they return
- `src/thread.ts`: event tags, and folding edits and deletions into what a reader sees
- `src/config.ts`: the saved config

## Known limits

- **`bash`, `grep` and `find` are not confined to the workspace.** They start
  there and run as the owner, with no sandbox. Only `read`, `write`, `edit` and
  `ls` are held inside the folder. Giving an agent a workspace is the same
  decision as running any coding agent in that folder.
- Nothing is remembered between mentions except the files and the thread.
- An agent runs one mention at a time; a second waits for the first.
- A command's output is not shown while it runs, and a finished step shows no
  result. The live view has no place for either.
- People other than the owner see nothing until the first message is published.
- Reads use the owner's session, so the agent can read what its owner can. The
  chat tools are limited to the channel of the mention.
- The agent must be a member of the channel to be mentioned and to post there.
- Moderator deletions (kind 9005) are not applied to what `read_messages` returns.
