# Routing benchmark

This is a small, synthetic **initial-worker selection benchmark**, not an
end-to-end token or cost benchmark. It measures live routing choices and the
size of the complete plugin decision request. Worker executions, tool calls,
reasoning tokens, output tokens and cached input tokens were not measured.

## Method

Run from the repository root:

```sh
bin/node examples/plugins/agent-router/benchmark.mjs > /tmp/solo-router-requests.json
```

The script captures requests from the actual plugin with three synthetic
agents: Assistant (weather/calendar), Budget (campaign budgets) and Writer
(drafting/editing). Each has a short bio and saved instructions; conversation
history is empty. The script performs no network calls or agent runs. It emits
each request's `state` and `questions` in the format accepted by Buzz's
`decisions_ask` tool. Ask that tool once per record using those two fields to
repeat the live decision checks with your configured provider. Its selected
choice maps directly to the offered set; confidence below 0.70 means all three.

`decisionRequestBytes` measures UTF-8 bytes of the plugin's full serialized
decision request, including state, all seven subset options, policy text,
timeout and example community URL. It is **not a token count** or the provider's
wire request: adapters can add their own framing. Longer agent instructions,
conversation history and larger pools increase overhead.

## Observed choices

One live decision per scenario, JEV 1.14.0, 2026-11-11. The source was based on
`fc0acf8dcb964f450eba2c98d147d22ecb1cbbec`; the capture script is alongside this
report. These profiles and prompts contain no real account data.

| Request | Ordinary selected workers | Routed workers | Confidence | Decision request bytes |
| --- | ---: | --- | ---: | ---: |
| What's the weather like today? | 3 | Assistant (1) | 1.00 | 3,017 |
| How does my calendar look tomorrow? | 3 | Assistant (1) | 1.00 | 3,022 |
| Use mcp_budget to review my campaign budget. | 3 | Budget (1) | 1.00 | 3,031 |
| Assistant checks calendar; Budget reviews budget, separately. | 3 | Assistant + Budget (2) | 0.99 | 3,102 |
| What are your thoughts on Buzz? | 3 | All (3) | 0.99 | 3,018 |
| Joint campaign drafting and review, exchanging intermediate drafts. | 3 | All (3) | 0.99 | 3,085 |

The selections would start **11 workers instead of 18**, avoiding seven initial
worker runs (38.9%), while adding **six JEV calls** with 18,275 request bytes
in total. The three routine/specialist requests alone select three workers
instead of nine. Opinion and collaboration requests preserve everyone's
participation and add routing overhead without avoiding any initial runs.
These are counts implied by live choices; the workers were not actually run.
This sample does not establish population accuracy or production savings.

## Accounting for net tokens and cost

Buzz's current Decisions result omits provider usage, so the benchmark cannot
report JEV's actual input/output tokens. Bytes must not be substituted for tokens.
The router is beneficial in tokens only when avoided worker usage exceeds the
additional routing usage and any changes to retained workers' usage.

For a full A/B benchmark, run each prompt from an identical starting snapshot
with the same models, instructions, history, tools and cache policy, once with
ordinary delivery and once with routing. Record billed input, cached input,
output and reasoning usage for **every** worker/tool-model call and JEV call,
including failures/retries and later coordination. Report:

```text
net token saving = total baseline tokens - (total routed worker tokens + total JEV tokens)
net cost saving  = baseline billed cost - (routed worker billed cost + JEV billed cost)
```

Use provider-reported totals without double-counting reasoning tokens already
included in output totals. Compare cost by model and token category rather than
pricing every token equally. Include repeated trials, latency and completion
quality: avoiding runs is useful only when the requested task still succeeds.
Until that usage is available, no net token or monetary saving is claimed.
