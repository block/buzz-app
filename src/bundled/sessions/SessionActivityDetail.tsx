import { useMemo, useState, useSyncExternalStore } from "react";
import type { ChannelThreadAccessoryProps } from "../../features/conversation/contracts";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import {
  sessionActivityDetail,
  type SessionActivityRecord,
} from "./session-activity-detail";
import styles from "./SessionActivityDetail.module.css";

const empty = Object.freeze([]);
const absent = () => empty;
const noSubscription = () => () => {};

/** Passive only: Agent Activity's plugin owns capture. Profiles are already-loaded
 * display hints, never identity/ownership proof or an excuse for an optional read. */
export function SessionActivityDetail({
  session,
  channelId,
  threadRootId,
  messages,
}: ChannelThreadAccessoryProps) {
  const activity = useSyncExternalStore(
    session.agentActivity.subscribe,
    session.agentActivity.snapshot,
    session.agentActivity.snapshot,
  );
  const retained = useSyncExternalStore(
    session.channels.subscribeRetained ?? noSubscription,
    session.channels.retained ?? absent,
    session.channels.retained ?? absent,
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const detail = useMemo(
    () =>
      sessionActivityDetail(
        [...retained, ...messages],
        activity,
        channelId,
        threadRootId,
      ),
    [retained, messages, activity, channelId, threadRootId],
  );
  if (!detail.records.length) return null;
  // Empty/reset evidence unmounts disclosure state; same-key records cannot revive it.
  return (
    <Disclosure
      records={detail.records}
      trimmed={detail.trimmed}
      profiles={profiles}
    />
  );
}
function Disclosure({
  records,
  trimmed,
  profiles,
}: {
  records: readonly SessionActivityRecord[];
  trimmed: number;
  profiles: ReturnType<
    ChannelThreadAccessoryProps["session"]["profiles"]["snapshot"]
  >;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const [details, setDetails] = useState<string[]>([]);
  const ids = records.map((record) => record.id);
  const retainedDetails = details.filter((id) => ids.includes(id));
  if (retainedDetails.length !== details.length) setDetails(retainedDetails);
  const agents = [...new Set(records.map((record) => record.turn.agent))];
  return (
    <section className={styles.activity} aria-label="Session agent activity">
      <Accordion
        variant="activity"
        value={expanded}
        onValueChange={setExpanded}
        items={[
          {
            value: "activity",
            title: "Agent activity",
            content: (
              <div className={styles.content}>
                <p className={styles.notice}>
                  Live owner-only observations, not a complete transcript.
                </p>
                {trimmed > 0 && (
                  <p className={styles.notice}>
                    Display limit: {trimmed} matching observations omitted.
                  </p>
                )}
                <div className={styles.observations}>
                  {agents.map((agent) => {
                    const own = records.filter(
                      (record) => record.turn.agent === agent,
                    );
                    const state = own.some(
                      (record) => record.turn.state === "working",
                    )
                      ? "Working"
                      : own.some((record) => record.turn.state === "unknown")
                        ? "Status unknown"
                        : "Observed turn ended";
                    return (
                      <div key={agent} className={styles.agent}>
                        <p className={styles.identity}>
                          <span>
                            {profiles.get(agent)?.name || "Agent"}{" "}
                            <span className={styles.key}>
                              {agent.slice(0, 8)}
                            </span>
                          </span>
                          <span className={styles.notice}>{state}</span>
                        </p>
                        <ul className={styles.entries}>
                          {own.map((record) => (
                            <li key={record.id}>
                              <span className={styles.kind}>{record.kind}</span>
                              <Accordion
                                variant="activity"
                                value={retainedDetails}
                                onValueChange={setDetails}
                                items={[
                                  {
                                    value: record.id,
                                    title: "Details",
                                    content: (
                                      <>
                                        <p className={styles.notice}>
                                          {record.projected
                                            ? "Projected batch child · reserialized JSON, not byte-identical"
                                            : "Original observation JSON"}
                                        </p>
                                        <pre className={styles.raw}>
                                          {record.plaintext}
                                        </pre>
                                      </>
                                    ),
                                  },
                                ]}
                              />
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </div>
            ),
          },
        ]}
      />
    </section>
  );
}
