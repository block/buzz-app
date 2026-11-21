// Browse: the agents this community's members have shared, each importable
// as a new agent. The whole catalog is read so it can be searched and sorted
// here, with its stars and import counts; an over-budget page is retried
// smaller.
import {
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  checkText,
  type SharedDefinition,
  shareable,
} from "../../features/agents/agent-share";
import { useAgents } from "../../features/agents/react";
import { flushSync } from "react-dom";
import { AGENT_CATALOG_KIND } from "../../features/agents/catalog-envelope";
import { ModelIcon } from "../../features/agents/ModelPicker";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import {
  type SharedAgent,
  sharedAgents,
} from "../../features/agents/shared-agents";
import {
  excerpt,
  importCount,
  type Marketplace,
  type MarketplaceState,
  marketplaceFor,
  readAll,
  score,
  starCount,
  address,
  terms,
} from "../../features/agents/marketplace";
import type { EventData } from "../../features/relay/events";
import {
  useProfileGeneration,
  useRelayConnection,
} from "../../features/relay/react";
import { useReauthorizedRetry } from "../../features/relay/RecoveryNotice";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { MatchedLabel } from "../../features/search/MatchedLabel";
import {
  formatFullTimestamp,
  formatItemTimestamp,
} from "../../shared/datetime";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Combobox } from "../../shared/design-system/ui/Combobox";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { Select } from "../../shared/design-system/ui/Select";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import {
  DownloadIcon,
  StarFilledIcon,
  StarIcon,
} from "../../shared/design-system/icons";
import { useAvatarPreview } from "../../features/profiles/use-avatar-preview";
import {
  canonicalPublicKey,
  formatPublicKey,
} from "../../shared/identity/public-key";
import { AgentCardBackdrop, AgentPortrait } from "./AgentCard";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import { SettingsSectionLink } from "../../features/navigation/SettingsSectionLink";
import { ProfileBackdrop } from "../../features/profiles/ProfileBackdrop";
import { agentAvatars } from "../../features/agents/avatar-packs";
import hero from "../../features/profiles/ProfileHero.module.css";
import pageStyles from "./AgentsPage.module.css";
import cardStyles from "./AgentCard.module.css";
import styles from "./AgentBrowse.module.css";

const pageSize = 200;
/** At most 10,000 catalog events, as the community catalog reads. */
const maxPages = 50;
/** How long the grid waits for counts before showing agents without them. */
const COUNT_WAIT_MS = 5_000;

type Sort = "relevance" | "stars" | "imports" | "newest" | "name";
const SORTS = [
  { value: "relevance", label: "Best match" },
  { value: "stars", label: "Most starred" },
  { value: "imports", label: "Most imported" },
  { value: "newest", label: "Newest" },
  { value: "name", label: "Name" },
] as const;

type Importing = Readonly<{
  agents: Agents;
  /** The types an import can be, which run on this computer. */
  types: readonly RegisteredAgentType[];
  onImported(agent: Agent): void;
  /** Opens an agent of yours that an import would only copy. */
  onOpen?: ((agent: Agent) => void) | undefined;
  /** Opens a Settings section, such as Manage plugins. */
  openSettings?: ((section: string) => void) | undefined;
}>;

export type SharedAgentSelection = {
  agent: SharedAgent;
  session: RelaySession;
  community: string | undefined;
  /** Who is signed in, who stars and imports. */
  viewer: string | undefined;
};
type Selection = {
  selectedId?: string | undefined;
  onSelect(selection: SharedAgentSelection, trigger: HTMLButtonElement): void;
  /** The search's words as they change, so the panel can mark them too. */
  onSearch?: ((words: readonly string[]) => void) | undefined;
};

export function AgentBrowse({
  relay,
  ...selection
}: Selection & Importing & { relay: RelayData }) {
  const connection = useRelayConnection(relay);
  if (connection.status !== "ready")
    return <p>Connect to a community to browse shared agents.</p>;
  // A new session (another community) starts over.
  return (
    <SharedAgentList
      key={connection.generation}
      session={connection.session}
      community={connection.origin}
      viewer={connection.viewer}
      {...selection}
    />
  );
}

const useMarketplace = (marketplace: Marketplace) =>
  useSyncExternalStore(
    marketplace.subscribe,
    marketplace.snapshot,
    marketplace.snapshot,
  );

/** Each person's name as their profile gives it, else their short key. */
function useNames(session: RelaySession, people: readonly string[]) {
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const generation = useProfileGeneration(session.profiles);
  const key = people.join();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `people`.
  useEffect(() => {
    void generation;
    if (people.length) void session.profiles.ensure(people).catch(() => {});
  }, [session, key, generation]);
  // Stable until a profile arrives, so sorting doesn't rerun on every star.
  return useCallback(
    (pubkey: string) => {
      const profile = profiles.get(pubkey);
      return profile && !profile.nameIsFallback
        ? profile.name
        : (formatPublicKey(pubkey) ?? pubkey);
    },
    [profiles],
  );
}

function SharedAgentList({
  session,
  community,
  viewer,
  selectedId,
  onSelect,
  onSearch,
  ...importing
}: Selection &
  Importing & {
    session: RelaySession;
    community: string | undefined;
    viewer: string | undefined;
  }) {
  const marketplace = marketplaceFor(session, viewer);
  const counts = useMarketplace(marketplace);
  const [agents, setAgents] = useState<readonly SharedAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // A catalog opened while signed out loads once sign-in lands.
  const reauthorized = useReauthorizedRetry(session.recovery, () =>
    setAttempt((value) => value + 1),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry reruns this finite read.
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setLoading(true);
    setError(false);
    const failed = reauthorized.begin();
    void (async () => {
      const events: EventData[] = await readAll(
        (filters, settings) => session.read(filters, settings),
        { kinds: [AGENT_CATALOG_KIND] },
        signal,
        { limit: pageSize, maxPages },
      );
      const listed = sharedAgents(events);
      // Shown once, with its counts, so sorting by them doesn't reorder it
      // as they arrive. Counts that can't load leave browsing working, and
      // slow ones stop holding it after a few seconds: they fill in later
      // without moving the cards.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          marketplace.load(listed, signal),
          new Promise((resolve) => {
            timer = setTimeout(resolve, COUNT_WAIT_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      signal.throwIfAborted();
      setAgents(listed);
    })()
      .catch((problem) => {
        if (signal.aborted) return;
        setError(true);
        failed(problem);
      })
      .finally(() => {
        if (!signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [session, attempt]);

  const [query, setQuery] = useState("");
  const [creator, setCreator] = useState("");
  const [chosenSort, setSort] = useState<Sort>();
  const words = terms(useDeferredValue(query));
  const searching = words.length > 0;
  // Most starred first; best match while searching, unless a sort was chosen.
  // Best match is offered only while searching.
  const sort: Sort =
    chosenSort && (searching || chosenSort !== "relevance")
      ? chosenSort
      : searching
        ? "relevance"
        : "stars";
  const owners = useMemo(
    () => [...new Set(agents.map((agent) => agent.owner))],
    [agents],
  );
  const name = useNames(session, owners);
  const creators = useMemo(() => {
    const listed = new Map<string, number>();
    for (const agent of agents)
      listed.set(agent.owner, (listed.get(agent.owner) ?? 0) + 1);
    return [...listed.keys()].sort(
      (a, b) =>
        (listed.get(b) ?? 0) - (listed.get(a) ?? 0) ||
        name(a).localeCompare(name(b)),
    );
  }, [agents, name]);
  // Counts are read as they stand when the list is sorted, so a card you star
  // stays where it is until you search, filter or sort again.
  const sorting = useRef(counts);
  sorting.current = counts;
  // Names matter to order only while searching, where they're matched.
  const naming = useRef(name);
  naming.current = name;
  const wordsKey = words.join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `wordsKey` stands for `words`.
  useEffect(() => {
    onSearch?.(words);
  }, [wordsKey, onSearch]);
  useEffect(() => () => onSearch?.([]), [onSearch]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Counts are sampled, not followed; `wordsKey` stands for `words`.
  const results = useMemo(() => {
    const reactions = sorting.current;
    const name = naming.current;
    const scored = agents.flatMap((agent) => {
      if (creator && agent.owner !== creator) return [];
      const value = score(agent, words, name(agent.owner));
      return value > 0 ? [{ agent, value }] : [];
    });
    type Scored = (typeof scored)[number];
    const byName = (a: Scored, b: Scored) =>
      a.agent.name.localeCompare(b.agent.name) ||
      a.agent.id.localeCompare(b.agent.id);
    const order: Record<Sort, (a: Scored, b: Scored) => number> = {
      relevance: (a, b) => b.value - a.value || byName(a, b),
      stars: (a, b) =>
        starCount(reactions, b.agent) - starCount(reactions, a.agent) ||
        byName(a, b),
      imports: (a, b) =>
        importCount(reactions, b.agent) - importCount(reactions, a.agent) ||
        byName(a, b),
      newest: (a, b) => b.agent.createdAt - a.agent.createdAt || byName(a, b),
      name: byName,
    };
    return scored.sort(order[sort]).map((item) => item.agent);
  }, [agents, wordsKey, creator, sort, searching && name]);

  const grid = useRef<HTMLDivElement>(null);
  // A selection made elsewhere, such as View on a published agent, scrolls to
  // its card once the card is here; one chosen in the grid is in view already.
  const shown = useRef<string>(undefined);
  const present = results.some((agent) => agent.id === selectedId);
  useEffect(() => {
    if (!present || shown.current === selectedId) return;
    shown.current = selectedId;
    grid.current
      ?.querySelector<HTMLElement>("[data-selected]")
      ?.scrollIntoView({ block: "center" });
  }, [present, selectedId]);
  const unavailable = marketplace.unavailable(counts);
  return (
    <div className="flex flex-col gap-section-gap">
      {agents.length > 0 && (
        <search className={styles.toolbar}>
          <div className={styles.search}>
            <SearchField
              label="Search agents"
              placeholder="Search"
              value={query}
              onValueChange={setQuery}
            />
          </div>
          <div className={styles.creator}>
            <Combobox.Root
              items={["", ...creators]}
              value={creator}
              itemToStringLabel={(pubkey: string) =>
                pubkey ? name(pubkey) : "All creators"
              }
              filter={(pubkey: string, text: string) =>
                !text.trim() ||
                (pubkey ? name(pubkey) : "All creators")
                  .toLowerCase()
                  .includes(text.trim().toLowerCase())
              }
              autoHighlight
              onValueChange={(pubkey) => setCreator(pubkey ?? "")}
            >
              <Combobox.Trigger label="Creator">
                {creator ? name(creator) : "All creators"}
              </Combobox.Trigger>
              <Combobox.Popup
                search
                size="compact"
                side="bottom"
                collisionAvoidance={{ side: "none", align: "shift" }}
                empty="No matching creators."
              >
                <Combobox.List>
                  {(pubkey: string) => (
                    <Combobox.Item key={pubkey || "all"} value={pubkey}>
                      {pubkey ? name(pubkey) : "All creators"}
                    </Combobox.Item>
                  )}
                </Combobox.List>
              </Combobox.Popup>
            </Combobox.Root>
          </div>
          <Select
            label="Sort"
            variant="field"
            value={sort}
            groups={[
              {
                label: "",
                options: SORTS.filter(
                  (item) => searching || item.value !== "relevance",
                ),
              },
            ]}
            onValueChange={(value) => setSort(value as Sort)}
          />
        </search>
      )}
      {loading && <p role="status">Loading shared agents…</p>}
      {error && (
        <div role="alert">
          <p>Couldn’t load shared agents.</p>
          <Button onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </Button>
        </div>
      )}
      {!loading && !error && !agents.length && (
        <p>No shared agents found in this community yet.</p>
      )}
      {agents.length > 0 && (
        <div className={styles.summary}>
          <p className="m-0 text-body-sm text-secondary" role="status">
            {results.length === agents.length
              ? `${agents.length} ${agents.length === 1 ? "agent" : "agents"}`
              : `${results.length} of ${agents.length} agents`}
          </p>
          {(searching || creator) && !results.length && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setQuery("");
                setCreator("");
              }}
            >
              Clear search
            </Button>
          )}
        </div>
      )}
      <div ref={grid} className={`${cardStyles.grid} ${styles.grid}`}>
        {results.map((agent) => (
          <div
            key={agent.id}
            className={`${cardStyles.card} ${cardStyles.agentCard} ${styles.listing}`}
            data-selected={selectedId === agent.id || undefined}
          >
            <AgentCardBackdrop agent={agent} community={community} />
            <span className={cardStyles.portrait} aria-hidden="true">
              <AgentPortrait agent={agent} community={community} />
            </span>
            <span className={cardStyles.identity}>
              <span className={`${cardStyles.name} text-label`}>
                <Matched text={agent.name} words={words} />
              </span>
              <span className={cardStyles.detail}>
                <span className={cardStyles.detailText}>
                  by <Matched text={name(agent.owner)} words={words} />
                </span>
              </span>
            </span>
            {agent.instructions && (
              <span className={`${styles.excerpt} text-body-sm`}>
                <Matched
                  text={excerpt(agent.instructions, words)}
                  words={words}
                />
              </span>
            )}
            <span className={styles.counts}>
              <ImportShared
                shared={agent}
                marketplace={marketplace}
                variant="glass-ghost"
                label={`Import ${agent.name}${
                  counts.status === "ready"
                    ? `, ${importCount(counts, agent)} ${importCount(counts, agent) === 1 ? "import" : "imports"}`
                    : ""
                }`}
                title="Import a copy"
                {...importing}
              >
                <span className={styles.count}>
                  <DownloadIcon size={16} aria-hidden="true" />
                  {counts.status === "ready" && importCount(counts, agent)}
                </span>
              </ImportShared>
              <StarToggle
                agent={agent}
                marketplace={marketplace}
                counts={counts}
                viewer={viewer}
                unavailable={unavailable}
              />
              <span className={styles.more}>
                <Button
                  size="sm"
                  variant="glass"
                  aria-label={`More about ${agent.name}`}
                  aria-current={selectedId === agent.id || undefined}
                  onClick={(event) => {
                    shown.current = agent.id;
                    onSelect(
                      { agent, session, community, viewer },
                      event.currentTarget,
                    );
                  }}
                >
                  More
                </Button>
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** `text` with every occurrence of each search word marked. MatchedLabel
 * counts code points, so matching does too: an emoji before a match must not
 * shift the mark. */
function Matched({ text, words }: { text: string; words: readonly string[] }) {
  const chars = [...text].map((char) => char.toLowerCase());
  const positions: number[] = [];
  for (const word of words) {
    const want = [...word];
    for (let at = 0; at + want.length <= chars.length; at++)
      if (want.every((char, k) => chars[at + k] === char))
        for (let k = 0; k < want.length; k++) positions.push(at + k);
  }
  return <MatchedLabel label={text} positions={positions} />;
}

/** Stars an agent the way you would star a repository: once per person. */
function StarToggle({
  agent,
  marketplace,
  counts,
  viewer,
  unavailable,
}: {
  agent: SharedAgent;
  marketplace: Marketplace;
  counts: MarketplaceState;
  viewer: string | undefined;
  unavailable: string | undefined;
}) {
  const key = address(agent);
  const people = counts.stars.get(key);
  const count = people?.size ?? 0;
  const starred = !!viewer && !!people?.get(viewer)?.length;
  const failure = counts.failures.get(key);
  // Without the count there is no telling whether you starred it.
  if (counts.status === "error") return null;
  const ready = counts.status === "ready";
  return (
    <>
      {failure && (
        <span role="alert" className="text-body-sm text-danger">
          {failure}
        </span>
      )}
      <Button
        size="sm"
        variant={starred ? "glass" : "glass-ghost"}
        aria-pressed={starred}
        aria-label={`${starred ? "Unstar" : "Star"} ${agent.name}${ready ? `, ${count} ${count === 1 ? "star" : "stars"}` : ""}`}
        title={unavailable ?? (starred ? "Unstar" : "Star")}
        disabled={!!unavailable || counts.pending.has(key)}
        onClick={() => void marketplace.toggleStar(agent)}
      >
        <span className={styles.count}>
          {starred ? (
            // The Bestie badge's gold, in either theme.
            <span
              className={styles.gold}
              data-accent="bee"
              data-color-mode="light"
            >
              <StarFilledIcon size={16} aria-hidden="true" />
            </span>
          ) : (
            <StarIcon size={16} aria-hidden="true" />
          )}
          {ready && count}
        </span>
      </Button>
    </>
  );
}

export function SharedAgentPanel({
  selection,
  onImported,
  words = [],
  ...importing
}: Importing & {
  selection: SharedAgentSelection;
  /** The Marketplace search's words, marked here as on the card. */
  words?: readonly string[] | undefined;
}) {
  const { agent, session, community, viewer } = selection;
  const marketplace = marketplaceFor(session, viewer);
  const counts = useMarketplace(marketplace);
  const pack = agentAvatars.find((item) => item.url === agent.picture);
  const picture = useAvatarPreview(
    pack ? "" : (agent.picture ?? ""),
    community,
    "small",
  );
  const backdrop = pack?.preview ?? picture;
  return (
    <div className={`${pageStyles.detailsScroll} ${styles.marked}`}>
      <section
        className={`${hero.hero} ${hero.panelHero}`}
        aria-label={`${agent.name} identity`}
      >
        <ProfileBackdrop src={backdrop} />
        <span className={pageStyles.identityPortrait}>
          <AgentPortrait agent={agent} community={community} />
        </span>
        <h2 className="m-0 text-heading text-center break-words">
          <Matched text={agent.name} words={words} />
        </h2>
        <div className={hero.actions}>
          <ImportShared
            key={agent.id}
            shared={agent}
            marketplace={marketplace}
            variant={backdrop ? "glass" : "subtle"}
            shape="control"
            onImported={onImported}
            {...importing}
          >
            Import
          </ImportShared>
          <StarToggle
            agent={agent}
            marketplace={marketplace}
            counts={counts}
            viewer={viewer}
            unavailable={marketplace.unavailable(counts)}
          />
        </div>
      </section>
      <section>
        <InlineHeader title="About" />
        <SettingsGroup>
          <PreferenceRow
            title="Shared by"
            trailing={
              <Sharer
                pubkey={agent.owner}
                session={session}
                community={community}
                words={words}
              />
            }
          />
          <PreferenceRow
            title="Model"
            trailing={
              <span className={styles.fact}>
                <ModelIcon model={agent.model} />
                {agent.model ? (
                  <Matched text={agent.model} words={words} />
                ) : (
                  "Not given"
                )}
              </span>
            }
          />
          {agent.runtime && (
            <PreferenceRow
              title="Harness"
              trailing={
                <span className={styles.fact}>
                  <Matched text={agent.runtime} words={words} />
                </span>
              }
            />
          )}
          {agent.provider && (
            <PreferenceRow
              title="Provider"
              trailing={
                <span className={styles.fact}>
                  <Matched text={agent.provider} words={words} />
                </span>
              }
            />
          )}
          <PreferenceRow
            title="Updated"
            trailing={
              <Tooltip content={formatFullTimestamp(agent.createdAt)}>
                <span
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need access to the full date in the tooltip.
                  tabIndex={0}
                  className={styles.fact}
                >
                  {formatItemTimestamp(agent.createdAt)}
                </span>
              </Tooltip>
            }
          />
          {counts.status === "ready" && (
            <PreferenceRow
              title="Imports"
              trailing={
                <span className={styles.fact}>
                  {importCount(counts, agent)}
                </span>
              }
            />
          )}
        </SettingsGroup>
      </section>
      <div className={styles.details}>
        <InlineHeader title="Instructions" />
        <section className={styles.instructions} aria-label="Instructions">
          {agent.instructions ? (
            <Matched text={agent.instructions} words={words} />
          ) : (
            "No instructions included."
          )}
        </section>
      </div>
    </div>
  );
}

/** Who shared it, by their profile; the key itself is a hover away. */
function Sharer({
  pubkey,
  session,
  community,
  words,
}: {
  pubkey: string;
  session: RelaySession;
  community: string | undefined;
  words: readonly string[];
}) {
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const profileGeneration = useProfileGeneration(session.profiles);
  useEffect(() => {
    void profileGeneration;
    void session.profiles.ensure([pubkey]).catch(() => {});
  }, [session, pubkey, profileGeneration]);
  const profile = profiles.get(pubkey);
  const picture = useAvatarPreview(profile?.picture ?? "", community, "small");
  const npub = canonicalPublicKey(pubkey) ?? pubkey;
  const name =
    profile && !profile.nameIsFallback
      ? profile.name
      : (formatPublicKey(pubkey) ?? pubkey);
  return (
    <Tooltip content={npub}>
      <span
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need access to the key in the tooltip.
        tabIndex={0}
        className={styles.fact}
      >
        <Avatar src={picture} alt="" fallback={name} size="small" />
        <span className="truncate">
          <Matched text={name} words={words} />
        </span>
      </span>
    </Tooltip>
  );
}

/** The panel keeps one action; configuration belongs to the import dialog. */
/** Import's trigger and dialog; an import made here is counted. */
function ImportShared({
  shared,
  marketplace,
  agents,
  types,
  onImported,
  onOpen,
  openSettings,
  children,
  variant,
  shape = "capsule",
  label,
  title,
}: Importing & {
  shared: SharedAgent;
  marketplace: Marketplace;
  variant: "glass" | "glass-ghost" | "subtle";
  shape?: "capsule" | "control";
  children: ReactNode;
  /** The trigger's name, when its content doesn't say Import. */
  label?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const counts = useMarketplace(marketplace);
  const counted = marketplace.recordable(shared, counts);
  const props = { shared, agents, types, onOpen, openSettings };
  return (
    <>
      <Button
        ref={trigger}
        variant={variant}
        shape={shape}
        size="sm"
        {...(label ? { "aria-label": label } : {})}
        {...(title ? { title } : {})}
        onClick={() => setOpen(true)}
      >
        {children}
      </Button>
      {open && (
        <SharedImportDialog
          {...props}
          onImported={(agent) => {
            // Only as the notice said when Import was pressed: counts that
            // arrive while importing don't make it public after the fact.
            if (counted) void marketplace.recordImport(shared);
            onImported(agent);
          }}
          counted={counted}
          onClose={() => setOpen(false)}
          finalFocus={trigger}
        />
      )}
    </>
  );
}

/** Imports a shared definition as a new agent, from the marketplace or a file. */
/** A shared agent's card face, in the Marketplace and in conversations. */
export function SharedAgentCardContent({
  agent,
  community,
  action,
}: {
  agent: Pick<SharedDefinition, "name" | "picture" | "model">;
  community: string | undefined;
  /** Conversation cards offer an action in place of model metadata. */
  action?: ReactNode;
}) {
  return (
    <>
      <AgentCardBackdrop agent={agent} community={community} />
      <span className={cardStyles.portrait} aria-hidden="true">
        <AgentPortrait agent={agent} community={community} />
      </span>
      <span className={cardStyles.identity}>
        <span className={`${cardStyles.name} text-label`}>{agent.name}</span>
        {action ?? (
          <span className={cardStyles.detail}>
            <ModelIcon model={agent.model} />
            <span className={cardStyles.detailText}>
              {agent.model || "Shared agent"}
            </span>
          </span>
        )}
      </span>
    </>
  );
}

/** Whether importing `shared` would only copy `agent` again. */
function copies(
  shared: SharedDefinition,
  agent: Agent,
  type: RegisteredAgentType | undefined,
) {
  try {
    const own = shareable(agent, type);
    // Pictures are left out: a built-in avatar's address can differ.
    return (
      own.name === shared.name &&
      own.instructions === shared.instructions &&
      own.runtime === shared.runtime &&
      own.model === shared.model &&
      (own.provider ?? "") === (shared.provider ?? "")
    );
  } catch {
    return false;
  }
}

/** Why Import has no type to import as: agents run only in the desktop app,
 * they could not load, their types are still registering, or no harness that
 * runs agents on this computer is available. Only the last has a remedy in
 * Settings, and it has more than one cause: every agent plugin is off, only a
 * hosted type (one its provider runs, so it cannot take an imported key) is
 * on, or a plugin that is on failed to activate. The snapshot being ready
 * says the inventory loaded, not that a plugin activated, so this names what
 * is missing rather than why. */
export function NoImportTypes({
  agents,
  openSettings,
}: Pick<Importing, "agents" | "openSettings">) {
  const { snapshot } = useAgents(agents);
  if (snapshot.status === "loading")
    return (
      <LoadingRegion pending label="Loading agent types…">
        {null}
      </LoadingRegion>
    );
  return (
    <p className="m-0 text-body-sm text-secondary">
      {snapshot.status === "unavailable" ? (
        // As the Agents page's own empty state words it.
        "Agents runs in the desktop app. Open Buzz there to import one."
      ) : snapshot.status === "error" ? (
        `Agents could not load. ${snapshot.error ?? "Try again."}`
      ) : (
        <>
          No harness that runs agents on this computer is available. Check{" "}
          <SettingsSectionLink section="plugins" open={openSettings}>
            Manage plugins
          </SettingsSectionLink>
          .
        </>
      )}
    </p>
  );
}

export function SharedImportDialog({
  shared,
  agents,
  types,
  onImported,
  onOpen,
  openSettings,
  onClose,
  finalFocus,
  counted = false,
}: Importing & {
  shared: SharedDefinition;
  onClose(): void;
  finalFocus: React.RefObject<HTMLButtonElement | null>;
  /** From the Marketplace, where each import is a public record. */
  counted?: boolean;
}) {
  const { snapshot, types: known } = useAgents(agents);
  const body = useRef<HTMLDivElement>(null);
  const [initial] = useState(() => {
    for (const type of types) {
      const config = type.importShared?.(shared);
      if (config !== undefined) return { key: type.key, config };
    }
    return undefined;
  });
  const [type, setType] = useState(initial?.key ?? "");
  const [config, setConfig] = useState<unknown>(initial?.config);
  const [instructions, setInstructions] = useState(shared.instructions);
  const [pending, setPending] = useState(false);
  // Anything changed from what was shared; Undo brings it back.
  const edited =
    type !== (initial?.key ?? "") ||
    JSON.stringify(config) !== JSON.stringify(initial?.config) ||
    instructions !== shared.instructions;
  const undo = () => {
    // Undo goes with the edit; focus starts over at the first field.
    flushSync(() => {
      setType(initial?.key ?? "");
      setConfig(initial?.config);
      setInstructions(shared.instructions);
      setError("");
    });
    body.current?.querySelector<HTMLElement>("[role='combobox']")?.focus();
  };
  // An agent you already have, the same in everything this would copy.
  const existing = edited
    ? undefined
    : snapshot.agents.find((agent) =>
        copies(
          shared,
          agent,
          known.find((type) => type.key === agent.type),
        ),
      );
  const [error, setError] = useState("");
  // What block/buzz refuses, such as hidden characters in what is shown here.
  let refused = "";
  try {
    checkText(shared.name, instructions);
  } catch (reason) {
    refused = reason instanceof Error ? reason.message : String(reason);
  }
  const chosen = types.find((item) => item.key === type);
  const Model = chosen?.CreateModel;
  const choose = (key: string) => {
    const next = types.find((item) => item.key === key);
    setType(key);
    setConfig(next?.importShared?.(shared) ?? next?.defaults().config);
  };
  const run = async () => {
    if (!chosen || pending || refused) return;
    setPending(true);
    setError("");
    try {
      const { agent } = await agents.port({
        source: "shared",
        type: chosen.key,
        name: shared.name,
        ...(shared.picture ? { picture: shared.picture } : {}),
        instructions,
        ...(config !== undefined ? { config } : {}),
      });
      onImported(agent);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      title={shared.name}
      description={
        existing
          ? "You already have this agent."
          : edited
            ? "Edited. Changes only affect your copy."
            : "Import it as is, or edit anything below first. Changes only affect your copy."
      }
      footerGap="compact"
      finalFocus={finalFocus}
      preventClose={pending}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      leadingActions={
        edited && (
          <Button variant="ghost" disabled={pending} onClick={undo}>
            Undo changes
          </Button>
        )
      }
      actions={
        <>
          {!(existing && onOpen) && (
            <Button disabled={pending} onClick={onClose}>
              Cancel
            </Button>
          )}
          <Button
            {...(existing && onOpen ? {} : { variant: "primary" as const })}
            disabled={!chosen || pending || !!refused}
            loading={pending}
            onClick={() => void run()}
          >
            {existing ? "Import a copy" : "Import"}
          </Button>
          {existing && onOpen && (
            <Button
              variant="primary"
              disabled={pending}
              onClick={() => onOpen(existing)}
            >
              Open {existing.name}
            </Button>
          )}
        </>
      }
    >
      {/* Laid out as the agent's Identity tab will show it once imported. */}
      <div ref={body} className="grid gap-4">
        {types.length === 0 ? (
          <NoImportTypes
            agents={agents}
            // Settings opens in place of the dialog, not over it, so while
            // an import keeps the dialog open the link is plain text.
            openSettings={
              openSettings && !pending
                ? (section) => {
                    onClose();
                    openSettings(section);
                  }
                : undefined
            }
          />
        ) : (
          <SettingsGroup>
            <PreferenceRow
              title="Harness"
              trailing={
                <Select
                  label="Harness"
                  variant="compact"
                  align="end"
                  placeholder="Choose"
                  value={type}
                  disabled={pending}
                  groups={[
                    {
                      label: "",
                      options: types.map((item) => ({
                        value: item.key,
                        label: item.title,
                      })),
                    },
                  ]}
                  onValueChange={choose}
                />
              }
            />
            {Model && (
              <PreferenceRow
                title="Model"
                trailing={
                  <Model
                    key={type}
                    config={config}
                    disabled={pending}
                    onChange={setConfig}
                  />
                }
              />
            )}
          </SettingsGroup>
        )}
        <AgentInstructions
          value={instructions}
          disabled={pending}
          onChange={setInstructions}
        />
        {counted && (
          <p className="m-0 text-body-sm text-secondary">
            Imports from the Marketplace are counted publicly: anyone in this
            community can see who imported this agent, and the record can’t be
            undone.
          </p>
        )}
        {(refused || error) && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {refused || error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
