# Recall

When one of your agents starts a turn, Recall finds the few past messages and memories that would help it
answer and quotes them into that turn. It never runs on steers, never writes to the relay, and keeps no
relay copies on disk. Optional embeddings retain vectors in RAM; preferences and an optional server key stay on this device.

## Getting started

Recall is bundled with Buzz and **off by default**. Enable it in
**Settings → Plugins → Manage plugins**, then configure **Settings → Plugins → Recall**.
Set up a Decisions provider in **Settings → Decisions API** to select useful excerpts.
Optional semantic recall uses an embedding server you install and manage separately.
Enter its base URL (for example `http://127.0.0.1:8080`) in **Embedding server URL**,
optionally add a bearer key, and press **Test** to save and check model dimensions and round-trip time.
Clear the URL and **Save** to return to lexical recall. Recall never installs or starts a model.

For an already downloaded EmbeddingGemma 2 GGUF and installed llama.cpp:

```sh
llama-server --model /path/to/embeddinggemma-2-Q8_0.gguf --embedding --pooling mean --host 127.0.0.1 --port 8080 --ctx-size 4096 --batch-size 4096 --ubatch-size 4096 --flash-attn off --cache-type-k f32 --cache-type-v f32
```

Ask your agent to set Gemma's **Query prefix** to `task: search result | query: ` and
**Document prefix** to `title: none | text: `, including trailing spaces. Both default to empty
for other models. See [Embeddings](EMBEDDINGS.md) for input limits and index behavior.

---

## How recall works

```
mention ─► turn start ─► find ──────► choose ─────────► pack ─────► <turn-context key="buzz.recall/recall">
                         relay FTS     your Decisions     ≤ 2,400 B,
                         + memories    provider: yes/no   escaped,
                         as the agent  per excerpt        attributed
```

- **find** searches the relay's full text index *as the agent*, in the current channel (or, if you turn it
  on, every channel the agent can read), and scores the agent's memory lines locally. Each hit has to pass
  an audience check: it is shown only where everyone who can read the current chat could already read the
  original. Memories show up only in chats with just you and the agent, unless you allow more.
- **choose** asks your Decisions provider one yes/no question per excerpt and keeps those with p ≥ 0.5. If
  the provider fails or runs out of time, choose keeps nothing. It never falls back to unselected text.
- **pack** quotes the survivors, best first, as escaped one-line excerpts with their date, author and
  link. They sit under a preamble that tells the agent these are other people's words, not instructions.

Any failure means the turn goes ahead exactly as it would have without Recall.

## Settings

**Settings → Plugins → Recall**, saved on this device:

| Switch | Off (default) | On |
|---|---|---|
| Search the whole relay | Only the channel the agent is answering in | Every channel the agent can read, still audience-checked |
| Recall memories in channels other people can read | Memories only in chats with just you and the agent | Memories wherever the agent answers |

The embedding URL, key and optional prefixes use explicit Save; Test saves before sending a test input.
Remote servers receive conversation text and eligible memory. Keys are stored in device localStorage,
masked in the form, and cleared when you edit the URL. The install review grants any HTTPS server
and local HTTP services; it is not an owner-approved-origin sandbox.

## Develop

```sh
bin/pnpm exec tsc --noEmit
bin/pnpm exec vitest run src/bundled/recall
src/bundled/recall/mutate.sh              # removes each safety guard in turn; every mutant must be killed
```

The mutation runner works on isolated copies and keeps per-mutant logs under
`$TMPDIR/recall-mutations` (or `RECALL_MUTATION_ARTIFACTS`). `mutate.sh --check` verifies the
substitutions without running tests; it does not prove mutants are killed.

`invariants.test.ts` holds one block per threat-model invariant. Each block runs end to end through
`recall` and comes with a control that does recall something, so a pipeline that recalls nothing can't pass.

| File | One job |
|---|---|
| `index.ts` | Registers the turn contributor and the Settings card; asks the provider only when it can answer |
| `recall.ts` | find → choose → pack; any failure returns nothing |
| `find.ts` | Candidates the audience may see: FTS, memory BM25, RRF merge |
| `choose.ts` | One bounded Decisions call; keeps what it says helps |
| `pack.ts` | Escaped, attributed excerpts within 2,400 bytes |
| `settings.ts`, `card.tsx` | Recall preferences and where they are saved |
| `types.ts` | App-owned host types and recall pipeline shapes |
