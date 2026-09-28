import { useState, useSyncExternalStore, type ReactNode } from "react";
import type { Profile } from "../../features/relay/contracts";
import { knownAgentPubkeys } from "../../features/agents/known";
import { ChatCircleIcon } from "../../shared/design-system/icons";
import type { RelaySession } from "../../features/relay/session";
import { useIdentityNames } from "../../features/identity-names/react";
import { formatPublicKey } from "../../shared/identity/public-key";
import { Button } from "../../shared/design-system/ui/Button";
import type { TranscriptEntry } from "./transcript";
import { ActivityDisclosure } from "./ActivityDisclosure";
import styles from "./ActivityStream.module.css";

const emptyProfiles: ReadonlyMap<string, Profile> = new Map();
const empty = () => emptyProfiles;
const subscribe = () => () => {};
const noChoices = () => undefined;
export function ActivityMessageEntry({
  entry,
  agent,
  session,
  evidence,
  expandHumanRequests = false,
}: {
  entry: TranscriptEntry;
  agent: string;
  session?: RelaySession | undefined;
  evidence: ReactNode;
  /** Profile history keeps incoming human context readable; no new identity reads. */
  expandHumanRequests?: boolean;
}) {
  const profiles = useSyncExternalStore(
    session?.profiles.subscribe ?? subscribe,
    session?.profiles.snapshot ?? empty,
    empty,
  );
  const resolveName = useIdentityNames(session?.names);
  const [full, setFull] = useState(false);
  const [expansion, expand] = useState<boolean | undefined>(undefined);
  const choices = useSyncExternalStore(
    (expandHumanRequests ? session?.agentChoices?.subscribe : undefined) ??
      subscribe,
    (expandHumanRequests ? session?.agentChoices?.snapshot : undefined) ??
      noChoices,
    noChoices,
  );
  const message = entry.communication;
  const author = message?.author ?? agent;
  // Unknown authors stay collapsed. Cached ordinary profiles are display hints,
  // not proof of human identity; known agent keys override those hints.
  const humanRequest =
    message?.direction === "incoming" &&
    author !== agent &&
    message.reportedAudience !== "agents" &&
    (author === session?.viewer ||
      (profiles.has(author) &&
        !knownAgentPubkeys(profiles, choices).has(author)));
  const expanded = expansion ?? (expandHumanRequests && humanRequest);
  const name = resolveName(
    author,
    profiles.get(author)?.name ?? formatPublicKey(author) ?? "Unknown author",
  );
  const label =
    message?.direction === "incoming"
      ? "Reported incoming message"
      : message
        ? "Send message"
        : "Response";
  const status =
    message?.direction === "outgoing"
      ? entry.status === "failed"
        ? "Failed"
        : entry.status === "pending"
          ? "Pending"
          : entry.status === "in_progress"
            ? "Running"
            : entry.status === "completed"
              ? message.eventId
                ? "Reported sent"
                : "Delivery unconfirmed"
              : "Status unknown"
      : "";
  const body = message
    ? message.body || "Message text is not included in this activity."
    : entry.body;
  const summary = (
    <span className={styles.label}>
      <ChatCircleIcon
        size={16}
        data-activity-action="message"
        aria-hidden="true"
      />
      <span className="text-label-sm text-standard">{name}</span>{" "}
      <span className="text-caption text-subtle">
        {label}
        {status ? ` · ${status}` : ""}
        {message?.reportedAudience === "agents"
          ? " · Reported coordination"
          : ""}
      </span>
    </span>
  );
  const content = (
    <>
      <p className={`${styles.prose} text-body-sm`}>
        {!message && !full && body.length > 500
          ? `${body.slice(0, 500)}…`
          : body}
      </p>
      {!message && body.length > 500 && (
        <div>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={full}
            onClick={() => setFull(!full)}
          >
            {full ? "Show less text" : "Show full text"}
          </Button>
        </div>
      )}
      {evidence}
    </>
  );
  return (
    <article className={styles.message} aria-label={`${label} from ${name}`}>
      {message ? (
        <ActivityDisclosure
          label={summary}
          expanded={expanded}
          onExpand={expand}
        >
          <div className={styles.messageContent}>{content}</div>
        </ActivityDisclosure>
      ) : (
        <>
          {summary}
          {content}
        </>
      )}
    </article>
  );
}
