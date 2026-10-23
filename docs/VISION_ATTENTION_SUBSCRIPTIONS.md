# Attention subscriptions

Proposed direction, revised October 23, 2026 following John’s live design review.

An Interest holds task instructions. Its subscriptions specify when to wake the agent and an optional delivery address. Keep per-subscription instructions out for now; reconsider them when a concrete need emerges. New recipes can create an Interest or attach a trigger to an existing one.

Event watches, timers and plugin sources remain distinct trigger types with shared scheduling and delivery. Preserve existing saved objects, timer budgets and producer completion. Forms, event selectors, channel names and thread-link resolution belong to the external Attention plugin.
