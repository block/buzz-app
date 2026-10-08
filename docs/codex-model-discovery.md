# Codex model and effort discovery

Codex remains unavailable for agent creation. This layer adds headless model and
effort discovery for the exact native Codex binding established by
[Codex binding readiness](codex-binding-readiness.md). It does not persist a
selection, create an identity, send a prompt, or establish successful inference.

## Request and context contract

The frontend model request carries the stable native integration ID. Only
`codex` selects this path; an editable command named `codex` or `codex-acp` is
not authority. Native code resolves the effective draft or revision-fenced saved
agent, including its workspace and permitted Codex environment, then uses one
`CodexContext` for ACP initialize, session creation, selection, and cleanup. Environment defaults owned by Goose, Databricks, or another harness are
excluded instead of entering the Codex process.

Frontend generation fencing covers replaced draft requests. Equal context values
do not prove that login or configuration file contents stayed unchanged, so
each request resolves its context again.

Discovery runs through the existing model-request host ticket, as Pi and Goose
do. The adapter runs in its own process group, which is killed when the request
finishes, is cancelled, or exceeds its 15-second deadline or 1 MiB response
limit. Existing Databricks, Goose, and Pi behavior is unchanged.

This implementation is enabled on Unix builds. Other platforms return the
existing unsupported result and keep Codex creation disabled.

## ACP projection

Discovery uses a short ACP session, following Goose discovery:

1. Initialize ACP protocol version 1 and require the
   `@agentclientprotocol/codex-acp` adapter identity. Other adapters are
   reported as incompatible; an unauthorized response asks the user to sign in
   with the selected Codex CLI.
2. Create one session in the resolved workspace with no prompt.
3. Read the `model` select option from `configOptions`.
4. If the request includes another listed model, send
   `session/set_config_option`, require the response to report that exact model,
   and only then project its effort option.
5. Close the session and kill the adapter's process group.

The response distinguishes three outcomes. A present model option with no values
is a known-empty catalog. Absent model metadata is explicit unknown metadata.
Malformed, contradictory, rejected, or stale metadata is an error. Missing
`reasoning_effort` metadata is unknown capability and is never reported as lack
of effort support.

The initial `currentValue` fields are reported as the resolved session model and
effort. After a model switch, the effort `currentValue` is only the observed
selection for that session. The adapter may retain a previously supported effort
or choose the selected model's default, so Buzz does not label that value as a
per-model default.

Model and effort options must be flat selects with unique, nonempty IDs and safe
names. Discovery accepts at most 100 configuration options, 1,000 models, and 20
effort values. IDs are limited to 512 bytes and names to 1,024 bytes; control
characters and grouped options are rejected.

## Resource bounds and protocol failures

The discovery session has one 15-second deadline across initialize, session
creation, optional selection, and close, and reads at most 1 MiB of stdout.
Stderr is discarded. Read or write errors, malformed messages, unexpected
response IDs, adapter errors, and client requests that expect a response fail
the operation. Buzz never grants a client tool request and never sends raw
adapter output or error text to the frontend.

ACP `session/new` can create CLI-owned session or cache metadata. The tested
adapter closes by unsubscribing from the thread; this layer does not claim that
the CLI session is filesystem-ephemeral. No Buzz identity, relay credential,
authorization, saved agent setting, prompt, or inference request is created.
An empty ACP MCP list also does not disable MCP servers configured by the user.

## Compatibility evidence

Source review used
[`@agentclientprotocol/codex-acp` 1.10.0](https://github.com/agentclientprotocol/codex-acp/blob/v1.10.0/src/CodexAcpClient.ts),
including its model and reasoning configuration options, external `CODEX_PATH`
launch, model-change response, and session close. Adapter 2.1.1 was inspected for
the later validation limitation; this change does not claim that untested pair is
supported.

The production native discovery seam was exercised on macOS with the isolated
adapter 1.10.0 and `/opt/homebrew/bin/codex` 0.151.0. It returned a nonempty known
catalog and an initial selection. One catalog model was selected, the exact model
round trip was confirmed, and nonempty reported effort choices were observed.
A headless refresh and pre-cancel refusal also completed through the production
seam. Controlled worker tests cover cancellation after work has started.
No model IDs, session IDs, private configuration, or catalog contents were
recorded. No prompt or authentication flow ran.

Controlled tests cover exact initialization, catalog and initial-selection
projection, one selected model's effort, known-empty and unknown catalogs,
missing effort metadata, duplicate/grouped/malformed/oversized data, rejected
selection, sign-in errors, and that cancellation kills the adapter and its
descendants. The live test is ignored by default and names explicit local tool
paths.

The controlled suite and live check were run from a macOS development checkout;
the controlled tests are also intended for Linux CI. Windows, packaged-app
discovery, and a live GUI flow were not exercised by that historical check.

Discovery is capability evidence only. Create and Save require no inference
validation; see the current [execution contract](codex-validation-execution.md).
