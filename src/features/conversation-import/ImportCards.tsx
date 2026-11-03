import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import type { ChannelMessage, Profile } from "../relay/contracts";
import { useRelayConnection } from "../relay/react";
import type { RelayData } from "../relay/service";
import { ImportMembers } from "./ConversationImportReview";
import { fingerprint, SOURCE_KIND_LABELS, sourceLabel } from "./protocol";
import type { ReviewMember } from "./reviews";
import type {
  ConversationImportService,
  ImportSessionView,
  VerifiedProfileView,
} from "./types";
import styles from "./ConversationImport.module.css";

const emptyProfiles: ReadonlyMap<string, Profile> = new Map();
const noSubscribe = () => () => {};

const STATUS_TEXT: Record<ImportSessionView["status"], string> = {
  proposed: "Waiting for everyone to accept",
  active: "Importing",
  declined: "Declined",
  withdrawn: "Withdrawn",
  expired: "Expired before everyone accepted",
  completed: "Imported",
};

function formatDate(seconds: number) {
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** The live read model, seeded by one relay read so that members outside
 * the session still see its current status. */
function useImportSession(
  service: ConversationImportService,
  proposalId: string,
) {
  const subscribe = useCallback(
    (changed: () => void) => service.subscribe(() => changed()),
    [service],
  );
  const read = () => (proposalId ? service.session(proposalId) : undefined);
  const live = useSyncExternalStore(subscribe, read, read);
  const [fetched, setFetched] = useState<ImportSessionView>();
  useEffect(() => {
    if (!proposalId) return;
    const controller = new AbortController();
    void service
      .refresh(proposalId, controller.signal)
      .then((view) => {
        if (!controller.signal.aborted) setFetched(view);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [service, proposalId]);
  return live ?? (fetched?.proposalId === proposalId ? fetched : undefined);
}

function verifiedFrom(
  pubkey: string,
  profile: Profile | undefined,
): VerifiedProfileView | undefined {
  const verified = profile?.verified;
  return (
    verified && {
      pubkey,
      displayName: verified.displayName,
      username: verified.username,
      issuerLabel: verified.issuerLabel,
      verifiedAt: verified.verifiedAt,
      fingerprint: fingerprint(pubkey),
    }
  );
}

/** The proposal (kind 42110) as an in-timeline consent card. Accept and
 * Decline open the host's confirmation dialog; the card never signs. */
export function ImportConsentCard({
  message,
  relay,
  service,
}: {
  message: ChannelMessage;
  relay: RelayData;
  service: ConversationImportService;
}) {
  const record = message.importRecord;
  const proposal = record?.type === "proposal" ? record.proposal : undefined;
  const connection = useRelayConnection(relay);
  const session = connection.session;
  const profiles = useSyncExternalStore(
    session?.profiles.subscribe ?? noSubscribe,
    () => session?.profiles.snapshot() ?? emptyProfiles,
    () => session?.profiles.snapshot() ?? emptyProfiles,
  );
  const view = useImportSession(service, proposal?.id ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const participantKeys =
    proposal?.content.participants.map((item) => item.pubkey).join(":") ?? "";
  useEffect(() => {
    if (participantKeys)
      void session?.profiles.ensure(participantKeys.split(":")).catch(() => {});
  }, [session, participantKeys]);
  if (!proposal) return null;
  const { content } = proposal;
  const viewer = connection.viewer;
  // Without a read model yet, the proposal's own expiry still applies.
  const status =
    view?.status ??
    (content.expires_at <= Date.now() / 1000 ? "expired" : "proposed");
  const consents = view?.consents ?? {};
  const own = content.participants.find((item) => item.pubkey === viewer);
  const open = status === "proposed" || status === "active";
  const totals = content.participants.reduce(
    (sum, item) => ({
      messages: sum.messages + item.messages,
      reactions: sum.reactions + item.reactions,
    }),
    { messages: 0, reactions: 0 },
  );
  const accepted = content.participants.filter(
    (item) => consents[item.pubkey] === "accept",
  ).length;
  const members: ReviewMember[] = content.participants.map((item) => {
    const verified = verifiedFrom(item.pubkey, profiles.get(item.pubkey));
    const decision = consents[item.pubkey];
    const state =
      decision === "accept"
        ? "accepted"
        : decision === "decline"
          ? "declined"
          : view?.confirmed
            ? "waiting"
            : undefined;
    const note = [
      `${item.messages} messages, ${item.reactions} reactions`,
      state,
    ]
      .filter(Boolean)
      .join(" · ");
    return { pubkey: item.pubkey, ...(verified ? { verified } : {}), note };
  });
  const act = async (run: () => Promise<unknown>) => {
    setPending(true);
    setError(undefined);
    try {
      await run();
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === "AbortError"))
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };
  const decided = own ? consents[own.pubkey] : undefined;
  const role = session?.channels
    ?.list()
    .channels.find((item) => item.id === proposal.channelId)?.viewerRole;
  const canApprove =
    open &&
    !!view &&
    !own &&
    !!viewer &&
    !consents[viewer] &&
    (role === "owner" || role === "admin");
  return (
    <section
      className={styles.card}
      aria-label="Conversation import proposal"
      data-import-proposal={proposal.id}
    >
      <p className={styles.cardTitle}>
        Import {content.source.label} from {sourceLabel(content.source.type)}
      </p>
      <p className={styles.status}>
        {STATUS_TEXT[status]}
        {status === "proposed" && view?.confirmed
          ? ` (${accepted} of ${content.participants.length} accepted)`
          : ""}
      </p>
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>Source</dt>
          <dd>{SOURCE_KIND_LABELS[content.source.kind]}</dd>
        </div>
        <div className={styles.fact}>
          <dt>Date range</dt>
          <dd>
            {formatDate(content.range.from)} to {formatDate(content.range.to)}
          </dd>
        </div>
        <div className={styles.fact}>
          <dt>Messages</dt>
          <dd>
            {totals.messages} messages, {totals.reactions} reactions
          </dd>
        </div>
        {content.excluded_authors > 0 && (
          <div className={styles.fact}>
            <dt>Not imported</dt>
            <dd>
              Messages from {content.excluded_authors}{" "}
              {content.excluded_authors === 1 ? "person" : "people"} without a
              verified Buzz identity
            </dd>
          </div>
        )}
        <div className={styles.fact}>
          <dt>Manifest</dt>
          <dd className={styles.fingerprint}>
            {fingerprint(content.manifest)}
          </dd>
        </div>
      </dl>
      <ImportMembers members={members} />
      {error && (
        <p className={styles.refusal} role="alert">
          {error}
        </p>
      )}
      {open && own && (
        <div className={styles.actions}>
          {!decided && (
            <>
              <Button
                variant="primary"
                disabled={pending}
                onClick={() =>
                  void act(() =>
                    service.consent(proposal.id, "accept", own.source_user),
                  )
                }
              >
                Accept
              </Button>
              <Button
                variant="subtle"
                disabled={pending}
                onClick={() =>
                  void act(() =>
                    service.consent(proposal.id, "decline", own.source_user),
                  )
                }
              >
                Decline
              </Button>
            </>
          )}
          {(decided === "accept" || proposal.proposer === viewer) && (
            <Button
              variant="subtle"
              disabled={pending}
              onClick={() => void act(() => service.withdraw(proposal.id))}
            >
              Withdraw
            </Button>
          )}
        </div>
      )}
      {canApprove && (
        <div className={styles.actions}>
          <Button
            variant="primary"
            disabled={pending}
            onClick={() =>
              void act(() => service.consent(proposal.id, "accept", "admin"))
            }
          >
            Approve as admin
          </Button>
        </div>
      )}
    </section>
  );
}

/** Composer banner while an import in this channel is publishing. */
export function ImportProgressBanner({
  channelId,
  service,
}: {
  channelId: string;
  service: ConversationImportService;
}) {
  const [sessions, setSessions] = useState<readonly ImportSessionView[]>([]);
  useEffect(() => service.subscribe(setSessions), [service]);
  const active = sessions.find(
    (item) => item.channelId === channelId && item.status === "active",
  );
  if (!active) return null;
  const total = active.proposal.participants.reduce(
    (sum, item) => sum + item.messages + item.reactions,
    0,
  );
  const published = Object.values(active.published).reduce(
    (sum, item) => sum + item.messages + item.reactions,
    0,
  );
  const done = Math.min(published, total);
  return (
    <div className={styles.banner} role="status" data-import-progress="">
      <span className={styles.bannerText}>
        Importing {active.proposal.source.label} from{" "}
        {sourceLabel(active.proposal.source.type)}: {done} of {total} items,{" "}
        {active.completed.length} of {active.proposal.participants.length}{" "}
        people done
      </span>
      <progress
        className={styles.meter}
        max={Math.max(total, 1)}
        value={done}
        aria-label="Import progress"
      />
    </div>
  );
}
