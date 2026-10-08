# Local Bestie

The bundled `buzz.bestie` plugin is off by default; enable it under **Settings →
Plugins → Bestie**. After community sign-in on desktop it uses the existing
native agent controls to create a separate local agent key, obtain owner
attestation, publish its profile, install instructions, and start the ordinary
ACP listener. It copies the harness from Agent defaults and inherits inference
and workspace from them at start.

Bestie's home is one existing private session named **Bestie**, containing only
the owner and this agent. The Bestie page shows that session with the shared
timeline and composer. The session has exactly one agent, so the composer routes
to it without the agent picker. The listener subscribes only to that channel
(`BUZZ_ACP_CHANNELS`) with one worker; it answers only its owner. Inviting it
elsewhere through Members does not make it listen there.

Existing local storage records the exact agent and channel IDs before further
setup; retries reuse them. A missing committed identity or resource stops setup
instead of silently allocating a replacement. Disabling the plugin or switching
community stops the local runner; it does not delete keys, chat or memory. Native
app quit also stops local execution.

Memory uses the existing encrypted relay `buzz mem` commands, following the
readable-memory preset in `src/bundled/bestie/memory.md`: small `core`,
`mem/user` (portrait, facts and open loops) and dated notes. The instructions
check the private audience before retrieving or disclosing personal memory. They
are cooperating-agent rules, not a semantic validator or memory transaction.

Local means execution on this desktop while Buzz is running and the machine is
awake; inference can still use a configured cloud model. This baseline has no
heartbeat, scheduled maintenance, dreaming or check-ins: Bestie acts only when
the owner messages it.

## Build and launch this worktree

Quit other **Buzz Foundation** copies first. From this worktree:

```sh
BUZZ_DEV_VIEWER= bin/just desktop --no-watch
```

The explicit empty viewer override uses the native owner identity rather than a
legacy dev pin. Debug builds take Databricks host/model defaults only from
`BUZZ_BUILD_AGENT_ENV` (see [configuration](configuration.md)); without them set
a workspace and model in **Settings → Agents** before setup.

Agent-issued GUI launches must use a clean environment: an inherited
`BUZZ_MANAGED_AGENT` marker can make Buzz's orphan cleanup terminate the app, and
the agent's credentials and routing would otherwise leak into it.

```sh
BUZZ_DEV_VIEWER= bin/just desktop-bundle
/usr/bin/env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" TMPDIR="$TMPDIR" \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  /usr/bin/open 'target/debug/bundle/macos/Buzz Foundation.app'
```

## Human acceptance checklist

1. Enable **Settings → Plugins → Bestie**, select the intended community, and
   open **Bestie**. Wait for setup. Errors offer **Retry setup**; once the agent
   exists, **Edit Local Bestie** opens its editor (for example **Advanced →
   Model** for a missing Databricks workspace).
2. In **Agents**, confirm one **Local Bestie** with its own identity, profile
   published, running, and **Start on app launch** off. In Sessions confirm
   **Bestie** contains only the owner and the agent.
3. In Bestie, confirm there is no agent picker, then send “Reply with
   `local-bestie-chat-ok`.” Expect a reply from the Local Bestie identity.
4. Send “Remember that my test marker is `orchid-A`.” Then open **Agents → Local
   Bestie → View profile → Memories** and confirm `mem/user` holds the marker
   with a real source event.
5. Quit and reopen the app. Expect the same agent public key and channel, with no
   second Local Bestie. In a new thread ask for the marker; expect `orchid-A`.
6. Disable the Bestie plugin: Local Bestie stops. Re-enable: the same agent and
   chat resume.
