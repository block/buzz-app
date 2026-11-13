# Claude

Create agents that run Claude on your computer and answer you in Buzz. Each agent works in its own **Workspace** folder and can run commands and edit files on its own.

## Getting started

1. Go to **Settings** → **Agent setup** → **Harness defaults** → **Claude** to install Claude and paste an Anthropic API key from [console.anthropic.com](https://console.anthropic.com/settings/keys). Also enter the **Anthropic workspace ID** to use with that key. Buzz keeps them in the OS credential store (Keychain on macOS), and native code gives them to every Claude process, security reviews included.
2. Choose **New agent** → **Create a new agent**, and pick **Claude** as the **Harness**.
3. Mention your agent in a conversation to give it work.

**Organization-scoped API keys require an Anthropic workspace ID on every request.** Copy the `wrkspc_` ID from the Claude Console's [Workspaces](https://platform.claude.com/settings/workspaces) page. You can use an existing workspace or create one for Buzz. Save the ID together with the API key and enter it again when replacing the key. This ID is separate from an agent's **Workspace** folder. Saving credentials checks their format, not API access or the key's scope. See [Anthropic's authentication documentation](https://platform.claude.com/docs/en/manage-claude/authentication#select-a-workspace) for the API's scope rules.

Open **Settings** → **Claude** to manage the saved key. Focus or click the masked field, or use its chevron, to open **Replace / Remove**. Replacement starts blank and masked, asks for the workspace ID again, and offers **Cancel / Save** controls. Settings cannot reveal or copy the saved key. **Remove** deletes the key and workspace from secure storage after confirmation; the menu is unavailable during replacement. Key management also works when Claude needs installation or an update.

New local Claude sessions and security reviews need a key again after removal; a turn already running can finish. Agents on another computer use that computer's credentials.

---

## Authentication transport

Buzz drives the Claude Code binary over the same stream-JSON protocol as the Claude Agent SDK. Authentication follows the SDK's [environment option](https://code.claude.com/docs/en/agent-sdk/typescript#options) and Claude Code's [documented environment variables](https://code.claude.com/docs/en/env-vars):

- `ANTHROPIC_API_KEY` carries the saved API key.
- `ANTHROPIC_CUSTOM_HEADERS` carries `anthropic-workspace-id: <workspace ID>`. Multiple headers are newline-separated; Buzz preserves unrelated headers when adding the saved workspace ID.

`ANTHROPIC_WORKSPACE_ID` is documented for workload identity federation, not API-key workspace selection.
