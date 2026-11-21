// The finder on fake history, with no relay, identity or broker.
// ?extra=200000 adds unsigned synthetic messages to search (their previews
// show nearby signed messages); ?theme=dark switches theme.
import "../../src/shared/styles/globals.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ReadFilter, RelayEvent } from "../../src/features/relay/events";
import { createRelaySession } from "../../src/features/relay/session";
import {
  keypair,
  metadata,
  profile,
  roster,
  signed,
} from "../../src/features/relay/testing";
import {
  createCorpus,
  type FinderDoc,
} from "../../src/bundled/finder/corpus.ts";
import { FinderDialog } from "../../src/bundled/finder/FinderDialog";
import { syntheticDocs } from "../../src/bundled/finder/synthetic.ts";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.colorMode = params.get("theme") ?? "light";

const viewer = keypair();
const relay = keypair();
const people = Array.from({ length: 20 }, () => keypair());
const channels = [
  "eng-infra",
  "release",
  "design-studio",
  "oncall",
  "payments",
  "relay-perf",
  "desktop",
  "growth",
  "help-search",
  "neovim-club",
  "team-mobile",
  "proj-finder",
].map((name, n) => ({ id: `c${n}`, name }));

const started = performance.now();
const sample = syntheticDocs(1500, 7);
const nameOf = new Map<string, string>();
const messages: RelayEvent[] = sample.map((doc, n) => {
  const author =
    n % 9 === 0 ? viewer : (people[n % people.length] as typeof viewer);
  nameOf.set(
    author.pubkey,
    author === viewer ? "Alex Morgan (you)" : doc.author,
  );
  const channel = channels[n % channels.length] as (typeof channels)[number];
  return signed(author, {
    kind: 9,
    content: doc.text,
    created_at: doc.createdAt,
    tags: [["h", channel.id]],
  });
});
const events: RelayEvent[] = [
  ...messages,
  ...[viewer, ...people].map((key) =>
    profile(key, { name: nameOf.get(key.pubkey) ?? "Someone" }),
  ),
  ...channels.flatMap((channel) => [
    metadata(relay, channel.id, channel.name),
    roster(relay, channel.id, [viewer.pubkey, ...people.map((p) => p.pubkey)]),
  ]),
];
console.log(
  `signed ${events.length} events in ${(performance.now() - started).toFixed(0)} ms`,
);

const matches = (event: RelayEvent, filter: ReadFilter) => {
  const tagged = (name: string, values: readonly string[] | undefined) =>
    !values ||
    event.tags.some(
      ([key, value]) => key === name && values.includes(value ?? ""),
    );
  return (
    (!filter.ids || filter.ids.includes(event.id)) &&
    (!filter.kinds || filter.kinds.includes(event.kind)) &&
    (!filter.authors || filter.authors.includes(event.pubkey)) &&
    (filter.since === undefined || event.created_at >= filter.since) &&
    (filter.until === undefined || event.created_at <= filter.until) &&
    tagged("h", filter["#h"]) &&
    tagged("d", filter["#d"]) &&
    tagged("p", filter["#p"]) &&
    tagged("e", filter["#e"])
  );
};
const owner = createRelaySession({
  viewer: viewer.pubkey,
  relayAuthor: relay.pubkey,
  async query(filters) {
    return filters.flatMap((filter) =>
      events
        .filter((event) => matches(event, filter))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, filter.limit),
    );
  },
});
const session = owner.session;
void session.channels.ensureList?.();

const corpus = createCorpus();
const channelName = new Map(channels.map((c) => [c.id, `#${c.name}`]));
corpus.add(
  messages.map((event) => ({
    id: event.id,
    channelId: event.tags[0]?.[1] ?? "",
    authorId: event.pubkey,
    createdAt: event.created_at,
    author: nameOf.get(event.pubkey) ?? "Someone",
    place: channelName.get(event.tags[0]?.[1] ?? "") ?? "Conversation",
    text: event.content,
  })),
);
const extra = Number(params.get("extra") ?? 0);
if (extra) {
  const at = performance.now();
  corpus.add(
    syntheticDocs(extra, 3).map((doc, n): FinderDoc => {
      const channel = channels[
        n % channels.length
      ] as (typeof channels)[number];
      return {
        ...doc,
        id: `x${n}`,
        channelId: channel.id,
        place: `#${channel.name}`,
      };
    }),
  );
  console.log(
    `indexed ${extra} extra messages in ${(performance.now() - at).toFixed(0)} ms`,
  );
}

function App() {
  const [open, setOpen] = useState(true);
  const [opened, setOpened] = useState<FinderDoc>();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "p" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <main style={{ padding: "var(--space-panel-inset)", minHeight: "100vh" }}>
      <h1>Finder fixture</h1>
      <p>
        {corpus.size.toLocaleString()} messages indexed. Press ⌘P (Ctrl+P) to
        open the finder.
      </p>
      {opened && (
        <p>
          Would open <strong>{opened.place}</strong> at “
          {opened.text.slice(0, 80)}”.
        </p>
      )}
      <FinderDialog
        open={open}
        onOpenChange={setOpen}
        corpus={corpus}
        revision={0}
        session={session}
        openMessage={setOpened}
      />
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
