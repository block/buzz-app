import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { Header } from "../../shared/design-system/ui/Header";
// The app's read-only view of an agent's memory. Every agent type keeps its
// memory the same way, encrypted to the owner, so the app shows it once: `core`
// (what each run is given) first, then the slugs the agent reads on demand.
import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useId, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatFullTimestamp } from "../../shared/datetime";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuItem,
  MenuPopup,
} from "../../shared/design-system/ui/Menu";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import {
  ArrowsClockwiseIcon,
  BrainIcon,
  ThinkingHighIcon,
  CaretRightIcon,
  CircleNotchIcon,
} from "../../shared/design-system/icons/index";
import { MAX_MARKDOWN_LENGTH, scanMarkdown } from "../relay/message-content";
import type { RelaySession } from "../relay/session";
import type { MemoryEntry, MemorySnapshot } from "./memory";
import type { Agent } from "./service";
import styles from "./MemoryPanel.module.css";

export type AgentMemories = RelaySession["agentMemories"];
type View = ReturnType<AgentMemories["open"]>;

const MESSAGES: Record<MemorySnapshot["status"], string> = {
  idle: "Memory isn't loaded.",
  loading: "Loading memory…",
  blocked: "Memory can be read once Buzz is connected.",
  error: "Memory couldn't be read.",
  denied: "This community doesn't let you read this agent's memory.",
  unavailable: "Memory isn't available here.",
  ready: "Memory isn't available here.",
};

const REMARK = [remarkGfm];
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const MONTH_SECONDS = 30 * 24 * 60 * 60;
const TWO_MONTHS_SECONDS = 2 * MONTH_SECONDS;
const MARKDOWN: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      children
    ),
  // Memories are private context; don't fetch remote images when they open.
  img: ({ alt }) => alt ?? null,
};

/** Keeps the view for exactly as long as its plaintext is rendered, so session
 * invalidation can revoke the React copy as well as the service snapshot. */
function useMemory(memories: AgentMemories | undefined, pubkey: string) {
  const [attempt, setAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [snapshot, setSnapshot] = useState<MemorySnapshot>({
    status: memories ? "loading" : "unavailable",
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt asks for a fresh read.
  useEffect(() => {
    let view: View;
    try {
      if (!memories) throw new Error("No session");
      view = memories.open(pubkey);
    } catch {
      setRefreshing(false);
      setSnapshot({ status: "unavailable" });
      return;
    }
    let live = true;
    const update = () => {
      if (!live) return;
      const next = view.snapshot();
      // Keep a successful listing mounted while a manual refresh is in flight;
      // every other transition, especially invalidation, replaces plaintext.
      setSnapshot((current) =>
        next.status === "loading" && current.status === "ready"
          ? current
          : next,
      );
      if (next.status !== "loading") setRefreshing(false);
    };
    const unsubscribe = view.subscribe(update);
    setRefreshing(true);
    // Keep a successful listing mounted while a manual refresh is in flight;
    // replacing it with the loading state would make its actions disappear.
    setSnapshot((current) =>
      current.status === "ready" ? current : { status: "loading" },
    );
    void view.refresh().finally(update);
    return () => {
      live = false;
      unsubscribe();
      view.dispose();
    };
  }, [memories, pubkey, attempt]);
  return {
    snapshot,
    refreshing,
    refresh: () => setAttempt((count) => count + 1),
  };
}

export function MemoryPanel({
  agent,
  memories,
}: {
  agent: Agent;
  memories: AgentMemories | undefined;
}) {
  const { snapshot, refreshing, refresh } = useMemory(memories, agent.pubkey);
  const reducedMotion = useReducedMotion();
  const { status, listing } = snapshot;
  const core = listing?.entries.find((entry) => entry.slug === "core");
  const rest = listing?.entries.filter((entry) => entry.slug !== "core") ?? [];
  const canRefresh = memories && status !== "loading" && status !== "denied";
  const refreshButton = canRefresh ? (
    <IconButton
      aria-label="Refresh"
      icon={
        <ArrowsClockwiseIcon
          className={refreshing && !reducedMotion ? "animate-spin" : undefined}
        />
      }
      size="xs"
      data-refreshing={refreshing || undefined}
      onClick={refresh}
    />
  ) : null;
  return (
    <div className="grid content-start gap-6">
      {status === "ready" && listing ? (
        <>
          <MemorySection
            title="Core memories"
            description="Automatically included when the agent works."
            entries={core ? [core] : []}
            actions={refreshButton}
            emptyIcon={<ThinkingHighIcon size={24} aria-hidden="true" />}
            refreshing={refreshing}
          />
          <MemorySection
            title="Memories"
            description="Saved details the agent looks up when needed."
            entries={rest}
            emptyIcon={<BrainIcon size={24} aria-hidden="true" />}
            refreshing={refreshing}
          />
          {listing.partial && (
            <p className="m-0 text-body-sm text-secondary">
              Some memories couldn't be shown.
            </p>
          )}
        </>
      ) : status === "loading" ? (
        <div
          role="status"
          aria-label="Loading memories"
          className="flex min-h-12 items-center justify-center text-secondary"
        >
          <CircleNotchIcon
            className="motion-safe:animate-spin"
            aria-hidden="true"
          />
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <p
            role={status === "error" ? "alert" : undefined}
            className={`m-0 text-body-sm ${status === "error" ? "text-danger" : "text-secondary"}`}
          >
            {MESSAGES[status]}
          </p>
          {refreshButton}
        </div>
      )}
    </div>
  );
}

function MemorySection({
  title,
  description,
  entries,
  emptyIcon,
  refreshing = false,
  actions,
}: {
  title: string;
  description: string;
  entries: readonly MemoryEntry[];
  emptyIcon: ReactNode;
  refreshing?: boolean;
  actions?: ReactNode;
}) {
  const ordered = [...entries].sort(
    (left, right) =>
      right.createdAt - left.createdAt || left.slug.localeCompare(right.slug),
  );
  return (
    <section className="grid gap-2" aria-label={title}>
      <div className={`group ${styles.sectionHeader}`}>
        <Header
          level={4}
          title={title}
          subtitle={description}
          actions={actions}
        />
      </div>
      <div
        className={`grid gap-2 transition-opacity ${refreshing ? "opacity-50" : ""}`}
        data-memory-list=""
        data-refreshing={refreshing || undefined}
      >
        {entries.length ? (
          ordered.map((entry) => (
            <MemoryAccordion key={entry.slug} entry={entry} />
          ))
        ) : (
          <div className={styles.empty}>
            <SettingsGroup>
              <div className="flex flex-col items-center justify-center gap-3 py-8 text-secondary">
                {emptyIcon}
                <p className="m-0 text-body-sm">No memories yet</p>
              </div>
            </SettingsGroup>
          </div>
        )}
      </div>
    </section>
  );
}

function MemoryAccordion({ entry }: { entry: MemoryEntry }) {
  // The shared Accordion cannot place an independent menu over each trigger
  // or wrap the whole item in a context-menu target. Putting the menu inside
  // its button would create nested controls, so this item owns its disclosure.
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const reducedMotion = useReducedMotion();
  const transition = { duration: reducedMotion ? 0 : 0.2 };
  const menu = <MemoryCopyMenu entry={entry} />;
  return (
    <ContextMenuRoot>
      <ContextMenuTrigger
        render={
          <div className="grid overflow-hidden rounded-xl bg-surface-inset" />
        }
      >
        <div className="col-start-1 row-start-1 grid">
          <button
            type="button"
            className="col-start-1 row-start-1 flex w-full cursor-pointer items-center gap-2 p-4 text-left text-body-sm"
            aria-label={entry.slug}
            aria-description={formatFullTimestamp(entry.createdAt)}
            aria-expanded={open}
            aria-controls={contentId}
            onClick={() => setOpen((value) => !value)}
          >
            {entry.slug === "core" ? (
              <ThinkingHighIcon size={20} aria-hidden="true" />
            ) : (
              <BrainIcon size={20} aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1 truncate text-label">
              {entry.slug.startsWith("mem/") ? (
                <>
                  <span className="text-secondary font-normal">mem/</span>
                  {entry.slug.slice(4)}
                </>
              ) : (
                entry.slug
              )}
            </span>
            <span
              className="shrink-0 text-secondary"
              title={formatFullTimestamp(entry.createdAt)}
            >
              {memoryTimestamp(entry.createdAt)}
            </span>
            <motion.span
              className="flex shrink-0"
              animate={{ rotate: open ? 90 : 0 }}
              transition={transition}
            >
              <CaretRightIcon aria-hidden="true" />
            </motion.span>
          </button>
        </div>
        <motion.div
          id={contentId}
          initial={false}
          animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
          transition={transition}
          className="col-start-1 row-start-2 overflow-hidden"
          aria-hidden={!open}
          inert={!open}
        >
          <div className="px-4 pb-4 text-body-sm">
            <MemoryBody body={entry.body} />
          </div>
        </motion.div>
      </ContextMenuTrigger>
      <MenuPopup>{menu}</MenuPopup>
    </ContextMenuRoot>
  );
}

function MemoryCopyMenu({ entry }: { entry: MemoryEntry }) {
  const notify = useToastNotification();
  const copy = (value: string, label: "name" | "body") =>
    navigator.clipboard.writeText(value).then(
      () => notify(`Memory ${label} copied.`, "success"),
      () => notify(`Couldn’t copy the memory ${label}.`, "error"),
    );
  return (
    <>
      <MenuItem onClick={() => copy(entry.slug, "name")}>Copy name</MenuItem>
      <MenuItem onClick={() => copy(entry.body, "body")}>
        Copy full body
      </MenuItem>
    </>
  );
}

function memoryTimestamp(createdAt: number, nowSeconds = Date.now() / 1_000) {
  const age = Math.max(0, nowSeconds - createdAt);
  if (age >= WEEK_SECONDS && age < MONTH_SECONDS) {
    const weeks = Math.floor(age / WEEK_SECONDS);
    return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  }
  if (age >= MONTH_SECONDS && age < TWO_MONTHS_SECONDS) return "1 month ago";
  return relativeTimestamp(createdAt, nowSeconds).replace(/^on /, "");
}

function MemoryBody({ body }: { body: string }) {
  if (body.length > MAX_MARKDOWN_LENGTH || scanMarkdown(body).tooDeep)
    return <div className={styles.plain}>{body}</div>;
  return (
    <div className={styles.markdown}>
      <Markdown remarkPlugins={REMARK} components={MARKDOWN}>
        {body}
      </Markdown>
    </div>
  );
}
