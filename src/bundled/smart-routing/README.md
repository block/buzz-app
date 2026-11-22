# Smart routing

When you send a message in a channel, Jev decides who answers it and where the answer goes, as the message arrives.

## Getting started

1. Turn on **Smart routing** in **Settings → Plugins → Manage plugins**. It routes only while decisions can be answered (Builderlab with decisions, or a TypeSafe key under **Settings → Decisions API**). Until then it does nothing, and its card under **Settings → Plugins → Smart routing** says it needs a decisions provider.
2. Send a message without tagging anyone. Jev picks one of your agents in the channel that runs on this device, or none, and wakes it. The pick shows beside the message's time, for example `→ ART 84% · top level`.
3. Tag an agent yourself and Jev only decides where its answer goes, shown as `where: thread`.

**Where answers go.** A reply inside a thread always stays in that thread. For a top-level message, Jev judges whether the channel is a working conversation (a small group on one thing, such as a feature-branch swarm) or a shared space (announce, general, team or support channels), whether the message explicitly asks for a thread or the top level, and whether it points back to an earlier message the conversation has moved past. An explicit ask wins; a working conversation answers at the top level, or in the earlier message's thread; a shared space answers in a thread on the message. "Post it in #release-notes" or "answer in Lena's thread" stays with the agent, which is told the message may ask for another place.

If Jev can't answer, nothing changes: no one is woken for an untagged message, and a tagged agent answers in a thread on it. Open a marked message's **⋯ → Smart routing** to see every answer behind the decision; agents can read recent decisions with the `smart_routing_log` tool.

This replaces the Jev auto-tag plugin: turn that off before turning this on, or both will wake agents.
