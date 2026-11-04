# Embedding endpoints

Recall uses `ctx.host.request` to POST the OpenAI `/v1/embeddings` shape to a server
managed outside Buzz. Use a server base URL, a `/v1` base, or the full `/v1/embeddings`
URL. HTTPS is supported; HTTP requires an IP-literal loopback address (127.0.0.0/8
or ::1). URL credentials, query strings and fragments are rejected. The native host
also rejects redirects and omits cookies. The manifest grants `["*"]`, meaning
plugin-selected HTTPS destinations and local HTTP services, not an approved-origin list.

llama.cpp-compatible; servers that require a `model` field (OpenAI, vLLM, Ollama) are not supported yet.

The response must include a nonempty `model` and one indexed vector per input.
Rows may arrive out of order. Vectors must be nonempty, finite and nonzero; Recall
normalizes them locally. The first valid response establishes dimension. A dimension
change for the same model fails the request; a returned model-name change clears the
index and the next request can establish the new dimension. A server that changes
weights without changing its model name cannot be detected; clear and save the URL
before switching such a model.

Inputs, including optional query/document prefixes, are cut to 4,000 UTF-8 bytes
between code points. This bounds retained text and request size, not token count.
Choose a server context large enough for your model/tokenizer. A batch rejected
with an HTTP error is skipped and later batches continue. Timeouts, transport
failures and malformed responses stop that snapshot, with no retry loop. A later
turn may observe the text again. Queries use at most min(1000 ms, remaining turn
budget); indexing and
Test use a 10-second deadline. Failures leave lexical recall available.

llama-server b11669 returns HTTP 500 for an input exceeding its physical batch
size (`--ubatch-size`); Recall skips that batch, including its other inputs. Set the
server physical batch size at least as large as the model context. Inputs exceeding
that context and their batch-mates can still go unindexed; the byte cap is not a token guarantee.

## Integration and RAM ownership

`createEmbeddingClient(host, settings, onReset)` owns HTTP response validation;
`createEmbeddings(host, settings)` owns the RAM index. The latter is ready whenever
the URL is nonempty. `refresh()` applies saved setting changes; `disable()` clears
RAM on plugin unload. No subprocess/download lifecycle remains.

For each admitted turn, start `observe(turn)` while leased reads are available.
It returns a callback over copied values. In the contribution's `finally`, wait
for that snapshot only until 100 ms before the turn deadline. Commit if it arrives
in time; otherwise drop it and preserve the recall answer. The callback schedules
background inference and never retains `Turn` or calls its reads.

`neighbours(turn)` embeds the original request and returns at most 40 ranked
candidates. Every message hit is fetched by id in the
consuming lease. Memory lines must match a live slug/version in that lease's
listing. Shared `mayFlow` and `ownerOnly` helpers determine disclosure. Missing,
expired or failed reads yield no vector candidates.

Index identity includes community, owner, agent, and channel or memory scope.
URL, key or prefix changes clear all banks; a returned model change does too.
The model is therefore part of the index generation, without orphaning a first
batch indexed before its model name is known. Every settings/identity change fences
late jobs. Disclosure settings are rechecked each turn; no vectors grant permissions.

The global limit is 20,000 vectors, evicting least recently used banks. Pending
snapshots are separately bounded to 20,000 units of at most 4,000 bytes each, with
only the newest pending snapshot per bank. Each lease captures at most 500 channel
messages; relay scope searches previously observed channels, not an exhaustive crawl.
Complete memory snapshots prune missing lines; partial ones prune known superseded
versions. Snapshot ordering keeps late older callbacks from replacing newer data.

Preferences and optional bearer key are saved in this device's localStorage in plaintext, so use the key for local servers.
Editing the URL clears the key draft; Save/Test commits it. Text and vectors stay in
RAM within Buzz, but are sent to the configured server, whose retention policy is
outside Recall. Clearing the URL and saving clears RAM and stops new requests;
already dispatched HTTP requests cannot be recalled.

Tests cover response validation, configuration races, deadlines, RAM limits,
audience checks, lease revalidation and mounted settings interactions. These do
not substitute for live server, desktop IPC and rendered UI acceptance.
