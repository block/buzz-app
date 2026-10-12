// Browse: the agents this community's members have shared, read-only. The
// catalog is read a page at a time; an over-budget page is retried smaller.
import { useEffect, useRef, useState } from "react";
import { AGENT_CATALOG_KIND } from "../../features/agents/catalog-envelope";
import { ModelIcon } from "../../features/agents/ModelPicker";
import {
  type SharedAgent,
  sharedAgents,
} from "../../features/agents/shared-agents";
import { ReadError } from "../../features/relay/errors";
import type { EventData } from "../../features/relay/events";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { formatPublicKey } from "../../shared/identity/public-key";
import { AgentCard } from "./AgentCard";
import cardStyles from "./AgentCard.module.css";

const pageSize = 200;

export function AgentBrowse({ relay }: { relay: RelayData }) {
  const connection = useRelayConnection(relay);
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
    const readPage = async () => {
      let limit = pageSize;
      for (;;) {
        controller.signal.throwIfAborted();
        try {
          const page = await session.read(
            [{ kinds: [AGENT_CATALOG_KIND], limit, ...cursor }],
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          setEvents((previous) => (cursor ? [...previous, ...page] : page));
          setMore(page.length === limit);
          return;
        } catch (problem) {
          // Match the community catalog's bounded retry at the same cursor.
          if (
            problem instanceof ReadError &&
            problem.kind === "invalid-response" &&
            problem.message === "Relay response exceeds the read budget" &&
            limit > 1
          ) {
            limit = Math.floor(limit / 2);
            continue;
          }
          throw problem;
        }
      }
    };
    void readPage()
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
      <div className={cardStyles.grid}>
        {agents.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            community={connection.origin}
            detail={agent.model || "Shared agent"}
            icon={<ModelIcon model={agent.model} />}
          >
            <Button
              onClick={(event) => {
                trigger.current = event.currentTarget;
                setSelected(agent);
              }}
            >
              View details
            </Button>
          </AgentCard>
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
              Shared by {formatPublicKey(selected.owner) ?? selected.owner}
            </p>
            <p className="whitespace-pre-wrap">
              {selected.instructions || "No instructions included."}
            </p>
          </div>
        )}
      </Dialog>
    </div>
  );
}
