# Attention parity with Janet

This page compares how buzz-app runs agent attention (watches, timers and
mentions) with how janet-acp runs it. A "gap" is a known difference that we
intend to close. An "intended difference" is a choice we made on purpose.

Terms:

- **Interest**: a named piece of work. Watches and timers belong to one.
- **Lane**: a queue that runs one turn at a time.
- **Catch-up**: the events a watch missed while the agent was offline, read
  from the relay when the agent comes back.

## Compared behavior

| Behavior | Janet | buzz-app | Status |
| --- | --- | --- | --- |
| Mentions have their own lane, so watch work cannot take their room | Yes | Yes. Each lane has a queue limit of 32 and a rate limit of 60. | Same |
| Turns of one Interest run one at a time, in order | Yes | Yes, in the shared agent runner, for every agent type | Same |
| Interests that run at the same time | 8 | 8, beside the mention lane | Same |
| Jobs that wait for one Interest | 8 | 8 (32 in total for watch work) | Same |
| Live events of a watch wait while that watch catches up | Yes | Yes. At most 512 events or 4 MiB wait. | Same |
| Catch-up page limit | 256 pages or 8 MiB for a named channel; none for `channels: "all"` | 256 pages or 8 MiB for both | Intended difference |
| Watch tags are sent in the catch-up read | Yes | No. The relay applies most tag filters after its page limit, so a tagged read can return an empty page while older matches remain. The watch's own match still checks the tags, so results are the same. | Intended difference |
| Catch-up order | Newest page first, oldest first inside each page | Reads the whole window, then delivers strictly oldest first | Intended difference |
| Catch-up delivery | One event per turn | Batches of up to 64 messages or 64 Ki JSON characters (about 16k–32k tokens) per turn | Intended difference |
| The agent is told that an event comes from catch-up | Yes | Claude Code: yes. Codex: no, see below. | Gap (Codex) |
| Codex catch-up | Not applicable | Codex has no catch-up turn. It runs each missed event as a separate watch turn, oldest first. | Gap |
| Codex timers | Not applicable | Not supported. A timer turn fails. | Gap |
| Watch events from people other than the owner | The watch sees them | Claude Code: sees them as data. Codex: ignores them, because it applies its mention owner check (`fromOwner`) to watches too. | Gap (Codex) |

## Not yet compared

- Watch logs and diagnostics.
- Replay limits for event kinds other than 9 (see #955).
- The watch filter grammar.
