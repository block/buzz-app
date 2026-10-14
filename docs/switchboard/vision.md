# Agent Switchboard in Buzz

October 14, 2026. Proposed direction, not shipped behavior.

## Purpose

Give John a priority queue of work that needs his attention. Inbox already surfaces agent replies, and archiving lets him dismiss handled conversations. Switchboard must also make visible the work that never produces a reply because an agent became idle or stuck. Runtime activity, unfinished work, and a current request for human action are separate facts.

## Immediate priority

Repair the existing Switchboard inventory first, using read-only observation of Buzz-owned Codex sessions. Prefer the existing App Server when it exposes a connection; otherwise use its saved session database and rollouts for agent identity, conversation location, and historical activity. Do not send nudges or change agent/session state. Live working or idle requires current runtime evidence. The Buzz plugin remains a later prototype.

## First slice

An optional Buzz plugin shows John's Codex agents and their most recent observed activity, newest first. Each agent shows what it is doing and where. Conversation links open the channel for a channel-scoped conversation or the exact thread for a thread-scoped conversation. One agent may have multiple conversations; do not silently hide another active conversation behind its newest one.

An actual runtime observation establishes working or idle. Missing observation, a disconnected host, saved conversation history, and lack of a recent reply do not establish idle. Keep the last observed activity available when live observation is unavailable, and distinguish historical information from current state. Activity that completes does not mean the product task or PR is complete.

Start with activity visibility and navigation. Do not add an independent scheduler, automatically restart agents, change attention watches, revive explicitly stopped work, or replace Inbox's archive/read behavior. Destinations based on the last mention of John remain a future design choice.

## Existing work to reuse

Logan's separate `buzz-branches-plugin`, now called Work, already represents tracked outputs, responsible agents, explicit waits, and linked requests in a Needs-you queue. The [preview discussion](buzz://message?channel=dec3c452-cf15-4472-bb71-8de17a571993&id=2707e801aa0225da1d3c04a38b1790684cd7f6eb5f0b2dd88d03a36d125f5dbc&thread=2707e801aa0225da1d3c04a38b1790684cd7f6eb5f0b2dd88d03a36d125f5dbc) describes relay-persisted artifacts maintained by Bad Janet and expansion beyond branches and PRs. Its source lives on Buzz Git, not in buzz-app. Source inspection is still needed before choosing to reuse its implementation or data contract. No installed board or tracking records have been changed.

Related open work checked on October 14:

- [Morgan's inventory/profile exploration, PR 894](https://github.com/block/buzz-app/pull/894), marked DO NOT MERGE.
- [Tulsi's session settings and lifetime, PR 1079](https://github.com/block/buzz-app/pull/1079), and [sharing and conversion, PR 1070](https://github.com/block/buzz-app/pull/1070).
- [Salman's per-agent session Activity tab, PR 1040](https://github.com/block/buzz-app/pull/1040).
- [Logan's externally readable saved state, PR 974](https://github.com/block/buzz-app/pull/974). It exports settings and saved conversation bindings, not proof of current execution.

Buzz already owns agent identities, conversation navigation, local work presentation, and the Codex runtime. Prefer a small read-only provider observation surface over a second process controller or duplicate interpretation of transcripts. Reuse the shared pane, list, avatar, and navigation components. The first slice should complement Work and the per-agent Activity tab.

## Verification

Exercise two agents, multiple concurrent conversations for one agent, running-to-idle transitions, failed turns, startup, loss of observation, and restoration. Check exact channel/thread routing, current ownership, stable ordering, missing timestamps, and plugin disable/enable cleanup. A saved session must never become a live running claim. Browser fixtures establish rendering and interaction; live native Codex execution needs separate verification.

## Later direction

Connect activity and unfinished work to actionable human requests without duplicating Work's queue or treating every idle agent as needing John. A stalled-work view should explain the evidence and preserve real human waits, external gates, and explicit stops. The broader priority queue remains the goal; the first slice does not claim to implement it.
