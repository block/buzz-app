// The app's read-only view of an agent's memory. Every agent type keeps its
// memory the same way, encrypted to the owner, so the app shows it once: `core`
// (what each run is given) first, then the slugs the agent reads on demand.
import { useEffect, useState } from "react";
import { formatItemTimestamp } from "../../shared/datetime";
import { Button } from "../../shared/design-system/ui/Button";
import type { RelaySession } from "../relay/session";
import type { MemoryEntry, MemorySnapshot } from "./memory";
import type { Agent } from "./service";

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

/** Reads once per open or refresh, and gives the view back as soon as it has
 * read: the session allows only a few at once, and runs draw on the same pool. */
function useMemory(memories: AgentMemories | undefined, pubkey: string) {
  const [attempt, setAttempt] = useState(0);
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
      setSnapshot({ status: "unavailable" });
      return;
    }
    let live = true;
    setSnapshot({ status: "loading" });
    void view.refresh().finally(() => {
      if (live) setSnapshot(view.snapshot());
      view.dispose();
    });
    return () => {
      live = false;
      view.dispose();
    };
  }, [memories, pubkey, attempt]);
  return { snapshot, refresh: () => setAttempt((count) => count + 1) };
}

export function MemoryPanel({
  agent,
  memories,
}: {
  agent: Agent;
  memories: AgentMemories | undefined;
}) {
  const { snapshot, refresh } = useMemory(memories, agent.pubkey);
  const { status, listing } = snapshot;
  const core = listing?.entries.find((entry) => entry.slug === "core");
  const rest = listing?.entries.filter((entry) => entry.slug !== "core") ?? [];
  return (
    <div className="grid content-start gap-6">
      <div className="flex items-start justify-between gap-2">
        <p className="m-0 text-body-sm text-secondary">
          What this agent remembers. Its runs are given <code>core</code>; it
          reads the rest when it needs them. Only the agent writes its memory.
        </p>
        {memories && status !== "loading" && status !== "denied" && (
          <Button size="sm" variant="ghost" onClick={refresh}>
            Refresh
          </Button>
        )}
      </div>
      {status === "ready" && listing ? (
        <>
          <MemorySection
            title="Core"
            entries={core ? [core] : []}
            empty="No core memory yet. The agent creates it when it has something to keep."
          />
          <MemorySection
            title="Other memories"
            entries={rest}
            empty="No other memories."
          />
          {listing.partial && (
            <p className="m-0 text-body-sm text-secondary">
              Some memories couldn't be shown.
            </p>
          )}
        </>
      ) : (
        <p
          role={status === "error" ? "alert" : undefined}
          className={`m-0 text-body-sm ${status === "error" ? "text-danger" : "text-secondary"}`}
        >
          {MESSAGES[status]}
        </p>
      )}
    </div>
  );
}

function MemorySection({
  title,
  entries,
  empty,
}: {
  title: string;
  entries: readonly MemoryEntry[];
  empty: string;
}) {
  return (
    <section className="grid gap-2" aria-label={title}>
      <h4 className="m-0 text-label">{title}</h4>
      {entries.length ? (
        entries.map((entry) => (
          <article
            key={entry.slug}
            aria-label={entry.slug}
            className="grid gap-2 rounded-container bg-surface-inset p-4"
          >
            <div className="flex items-center justify-between gap-2 text-body-sm">
              <code className="truncate">{entry.slug}</code>
              <span className="shrink-0 text-secondary">
                {formatItemTimestamp(entry.createdAt, { withTime: true })}
              </span>
            </div>
            <p className="m-0 whitespace-pre-wrap break-words text-body-sm">
              {entry.body}
            </p>
          </article>
        ))
      ) : (
        <p className="m-0 text-body-sm text-secondary">{empty}</p>
      )}
    </section>
  );
}
