import { useSyncExternalStore } from "react";
import type { MentionRefusal } from "../agents/owner-attestation";
import type { RelaySession } from "../relay/session";
import styles from "./Messages.module.css";

const noSubscribe = () => () => {};

export function agentDeclineText(name: string, refusal: MentionRefusal) {
  return refusal === "sender"
    ? `${name} only responds to your messages.`
    : `${name} didn't respond to this workflow message. This community limits which workflows can use agents, so other people can't use yours. The workflow's Runs tab shows why it didn't respond this time.`;
}

/** Why this device's agents didn't act on this message. Local and owner-only:
 * the decisions are this app's, and nothing is published. */
export function AgentDeclineNotes({
  session,
  channelId,
  messageId,
}: {
  session: Pick<RelaySession, "agentActivity" | "agentChoices">;
  channelId: string;
  messageId: string;
}) {
  const read = () =>
    JSON.stringify(
      (session.agentActivity?.snapshot().declined ?? [])
        .filter(
          (row) => row.channelId === channelId && row.messageId === messageId,
        )
        .map((row) => [row.agent, row.refusal]),
    );
  const declined = JSON.parse(
    useSyncExternalStore(
      session.agentActivity?.subscribe ?? noSubscribe,
      read,
      read,
    ),
  ) as [string, MentionRefusal][];
  // Read only once there is a note: test and preview sessions may have none.
  const readChoices = () =>
    declined.length ? session.agentChoices.snapshot() : undefined;
  const choices = useSyncExternalStore(
    (declined.length && session.agentChoices.subscribe) || noSubscribe,
    readChoices,
    readChoices,
  );
  return declined.map(([agent, refusal]) => {
    const name =
      choices?.identities.find((choice) => choice.pubkey === agent)?.name ??
      "Your agent";
    return (
      <p key={agent} role="status" className={styles.agentNote}>
        {agentDeclineText(name, refusal)}
      </p>
    );
  });
}
