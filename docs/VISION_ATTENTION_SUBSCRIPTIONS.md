# Subscription prompts and optional Interests

Proposed direction, October 23, 2026, following John’s live Attention design review.

A subscription should express both its trigger and its own task prompt. It can stand alone. An optional Interest groups related subscriptions and supplies shared instructions. Shared instructions and the subscription prompt both reach the agent; the event or function output remains untrusted observed data. Standalone subscriptions have independent scheduling lanes, while subscriptions in an Interest retain their shared lane.

Existing objects must remain readable without rewriting them. Legacy subscriptions keep their existing Interest instructions, prompts, selectors, destination, paused state, timer budgets and producer completion state. New standalone event and function subscriptions require a prompt. The external plugin shows standalone subscriptions directly and uses a group only for an explicitly assigned Interest.

The host gap is persistence validation, wake prompts and scheduling currently requiring an Interest. Extend those general capabilities and the agent tools; keep the forms and presentation in the external Attention plugin. The form should support all current event selectors and optional channel/thread delivery, with names and links resolving to the existing IDs.
