// An agent card sent in a conversation, drawn as the agent's card from the
// Marketplace: choosing it opens Add rather than the picture.
import { useEffect, useRef, useState } from "react";
import { readSnapshot } from "../../features/agents/agent-share";
import { useAgents } from "../../features/agents/react";
import type { Agents } from "../../features/agents/service";
import type { AttachmentRendererProps } from "../../features/conversation/contracts";
import type { Attachment } from "../../features/relay/contracts";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import { SurfaceButton } from "../../shared/design-system/ui/SurfaceButton";
import { SharedAgentCardContent, SharedImportDialog } from "./AgentBrowse";
import cardStyles from "./AgentCard.module.css";
import styles from "./AgentCardAttachment.module.css";

const CARD = /\.agent\.png$/i;

/** Share names agent cards `<name>.agent.png`. */
export const isAgentCard = (attachment: Attachment) =>
  attachment.kind === "image" && CARD.test(attachment.name ?? "");

type Definition = Awaited<ReturnType<typeof readSnapshot>>;

export function AgentCardAttachment({
  attachment,
  source,
  agents,
  relay,
}: AttachmentRendererProps & { agents: Agents; relay: RelayData }) {
  const connection = useRelayConnection(relay);
  const { types } = useAgents(agents);
  // `undefined` while the card is read; `null` when it holds no agent.
  const [shared, setShared] = useState<Definition | null>();
  const [adding, setAdding] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setShared(undefined);
    fetch(source, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
      })
      .then(readSnapshot)
      .then(setShared, () => !controller.signal.aborted && setShared(null));
    return () => controller.abort();
  }, [source]);
  const name = (attachment.name ?? "").replace(CARD, "") || "Agent";
  // Not a card after all: show the picture it is.
  if (shared === null)
    return <img className={styles.picture} src={source} alt={name} />;
  const runnable = types.filter((type) => !type.remote);
  return (
    <>
      <SurfaceButton
        ref={trigger}
        className={`${cardStyles.card} ${cardStyles.agentCard} ${styles.card}`}
        aria-label={`${shared?.name ?? name}, shared agent`}
        aria-haspopup="dialog"
        disabled={!shared}
        onClick={() => setAdding(true)}
      >
        <SharedAgentCardContent
          agent={shared ?? { name, model: "" }}
          community={
            connection.status === "ready" ? connection.origin : undefined
          }
        />
      </SurfaceButton>
      {adding && shared && (
        <SharedImportDialog
          shared={shared}
          agents={agents}
          types={runnable}
          onImported={() => setAdding(false)}
          onClose={() => setAdding(false)}
          finalFocus={trigger}
        />
      )}
    </>
  );
}
