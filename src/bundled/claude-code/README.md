# Claude

Create agents that run Claude on your computer and answer you in Buzz. Each agent works in its own **Workspace** folder and can run commands and edit files on its own.

## Getting started

1. Go to **Settings** → **Agent setup** → **Harness defaults** → **Claude** to install Claude. Choose **How Claude signs in**: an Anthropic API key from [console.anthropic.com](https://console.anthropic.com/settings/keys), or a Claude account (`claude auth login`). The API key is the default. Buzz keeps a key in the OS credential store (Keychain on macOS), never in a file or back in the app, and native code gives it only to Claude processes while that method is selected. Account mode does not send the key. Security reviews in account mode need a separate `claude setup-token` paste.
2. Choose **New agent** → **Create a new agent**, and pick **Claude** as the **Harness**.
3. Mention your agent in a conversation to give it work.
