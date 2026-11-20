import { useEffect, useSyncExternalStore, type MouseEvent } from "react";
import type { TargetOpener } from "../../features/conversation/contracts";
import type { ChannelMessage } from "../../features/relay/contracts";
import inlineStyles from "../../shared/InlineReference.module.css";
import { stateIcons } from "./pull-state-view";
import { announcementUrl, type PullRecord } from "./relay-pull";
import type { PullSources } from "./relay-pulls";
import { keyOf } from "./pull-states";
import styles from "./GitHub.module.css";

const list = (names: readonly string[]) =>
  names.map((name) => name.replace(/^team:/, "")).join(", ");

const CHECKS = {
  success: ["Checks passing", "open"],
  failure: ["Checks failing", "failure"],
  pending: ["Checks running", "pending"],
} as const;

function Facts({
  record,
  publisher,
}: {
  record: PullRecord;
  publisher?: string | undefined;
}) {
  const { pull } = record;
  const approved = Object.entries(pull.reviews)
    .filter(([, verdict]) => verdict === "approved")
    .map(([login]) => login);
  const changes = Object.entries(pull.reviews)
    .filter(([, verdict]) => verdict === "changes_requested")
    .map(([login]) => login);
  const open = pull.state === "open" || pull.state === "draft";
  const checks =
    open && pull.checks.state in CHECKS
      ? CHECKS[pull.checks.state as keyof typeof CHECKS]
      : undefined;
  return (
    <div className={styles.pullCardMeta}>
      <span>{pull.repo}</span>
      {checks && <span data-tone={checks[1]}>{checks[0]}</span>}
      {!!approved.length && <span>Approved by {list(approved)}</span>}
      {!!changes.length && (
        <span data-tone="failure">Changes requested by {list(changes)}</span>
      )}
      {open && !!pull.requestedReviewers.length && (
        <span>Awaiting {list(pull.requestedReviewers)}</span>
      )}
      {publisher && <span>via {publisher}</span>}
    </div>
  );
}

/** An announcement of a pull request, as a card showing the state its
 * writer keeps for it; the announcement's own words until it has one. Only
 * a record its signer wrote for the pull request it links counts. */
export function PullCard({
  message,
  sources,
  nameOf,
  open,
  canOpen,
}: TargetOpener & {
  message: ChannelMessage;
  sources: PullSources;
  nameOf(pubkey: string): string;
}) {
  const pulls = sources.selected();
  useEffect(
    () => pulls?.watch(message.channelId, message.id),
    [pulls, message.channelId, message.id],
  );
  const rooted = useSyncExternalStore(sources.subscribe, () =>
    sources
      .selected()
      ?.byRoot(message.id, message.signerId ?? message.authorId),
  );
  const linked = announcementUrl(message.content);
  const record =
    rooted && linked && keyOf(rooted.pull.url) === keyOf(linked)
      ? rooted
      : undefined;
  const url = record?.pull.url ?? linked;
  if (!url) return null;
  const Icon = stateIcons[record?.pull.state ?? "open"];
  const title = record
    ? `#${record.pull.number} · ${record.pull.title}`
    : (message.content.split("\n")[0] ?? url);
  const follow = (event: MouseEvent) => {
    if (canOpen(url) && open(url)) event.preventDefault();
  };
  return (
    <section className={styles.pullCard} aria-label="Pull request">
      <span
        className={`${styles.pullState} ${styles.pullCardState}`}
        data-pr-state={record?.pull.state ?? "unknown"}
      >
        <Icon size={16} aria-hidden="true" />
        <span className="sr-only">
          {record ? `Pull request, ${record.pull.state}` : "Pull request"}
        </span>
      </span>
      <div className={styles.pullCardBody}>
        <a
          className={`${inlineStyles.link} ${styles.pullCardTitle}`}
          href={url}
          target="_blank"
          rel="noreferrer"
          onClick={follow}
        >
          {title}
        </a>
        {record && (
          <Facts
            record={record}
            publisher={record.publisher && nameOf(record.publisher)}
          />
        )}
      </div>
    </section>
  );
}
