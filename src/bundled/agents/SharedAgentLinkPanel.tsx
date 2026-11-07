import { useEffect, useState, type ComponentProps } from "react";
import { AGENT_CATALOG_KIND } from "../../features/agents/catalog-envelope";
import { sharedAgents } from "../../features/agents/shared-agents";
import { relayOrigin } from "../../features/communities/destination";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import { SharedAgentPanel, type SharedAgentSelection } from "./AgentBrowse";

/** Resolves one catalog head directly, without paging through the marketplace. */
export function SharedAgentLinkPanel({
  id,
  community,
  relay,
  ...importing
}: Omit<ComponentProps<typeof SharedAgentPanel>, "selection"> & {
  id: string;
  community: string;
  relay: RelayData;
}) {
  const connection = useRelayConnection(relay);
  const session =
    connection.status === "ready" ? connection.session : undefined;
  const sameCommunity =
    !!connection.origin && relayOrigin(connection.origin) === community;
  const [attempt, retry] = useState(0);
  const [result, setResult] = useState<{
    id: string;
    session: RelaySession;
    attempt: number;
    selection?: SharedAgentSelection;
    error?: string;
  }>();
  useEffect(() => {
    if (!session || !sameCommunity) return;
    const controller = new AbortController();
    const [owner, d] = id.split(":");
    void session
      .read(
        [
          {
            kinds: [AGENT_CATALOG_KIND],
            authors: [owner ?? ""],
            "#d": [d ?? ""],
            limit: 10,
            consistency: "strong",
          },
        ],
        { signal: controller.signal, fresh: true },
      )
      .then(
        (events) => {
          if (controller.signal.aborted) return;
          const agent = sharedAgents(
            events.filter((event) => event.pubkey === owner),
          ).find((agent) => agent.id === id);
          setResult({
            id,
            session,
            attempt,
            ...(agent
              ? { selection: { agent, session, community } }
              : {
                  error:
                    "This agent is no longer shared or isn’t available to you.",
                }),
          });
        },
        () => {
          if (!controller.signal.aborted)
            setResult({
              id,
              session,
              attempt,
              error: "Couldn’t load this shared agent. Try again.",
            });
        },
      );
    return () => controller.abort();
  }, [id, community, session, sameCommunity, attempt]);

  if (!sameCommunity)
    return (
      <p>
        Open this link with the {new URL(community).host} community selected.
      </p>
    );
  if (!session)
    return (
      <p role="status">Connect to this community to open the shared agent.</p>
    );
  const current =
    result?.id === id &&
    result.session === session &&
    result.attempt === attempt
      ? result
      : undefined;
  if (!current) return <p role="status">Loading shared agent…</p>;
  if (current.selection)
    return <SharedAgentPanel selection={current.selection} {...importing} />;
  return (
    <div className="flex flex-col gap-section-gap">
      <p role="alert">{current.error}</p>
      <Button variant="subtle" onClick={() => retry((value) => value + 1)}>
        Try again
      </Button>
    </div>
  );
}
