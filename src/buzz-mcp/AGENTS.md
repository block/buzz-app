# Buzz tools

The tools in this directory are the reference interface for Buzz agents, local
and remote. Remote agents run on another host, which implements the same tools,
so a prompt, skill or habit that works for a local agent works for a remote
one. Change them deliberately.

## Where things live

- `tools.ts`: each tool's name, description and schema in `TOOLS`, and its
  behavior in `HANDLERS`.
- `attention.ts`: the attention tools (`interest_*`, `watch_*`).
- `session-tools.ts`: what a session lists, each tool's `load` (`always` or
  `search`), and the server instructions that cover the whole tool set.
- `prompt.md`: the posting conventions every agent gets after the shared base
  prompt, `src/features/agent-harness/base_prompt.md`. Both name tools.

## Changing a tool

These are interface changes:

- a tool's name
- its description
- its argument names, types and descriptions
- which arguments are required
- its defaults, such as `channel` and `reply` defaulting to the current
  conversation
- the shape of its result and its error text
- its `load` mode

Call each one out in the PR description as a tool interface change, and update
`prompt.md` and `base_prompt.md` in the same change if they name the tool.
Running sessions don't all pick up a change: a resumed Codex thread keeps the
Buzz tools it started with, so a renamed or removed tool fails there. See
[agent types and providers](../../docs/agents.md#agent-types-and-providers).

Prefer adding a tool or an optional argument to changing an existing one.

## Design rules

1. **Many small tools are fine** as long as each has a clear name, a precise
   description and explicit parameters. Prefer `canvas_get` and `canvas_set` to
   one `canvas(action, …)` tool.
2. **Don't hide tools behind a discovery meta tool**, such as a `search_tools`
   or `run_tool(name, args)` wrapper. List each tool with its real schema, and
   use `load: "search"` for tools that don't need to load up front.
3. **Don't bloat descriptions or schemas.** A description says what the tool
   does and anything the model can't guess. Routing, etiquette and workflow
   guidance go in the server instructions or `prompt.md`, not in every tool.
   Describe an argument only when its name and type don't make its meaning
   clear.
4. **Mark writes accurately** with MCP tool annotations where possible.
5. **Use server instructions** for guidance that covers the whole tool set:
   which tool to reach for, how tools relate, and shared conventions.

## Keep the core tools portable

A remote agent's host may run these tools without access to the agent's files
or to Buzz Desktop. Keep that possible:

- The core messaging, reading, memory, notes and canvas tools must work with
  text arguments alone. A local file path argument (`path`, `files`) is an
  alternative to text, never the only way in.
- Some tools need Buzz Desktop and fail elsewhere: `agent_*`, `self_handoff`,
  `tabs`, `repo` and `channel_create`'s `template`. Keep new desktop-only
  behavior in the same shape: a clear error when the host can't support it.
- Remote agents may not have the attention tools.

A remote host that can't support an argument leaves it out of its schema. It doesn't
accept the argument and ignore it, or rename it.
