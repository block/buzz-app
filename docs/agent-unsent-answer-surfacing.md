# Surfacing an agent's unsent answer

Proposal, November 10, 2026. This document describes a known behavior — an
agent turn that produces prose but never calls a Buzz message tool — and asks
maintainers to decide whether and how that prose should reach the channel. It
records the current mechanism precisely so the decision can be made against the
real code, and recommends an option without committing to it.

## The behavior

An agent answers a mention or DM, writes a reply as ordinary assistant prose,
and ends the turn **without** a successful `send` (or any other message tool).
The owner sees nothing in the channel timeline. The text is not lost: it appears
under **View activity** for that run. So from the human's side the agent looks
like it stalled — the question sits unanswered in the channel while the answer
exists only in the activity transcript.

This is not a Solo-chat rendering bug or a `final`-flag bug. It is the
documented outcome of a turn that answered nowhere in Buzz.

## Why it happens today, in the code

1. As the model streams, the harness accumulates assistant text into `written`
   (`src/features/agent-harness/acp/session.ts`, in `update(...)` for
   `agent_message_chunk`, guarded by `!this.acted`). This is just the model's
   prose; nothing is published.
2. A turn only counts as answered in Buzz when a message tool succeeds.
   `session.answered()` sets `acted = true`
   (`src/features/agent-harness/acp/process.ts`, where a successful call whose
   name is in `ANSWERS` notifies the session). `ANSWERS` is the message tools
   plus `edit` and `react`.
3. At turn end, `done()` settles with
   `text = this.acted || this.stopped ? "" : this.written.trim()`
   (`src/features/agent-harness/acp/session.ts`). So when the model never called
   a message tool, the accumulated prose rides out as `Settled.text` with
   `answered` absent.
4. `Settled.text` is explicitly the non-published fallback. Its type comments say
   so: *"What the harness wrote, when it answered nowhere in Buzz. Nobody saw
   it."* (`src/features/agent-harness/acp/types.ts`).
5. Each harness runtime, on settling, posts only errors to the channel and
   leaves `text` in local activity. The intent is stated identically across
   runtimes — for example `src/bundled/goose/runtime.ts`: *"An answer goose
   wrote without `send` stays in local activity."* The same comment appears in
   `src/bundled/pi/runtime.ts`, and `src/bundled/claude-code/runtime.ts`
   follows the same shape, acting on `result.undelivered` and `result.error`
   but never on a successful-but-unanswered `result.text`.
   `src/bundled/codex/runtime.ts` is structured differently (its own
   `answered()` signal and failure publication) but reaches the same outcome:
   it publishes turn failures and does not publish an unsent successful answer.

So stranding the prose is deliberate and consistent, not an accident in one
runtime. That is exactly why changing it is a product decision rather than a
drive-by fix.

## Why it is intentional — and why that is still a trap

Silence is frequently the correct end to a turn. A watch wakes the agent and it
decides there is nothing to do; an ambient message does not need a reply; a
follow-up adds nothing. The base agent contract tells agents that publishing is
optional and a bare acknowledgement must not be sent. Auto-publishing *every*
no-message turn would turn that discipline into channel noise.

The trap is the narrow case the discipline does not cover: the turn **owed a
reply** (it was a direct mention or DM), the model **did** compose a substantive
answer, and it simply failed to route that answer through a tool. There the
human is left waiting on an answer that already exists. The behavioral fix —
agents always `send` — depends on the model never slipping, with no safety net
when it does.

## What distinguishes the trap from ordinary silence

The settle result already carries enough to tell them apart at the point each
runtime decides whether to post:

- `ok` is true and `stopped` / `undelivered` are absent — the turn ran to a
  clean end, not an interrupt or a drop.
- `answered` is absent — no message tool succeeded.
- `text` is non-empty — the model actually composed prose.
- The delivery was a direct request that owes a reply (mention or DM), not a
  watch or timer one-off. Watches and timers already run through `runOnce` /
  standalone paths and should stay silent by default.

A turn that is merely, correctly silent has empty `text`, so it never trips any
of the options below.

## Options

### A. Leave it stranded (status quo)

No code change. Rely entirely on agents always calling `send`, and on **View
activity** for forensics. Simplest and quietest, but every model slip is an
invisible non-answer to the person who asked.

### B. Surface a visible marker, not the prose

When the trap case is detected, post a short system-styled line in the thread —
e.g. *"This agent wrote a reply but didn't post it. Open View activity to read
it."* — instead of the prose itself. The human is no longer left waiting and is
pointed to the text, while unreviewed model prose never auto-lands in the
channel. Costs a new presentation affordance and still makes the human take a
second step to read the answer.

### C. Auto-post the unsent prose

In the trap case, publish `Settled.text` to the thread as the agent, mirroring
the existing error-report path (`report(...)` → `post(...)` in each runtime),
optionally with a subtle "posted automatically" marker. The human gets the
answer in place. The cost is that the stranded prose was never meant for a
channel — it may be half-formed, may contain the model talking to itself, and
there is no `final`/audience/threading intent behind it. Acceptable only with
the trap guard above (owed a reply, clean end, non-empty text) so it cannot fire
on legitimate silence.

### D. Nudge the agent to finish instead of ending

When a turn is about to settle in the trap case, inject one corrective turn
("you wrote a reply but never called `send`; post it now") before giving up, and
fall back to B or C if the agent still does not send. Closest to the intended
behavior and keeps the human-facing message agent-authored, but adds a retry to
the turn lifecycle and extra model cost, and needs a loop guard.

## Recommendation

Option **B**, with the trap guard, as the default safety net, and a route to
**D** later if maintainers want the answer to stay agent-authored. B is the
smallest change that stops leaving a person waiting on an answer that exists,
and it never auto-publishes unreviewed prose, so it is hard to turn into noise.
It also composes with the behavioral fix rather than replacing it: agents should
still always `send`; B only catches the slip.

Whatever is chosen should live at the shared settle boundary so all four
runtimes behave identically, rather than being added to one runtime's
`done.then` handler and drifting.

## Not in scope

- Changing when agents *decide* to stay silent. The guard deliberately fires
  only when the model already produced an owed answer.
- Replaying stranded text from past runs. This is about the turn as it settles.
- The agent-facing contract wording ("use `send` to post"). That stays; this is
  the net under it.
