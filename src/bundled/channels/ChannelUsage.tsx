import { useState } from "react";
import type { RelaySession } from "../../features/relay/session";
import { useListedChannel } from "../../features/relay/listed-channel";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import { formatPublicKey } from "../../shared/identity/public-key";
import { Button } from "../../shared/design-system/ui/Button";
import { useUsageArchive } from "../../features/agents/use-usage-archive";
import type { UsageRecord, UsageSession } from "../../features/agents/usage";
import styles from "./ChannelUsage.module.css";

const number = (value?: number) =>
  value === undefined ? "—" : value.toLocaleString("en-US");
const usd = (value?: number) =>
  value === undefined
    ? "—"
    : `$${value.toFixed(value < 0.01 && value > 0 ? 4 : 2)}`;
const date = (value: number) => new Date(value).toLocaleString();
function total(record: UsageRecord | null) {
  const counters = record?.cumulative;
  if (counters?.totalTokens !== undefined)
    return `${number(counters.totalTokens)} tokens`;
  if (
    counters?.inputTokens !== undefined ||
    counters?.outputTokens !== undefined
  )
    return `Input ${number(counters.inputTokens)} / Output ${number(counters.outputTokens)}`;
  return "—";
}
function Breakdown({
  record,
  kind,
}: {
  record: UsageRecord | null;
  kind: "turn" | "cumulative";
}) {
  const counts = record?.[kind];
  return (
    <dl className={styles.breakdown}>
      <dt>Provider total tokens</dt>
      <dd>{number(counts?.totalTokens)}</dd>
      <dt>Input</dt>
      <dd>{number(counts?.inputTokens)}</dd>
      <dt>Output</dt>
      <dd>{number(counts?.outputTokens)}</dd>
      <dt>Cache reads</dt>
      <dd>{number(counts?.cacheReadTokens)}</dd>
      <dt>Cache writes</dt>
      <dd>{number(counts?.cacheWriteTokens)}</dd>
      <dt>Estimated USD</dt>
      <dd>{usd(counts?.costUsd)}</dd>
    </dl>
  );
}
function Turns({ group, name }: { group: UsageSession; name: string }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <section>
      <h3>Recorded turns · {group.turns.length} · newest first</h3>
      <section
        className={styles.turnList}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded turn list supports keyboard scrolling.
        tabIndex={0}
        aria-label={`${name} recorded turns`}
      >
        {group.turns.map((row) => (
          <div key={row.id} className={styles.turn}>
            <div className={styles.turnHead}>
              <span>
                {row.turnId?.endsWith(":initial")
                  ? "Session setup"
                  : row.turnSeq === null
                    ? "—"
                    : `#${row.turnSeq}`}
              </span>
              <time dateTime={new Date(row.timestamp).toISOString()}>
                {date(row.timestamp)}
              </time>
              <span>{number(row.turn?.totalTokens)}</span>
              <Button
                size="xs"
                variant="ghost"
                aria-label={`${expanded === row.id ? "Hide" : "Show"} turn ${row.turnSeq ?? row.id} details`}
                aria-expanded={expanded === row.id}
                onClick={() => setExpanded(expanded === row.id ? null : row.id)}
              >
                {usd(row.turn?.costUsd)} · {expanded === row.id ? "−" : "+"}
              </Button>
            </div>
            {expanded === row.id && (
              <div>
                {row.conflict ? (
                  <p>Conflicting turn records. Per-turn usage unavailable.</p>
                ) : !row.turn ? (
                  <p>Per-turn usage unavailable.</p>
                ) : (
                  <Breakdown record={row} kind="turn" />
                )}
                <details>
                  <summary>Identifiers and provenance</summary>
                  <dl className={styles.breakdown}>
                    <dt>Session</dt>
                    <dd>{row.sessionId ?? "Not reported"}</dd>
                    <dt>Turn</dt>
                    <dd>{row.turnId ?? "Not reported"}</dd>
                    <dt>Harness / model</dt>
                    <dd>
                      {row.harness} / {row.model ?? "Not reported"}
                    </dd>
                    <dt>Stop reason</dt>
                    <dd>{row.stopReason ?? "Not reported"}</dd>
                    <dt>Pricing identity</dt>
                    <dd>{row.pricing ?? "Not reported"}</dd>
                  </dl>
                </details>
              </div>
            )}
          </div>
        ))}
      </section>
    </section>
  );
}

/** Archive association is by selected channel; a thread does not confer attribution. */
export function ChannelUsage({
  session,
  channelId,
}: {
  session: RelaySession;
  channelId: string;
}) {
  const channel = useListedChannel(session.channels, channelId, (item) => item);
  const allowed =
    !!channel &&
    !channel.cached &&
    !channel.readOnly &&
    !!channel.members?.includes(session.viewer ?? "");
  const usage = useUsageArchive(
    session.agentActivity?.archive,
    channelId,
    allowed,
  );
  const resolve = useChannelIdentityNames(session, channelId);
  const [agent, setAgent] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  if (!allowed || !session.agentActivity?.archive) return null;
  const agents = [...new Set(usage.groups.map((group) => group.agent))];
  const groups = usage.groups.filter((group) => group.agent === agent);
  const group =
    groups.find((group) => group.key === selected) ??
    (groups.length === 1 ? groups[0] : undefined);
  const label = (id: string) => resolve(id, formatPublicKey(id) ?? "Agent");
  return (
    <div className={styles.owner}>
      <fieldset className={styles.strip} aria-label="Channel session usage">
        <span>Channel session usage</span>
        {agents.slice(0, showAll ? undefined : 3).map((id) => {
          const sessions = usage.groups.filter((group) => group.agent === id);
          return (
            <Button
              key={id}
              size="sm"
              variant={agent === id ? "subtle" : "ghost"}
              aria-expanded={agent === id}
              onClick={() => {
                setAgent(agent === id ? null : id);
                setSelected(null);
              }}
            >
              {label(id)} ·{" "}
              {sessions.length === 1
                ? total(sessions[0]?.latest ?? null)
                : `${sessions.length} sessions`}
            </Button>
          );
        })}
        {agents.length > 3 && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setShowAll(!showAll)}
          >
            {showAll ? "Fewer agents" : "More agents"}
          </Button>
        )}
        {usage.status === "loading" && (
          <span role="status">Loading saved usage…</span>
        )}
        <Button size="xs" variant="ghost" onClick={usage.refresh}>
          Refresh
        </Button>
      </fieldset>
      {agent && (
        <section className={styles.details} aria-label="Session usage details">
          <div className={styles.heading}>
            <h2>Session usage · {label(agent)}</h2>
            <Button size="xs" variant="ghost" onClick={() => setAgent(null)}>
              Close
            </Button>
          </div>
          <p>Session totals may include other threads.</p>
          {groups.length > 1 && (
            <fieldset className={styles.sessions} aria-label="Select session">
              {groups.map((entry, index) => (
                <Button
                  key={entry.key}
                  size="sm"
                  variant={entry.key === group?.key ? "subtle" : "ghost"}
                  aria-pressed={entry.key === group?.key}
                  onClick={() => setSelected(entry.key)}
                >
                  {entry.sessionId
                    ? `Session ${index + 1}`
                    : `Unidentified session ${index + 1}`}
                </Button>
              ))}
            </fieldset>
          )}
          {group && (
            <div key={group.key}>
              <p>
                {group.sessionId
                  ? `Session ${group.sessionId}`
                  : "Unidentified session"}{" "}
                ·{" "}
                {group.latest?.harness ??
                  group.turns[0]?.harness ??
                  "Not reported"}{" "}
                /{" "}
                {group.latest?.model ?? group.turns[0]?.model ?? "Not reported"}
              </p>
              <h3>Latest reported session counters</h3>
              <p>
                Last reported{" "}
                {group.latest ? date(group.latest.timestamp) : "Not reported"}
              </p>
              {!group.latest && <p>Session counters unavailable.</p>}
              <Breakdown record={group.latest} kind="cumulative" />
              <p>Cache counts are part of input, not additional tokens.</p>
              <details>
                <summary>Session identity and pricing provenance</summary>
                <p>
                  {group.sessionId ?? "Not reported"} ·{" "}
                  {group.latest?.pricing ?? "Not reported"}
                </p>
              </details>
              <Turns group={group} name={label(agent)} />
            </div>
          )}
        </section>
      )}
      {usage.status === "error" && (
        <p role="alert">
          Could not read saved usage.{" "}
          <Button size="xs" onClick={usage.refresh}>
            Retry
          </Button>
        </p>
      )}
      {!agents.length && usage.status !== "loading" && (
        <p>
          {usage.skipped || usage.unreadable
            ? "Some saved metrics could not be read. Usage history is incomplete."
            : usage.hasMore
              ? "No matching records loaded yet. More saved history available."
              : "No matching records in the saved history searched."}
        </p>
      )}
      {!!agents.length && !!(usage.skipped || usage.unreadable) && (
        <p>
          Some saved metrics could not be read. Usage history is incomplete.
        </p>
      )}
      {usage.hasMore && (
        <Button
          size="xs"
          variant="ghost"
          disabled={usage.status === "loading"}
          onClick={usage.loadMore}
        >
          Load more
        </Button>
      )}
      {usage.loaded >= 2000 && (
        <p>Partial history. Refresh to search newer records.</p>
      )}
    </div>
  );
}
