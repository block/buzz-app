# Finder

You often remember a piece of a conversation, a name, or a word someone used,
but not which channel or thread it was in. The finder lets you search for those
pieces directly. Press ⌘P (Ctrl+P on Windows and Linux), type a few letters, and
see matching messages from your own conversations as you type, with a preview
of each one in context. Press Enter to jump to the message.

It works like [fzf](https://github.com/junegunn/fzf) or Neovim's
[Telescope](https://github.com/nvim-telescope/telescope.nvim): letters don't
have to be next to each other, so `dplyrlbk` finds "deploy rollback".

## Status

This is a work in progress on the `noah/finder` branch.

| Part | State |
| --- | --- |
| Matching and ranking (`match.ts`, `corpus.ts`) | Done, with tests and a benchmark |
| The dialog (`FinderDialog.tsx`) | Done, tried on a fixture page with fake data |
| ⌘P in the app (`index.tsx`) | Done; the plugin is off until you enable it |
| Filling the index from your account (`sync.ts`) | Done, without tests yet |
| Saving the index between launches | Not started: it is rebuilt each launch |
| Clear cache empties the index at once | Not yet: it empties on the next reconnect or restart |
| Edited messages | Not yet: the finder shows the original text |
| Relay search when you pause typing | Not started; next |
| A tool other programs (Neovim) can call | Not started |

## Where this is going

The finder will search in two waves:

1. **On this device, as you type.** Fuzzy matching over the local index, in a
   few milliseconds. This is what exists today.
2. **On the relay, when you pause.** About 300 ms after you stop typing, it
   also runs the relay's message search, the one ⌘K uses. That search covers
   every channel you can read, all the way back, but it only matches whole
   words by their start and needs three letters. Its results appear in a
   second section below the local ones. They never move the local rows, and
   each one is added to the local index, so the next search finds it
   instantly.

The two waves split the work: local search handles scattered letters and
speed, and the relay reaches messages the device has never seen. Because the
relay covers the rest on demand, the finder doesn't need to download every
channel's history up front. That keeps the load on the relay low across the
fleet: one relay search per pause, only while the finder is open, and none
when the local results already contain every word typed.

After that, the index will be saved on the device, so a restart doesn't
start it over.

## How to search

- Words are separate searches that must all match: `maya canary` finds messages
  with both. A word can match the message, the person who wrote it, or the
  channel it was in.
- `'word` matches those exact letters together.
- `!word` leaves out messages containing `word`.
- A capital letter makes that word match case: `API` won't match "api".
- With nothing typed, the finder lists your newest messages.

Results are scored the way fzf scores them: letters at the start of a word,
and letters next to each other, score higher. Ties go to the newer message.

Matching differs from fzf in two ways, because chat messages are long
sentences, not file names:

- **Words you type whole are found whole.** If a word appears exactly as
  typed, that occurrence is scored, choosing the best one (a word start beats
  the middle of a word).
- **Letters must stay close together.** Otherwise one word's letters have to
  fit within about three times its length and cross at most one space.
  `dplyrlbk` still finds "deploy rollback", but `any` can't be stitched
  together from "**a**nd", a later "**n**", and "**y**ou". Type two words
  (`dpl rlbk`) to match letters further apart.

## What it searches

Two sources, both limited to the last 90 days:

- **Your own conversations**, read from the relay when the finder starts:
  messages you wrote, threads you replied in, direct messages, and messages
  that mention you.
- **Everything else Buzz receives from channels you're in** while it's open:
  new messages as they arrive, and older ones as you scroll past them. These
  cost no extra relay reads; the app already fetched them.

Channels you haven't joined, which you can preview, stay out.

The index lives in memory and, once that part is built, in a database on this
device. It is never sent anywhere. Signing out or using **Clear cache** deletes
it. When you lose access to a channel, its messages leave the index.

## How it stays current

The first time it runs, the finder reads your history from the relay in pages
of 500, newest first, with pauses between pages, until it reaches 90 days back.
That happens once per device. After that it only adds new messages: the ones
the app already receives while it's open, plus a short catch-up from where it
left off after a reconnect. It does not poll.

Because every device does this once, the plugin starts **off** for now. That
lets us measure the first fill on real accounts before it reaches everyone.

## How fast it is

Each search scans every indexed message. Three things keep that fast:

1. **A letter check first.** Each message stores which letters it contains as
   a 32-bit number. A message missing any letter you typed is skipped without
   reading its text.
2. **Newest first, and stop scoring early.** Messages are kept oldest to newest
   and scanned from the end. Once the top 50 results all have the best possible
   score, no older message can beat them, so the rest only get a quick yes/no
   check (for the match count).
3. **Typing more searches less.** When the new query is the old one plus more
   letters, only the messages that matched before are checked again.

Timings for one keystroke, typed one letter at a time, on synthetic history
(`bin/node src/bundled/finder/bench.ts <messages>`). The synthetic history uses
a small vocabulary, so far more messages match each word than in real
conversations. Treat these as worst cases.

| Messages | Memory | Typical key | Slowest query, cold |
| --- | --- | --- | --- |
| 25,000 | 10 MB | 1–3 ms | 9 ms |
| 50,000 | 20 MB | 1–7 ms | 16 ms |
| 200,000 | 81 MB | 4–55 ms | 81 ms |

Measured on an Apple laptop and a Linux workstation, with similar results.
A screen frame is 16 ms, so up to about 50,000 messages it keeps up with typing.
Next steps for larger histories are searching in a background worker (so typing
never waits) and splitting the search across several workers.

## Code

| File | What it does |
| --- | --- |
| `src/bundled/finder/match.ts` | fzf's matching and scoring, ported to TypeScript |
| `src/bundled/finder/corpus.ts` | The in-memory index and search. No UI, so other tools can use it |
| `src/bundled/finder/FinderDialog.tsx` | The dialog, built from the same parts as ⌘K search |
| `src/bundled/finder/bench.ts` | The benchmark |
| `tests/fixtures/finder.html` | The dialog on fake data, for trying it without an account |

The matcher is ported from fzf, which is MIT licensed. Its license is in
[NOTICE.md](../NOTICE.md).

## Trying it

Run the fixture page from the repository root:

```sh
bin/pnpm exec vite --config tests/fixtures/agent-control.vite.mjs --port 1461
```

Open `http://127.0.0.1:1461/tests/fixtures/finder.html`. Add `?extra=200000`
to search 200,000 more synthetic messages, and `&theme=dark` for dark mode.
