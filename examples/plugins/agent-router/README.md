# Solo Agents Router

Select agents in a Solo chat and ask normally. Before sending, this optional
plugin makes one shared decision using your configured Decisions API provider
(for example, TypeSafe/JEV). It assigns one, several, or all selected agents.
Only the assigned agents receive notification mentions and start work.
For up to eight candidates, one choice question lists every nonempty subset,
including single agents and the full set. JEV chooses the exact assigned set
with confidence; there are no per-agent yes/no questions on this path.
Eight candidates produce 255 options, the Decisions API limit. Routing supports
at most eight selected agents. With more than eight, the plugin sends to all
selected agents without calling the Decisions API. There is no alternate
routing algorithm for larger pools.

It needs the host's `conversation.registerAgentRouter` extension. It will refuse
to activate on builds without it. Install this folder through Settings → Plugins
→ Manage plugins → Add → Browse. Configure Settings → Decisions API before use.
Disabling the plugin restores normal sends to all selected agents.

- New and existing owner-created Solo chats use routing. Ordinary channels,
  DMs, human recipients, and programmatic agent messages keep normal delivery.
- All selected candidates can remain in the chat; a request can assign any subset.
- Work requiring agents to coordinate starts all selected agents. Routing runs
  only on a user send through the Solo composer, not on agent replies, intermediate
  outputs, or agent-to-agent messages. Those continue through normal Buzz delivery.
- Open-ended group requests for thoughts, opinions or feedback start everyone,
  even without saying "all"; for example, "What are your thoughts on Buzz?"
  Naming particular agents or asking for one answer narrows that audience.
  A calendar check or other factual task should select one suitable agent. The decision receives every selected agent's public
  profile bio, recent loaded chat messages, and the saved instructions Buzz has
  for each selected agent in that chat's community. A profile bio is separate
  from the role instructions installed with a Marketplace agent. Saved Marketplace
  instructions are included when the agent's type exposes them here; missing
  external instructions are not downloaded by this plugin. Instructions are bounded to 8,000
  characters per agent and 16,000 total, shared evenly across candidates.
  Raw settings, credentials, and workspace paths are not extracted from config.
  Instructions are capability evidence, not permission or verified tool access;
  unavailable instructions remain unknown. No remote configuration fetch occurs.
- Uncertain or empty assignments send to all selected agents automatically.
  Provider failures or plugin routing errors also fall back to all selected
  agents. Unavailable settings or invalid saved community addresses are skipped
  during instruction lookup, so public evidence can still be used to route.
  Retries of an already-sent or
  queued message retain the captured assignment and model/effort choices.
- This plugin assigns the initial worker set. It does not implement a manager,
  wait for a cross-turn collaboration to finish, or synthesize a combined answer.
  Multiple assigned agents can each respond. Those capabilities are separate
  from avoiding unnecessary initial runs.

The [synthetic routing benchmark](BENCHMARK.md) records live worker selections
and decision request sizes, including the policy and agent context. Net token
and cost savings remain unmeasured. The router adds latency and cost; compare
total usage, including JEV, against the avoided runs.
