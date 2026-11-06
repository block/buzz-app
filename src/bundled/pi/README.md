# Pi

Create agents that run Pi on your computer, with any provider Pi supports, and answer you in Buzz. Each conversation continues its own Pi conversation.

## Getting started

1. Turn on **Pi** in **Settings** → **Plugins**. Pi needs Node.js 22.19 or later on this computer.
2. Choose **New agent** → **Create a new agent**, pick **Pi** as the **Harness**, and choose its provider and model.
3. Mention your agent in a conversation to give it work.

To give your Pi agents your own tools, hooks or providers, see
[Add your own Pi extensions to Buzz](https://github.com/block/buzz-app/blob/main/src/bundled/pi/EXTENSIONS.md).

---

# Pi for Agents

Agents run on [Pi durable](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md) in one Node
host ([`host.mjs`](host.mjs)). Each agent has its own SQLite storage, and each
Buzz thread or channel is one durable Pi conversation. Agents owns identity,
admission and signing; this plugin owns the turn after handover. The host also
loads the Pi durable parts of the Pi packages in Pi's settings
([`EXTENSIONS.md`](EXTENSIONS.md)).

```sh
bin/pnpm exec vitest run src/bundled/pi
PI_DEPS=<installed deps folder> bin/pnpm exec vitest run src/bundled/pi/host.live.test.ts
```

The live test runs the real host on Pi's faux provider.

## Packages

[`launch.mjs`](launch.mjs) installs [`deps/package-lock.json`](deps/package-lock.json)
with `npm ci` (no install scripts) into a per-lock folder under Buzz's app data
`pi/deps/`, shared by every Buzz build. To update Pi, change
[`deps/package.json`](deps/package.json), then:

```sh
cd src/bundled/pi/deps
npm install --package-lock-only --ignore-scripts --omit-lockfile-registry-resolved
```

## Gateway mode

A Pi agent whose route the configured model gateway makes eligible, and which
that gateway enables for Pi, runs only the gateway's models, through the Pi
upstream base of the build's `BUZZ_AGENT_GATEWAY` descriptor. Without that
descriptor, or without a Pi upstream in it, every route is external.
Every other provider is listed as unavailable while the route is eligible.

When the runner sends a turn without the gateway (a blocked route: readiness,
identity, auth or network failure), Pi runs it on the agent's ordinary
configured provider and model, with the runner's shared fallback notice on the
prompt. The saved choice is never rewritten. An agent whose saved provider is
the gateway's has no ordinary choice, so its turn fails visibly with the reason;
Pi never switches it to another model. A request already bound to the gateway
keeps that mode when asked again and is never resent without it. Revocation
during a gateway run stops it visibly.

Each serving endpoint uses the one protocol verified for its family, with
pi-ai 1.4.0's own client. Nothing retries a request on another protocol:

| Family (`model_class`) | Protocol | pi-ai API | Verified on |
|---|---|---|---|
| `claude` | `anthropic/v1/messages` | `anthropic-messages` | claude-haiku-4-5 |
| `gpt` | `openai/v1/responses` | `openai-responses` | gpt-5-4-nano |
| any other offering it | `mlflow/v1/chat/completions` | `openai-completions` (`supportsStore: false`, `maxTokensField: "max_tokens"`) | gpt-oss-20b, qwen3-next-80b-a3b-instruct, glm-5-3-flash |

pi-ai's Anthropic client sends Messages through the SDK's beta resource, so
its path is `anthropic/v1/messages?beta=true`.

Endpoints that offer none of these are not listed. That includes Gemini,
embeddings, endpoints that are not ready, and endpoints without function
calling. The probes listed above are synthetic, so other endpoints are
untested on their protocol. Gateway models are listed with no reasoning
levels, a 128k context window, a 16k output limit, and no cost. Images are
the endpoint's `image_input`.

Every model request carries:
- the Buzz context headers of the request its durable task serves, recorded
  before that request was submitted. Pi durable keeps the request in each
  submission's and task's trace (the host's telemetry adapter carries only
  that ID and records nothing), so a queued run, its compactions and
  retries, before or after a restart, carry their own request. An owner's
  Compact is its own request, whose context is the conversation's channel
  and thread with no message, since no signed event caused it;
- `x-session-affinity`, set to Pi's native session ID. This is the
  conversation's `ProviderDoc` session, not the Buzz session. pi-ai drops
  its own session headers when compaction disables caching, so without this
  the request would carry no session ID.

Buzz context a caller set is replaced. A request whose other session
headers name a different session is refused. A request is also refused
while its binding is no longer admitted, and when its task carries no
request, or one recorded for another conversation.

New session is recorded as an intent, with what the next turn is shown,
before its reset is written by a request ID, so a host that stops between
them writes it at the next turn and writing it again adds nothing. The
intent is cleared only with the binding that replaces the session, before
that turn is submitted.

Responses transport is verified. Black-box probes saw no effect of affinity
on upstream caching, and none is documented.

## Limits

- Pi's `read`, `write`, `edit` and `bash` run in the workspace with no sandbox
  or approvals. Buzz tools are `buzz_<name>`.
- Keys in Pi's `auth.json` must be literal: Buzz runs no `!command` key and
  reads no `$NAME` key. Set up a provider that needs more than a key with
  `pi`.
- Pi packages load only from a local folder, and only their `pi.durable`
  parts, when the host starts. See [`EXTENSIONS.md`](EXTENSIONS.md).
- Runs left unfinished when the app quit continue at the next turn. A
  mention's run posts only what the agent sends, plus a report if it fails,
  and shows no steps; its thread's session controls interrupt it. An
  unaddressed watch's or timer's run is ended, and so is a plugin wake's
  unless a run that continues shares its conversation.
- When the app quits or the host stops during a Buzz tool call, Pi tells the
  model the call may have run, so a `send` it makes again may be posted
  twice. A Stop or Interrupt ends the run instead.
- A conversation keeps the `core` memory it was first shown until Pi compacts
  it, as a Claude session keeps the memory it started with, so a memory edit
  leaves its cached prompt as it is. Only the note that it has none is
  replaced at once.
- Pi durable records compaction's usage only in each conversation's totals,
  not per compaction. Usage dates all of it at the newest compaction, so each
  compaction moves the conversation's earlier compaction spend to its day.
- On Windows, Pi's `bash` tool needs Git Bash. Linux and Windows are not yet
  validated.
