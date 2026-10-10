import { useEffect, useRef, useState } from "react";
import type { RelaySnapshot } from "../../features/relay/service";
import type { EventData } from "../../features/relay/events";
import {
  AGENT_CATALOG_KIND,
  catalogHeads,
  parsePublication,
} from "../../features/agents/catalog-protocol";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { AgentCard } from "./AgentCard";

type SharedAgent = {
  id: string;
  name: string;
  owner: string;
  avatar: string | undefined;
  model: string;
  prompt: string;
};

// Select replacement heads before checking sharing, so unsharing hides older heads.
export function sharedAgents(events: readonly EventData[]): SharedAgent[] {
  return [...catalogHeads(events).values()]
    .flatMap((event) => {
      const publication = parsePublication(event);
      if (publication?.kind !== AGENT_CATALOG_KIND) return [];
      const { agent, owner, d } = publication;
      return [
        {
          id: `${owner}:${d}`,
          name: agent.displayName.trim(),
          owner,
          avatar: agent.avatarUrl,
          model: agent.model ?? "",
          prompt: agent.systemPrompt,
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

const pageSize = 200;
export function AgentBrowse({ connection }: { connection: RelaySnapshot }) {
  const [events, setEvents] = useState<readonly EventData[]>([]);
  const [cursor, setCursor] = useState<{ until: number; before_id: string }>();
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<SharedAgent>();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const { session, status } = connection;
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry reruns this finite read.
  useEffect(() => {
    if (status !== "ready") return;
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    void session
      .read([{ kinds: [30175], limit: pageSize, ...cursor }], {
        signal: controller.signal,
      })
      .then((page) => {
        if (controller.signal.aborted) return;
        setEvents((previous) => (cursor ? [...previous, ...page] : page));
        setMore(page.length === pageSize);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [session, status, cursor, attempt]);
  if (status !== "ready")
    return <p>Connect to a community to browse shared agents.</p>;
  const agents = sharedAgents(events);
  return (
    <div className="flex flex-col gap-section-gap">
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
      <div className="agent-grid">
        {agents.map((agent) => (
          <AgentCard
            key={agent.id}
            name={agent.name}
            avatar={agent.avatar}
            identities={[]}
            subtitle={agent.model || "Shared agent"}
            session={session}
            primaryAction={
              <Button
                onClick={(event) => {
                  trigger.current = event.currentTarget;
                  setSelected(agent);
                }}
              >
                View details
              </Button>
            }
          />
        ))}
      </div>
      {more && !error && (
        <Button
          disabled={loading}
          onClick={() => {
            const last = [...events]
              .sort(
                (a, b) =>
                  b.created_at - a.created_at || a.id.localeCompare(b.id),
              )
              .at(-1);
            if (last) setCursor({ until: last.created_at, before_id: last.id });
          }}
        >
          Load more
        </Button>
      )}
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
        title={selected?.name ?? "Shared agent"}
        finalFocus={trigger}
      >
        {selected && (
          <div className="flex flex-col gap-4">
            {selected.model && <p>{selected.model}</p>}
            <p className="text-body-sm text-secondary break-all">
              Shared by {selected.owner}
            </p>
            <p className="whitespace-pre-wrap">
              {selected.prompt || "No instructions included."}
            </p>
          </div>
        )}
      </Dialog>
    </div>
  );
}
