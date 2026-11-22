import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComposerAccessoryProps } from "../../features/conversation/contracts";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import type {
  ProviderUsageSnapshot,
  RunUsage,
  UsageAllowance,
} from "../../features/agents/live-usage";
import { activityTranscript } from "../../features/agents/activity-transcript";
import { useChannelActivitySnapshot } from "../../features/agents/use-channel-agent-activity";
import { useAgents } from "../../features/agents/react";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./UsageMeterAccessory.module.css";

const STALE_MS = 10 * 60 * 1000;

type Props = ComposerAccessoryProps & { agents: Agents };
type Selection = Readonly<{
  agent: Agent;
  type: RegisteredAgentType;
  turnId: string;
  state: string;
  timestamp: number;
  run?: RunUsage;
}>;

const compactNumber = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

const percent = (value: number) => `${Math.round(value)}%`;

export function allowanceRemaining(allowance: UsageAllowance) {
  return allowance.usedPercent === undefined
    ? undefined
    : Math.max(0, 100 - allowance.usedPercent);
}

export function resetLabel(resetsAt: number | undefined, now = Date.now()) {
  if (resetsAt === undefined) return undefined;
  const remaining = resetsAt - now;
  if (remaining <= 0) return "reset due";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `resets in ${hours}h`;
  return `resets in ${Math.ceil(hours / 24)}d`;
}

function selectedUsage(
  props: Props,
  activity: ReturnType<typeof useChannelActivitySnapshot>,
  agentList: readonly Agent[],
  types: readonly RegisteredAgentType[],
): Selection | undefined {
  const turns = (activity?.turns ?? [])
    .filter(
      (turn) =>
        turn.channelId === props.channelId &&
        (props.threadRootId
          ? turn.threadRootId === props.threadRootId
          : !turn.threadRootId),
    )
    .sort((a, b) => b.timestamp - a.timestamp);
  for (const turn of turns) {
    const agent = agentList.find(
      (candidate) => candidate.pubkey === turn.agent,
    );
    const type =
      agent && types.find((candidate) => candidate.key === agent.type);
    if (!agent || !type?.liveUsage || agent.place !== "here") continue;
    const transcript = activity
      ? activityTranscript(activity.records, {
          agent: turn.agent,
          channelId: props.channelId,
        }).turns.find((candidate) => candidate.turnId === turn.turnId)
      : undefined;
    return {
      agent,
      type,
      turnId: turn.turnId,
      state: turn.state,
      timestamp: turn.timestamp,
      ...(transcript?.context
        ? {
            run: {
              contextUsed: transcript.context.used,
              contextSize: transcript.context.size,
            },
          }
        : {}),
    };
  }
  const local = (activity?.local ?? [])
    .filter(
      (work) =>
        work.channelId === props.channelId &&
        (props.threadRootId
          ? work.threadRootId === props.threadRootId
          : !work.thread),
    )
    .sort((a, b) => b.startedAt - a.startedAt);
  for (const work of local) {
    const agent = agentList.find(
      (candidate) => candidate.pubkey === work.agent,
    );
    const type =
      agent && types.find((candidate) => candidate.key === agent.type);
    if (!agent || !type?.liveUsage || agent.place !== "here") continue;
    return {
      agent,
      type,
      turnId: work.messageId,
      state: work.state,
      timestamp: work.startedAt,
    };
  }
  return undefined;
}

/** Native provider allowance and current-context status for the most recent
 * local agent in this exact conversation. The provider read never sends a
 * model turn; raw activity supplies only ACP's allowlisted context counts. */
export function UsageMeterAccessory(props: Props) {
  const activity = useChannelActivitySnapshot(
    props.session.agentActivity,
    props.channelId,
  );
  const { snapshot: agentsSnapshot, types } = useAgents(props.agents);
  const selected = useMemo(
    () => selectedUsage(props, activity, agentsSnapshot.running, types),
    [props, activity, agentsSnapshot.running, types],
  );
  const [provider, setProvider] = useState<ProviderUsageSnapshot>();
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((value) => value + 1), []);

  const reader = selected?.type.liveUsage;
  const agent = selected?.agent;
  const turnRefreshKey = selected
    ? `${selected.turnId}:${selected.state}:${selected.timestamp}`
    : undefined;
  const requestKey = turnRefreshKey && `${turnRefreshKey}:${refresh}`;
  useEffect(() => {
    if (!reader || !agent || !requestKey) {
      setProvider(undefined);
      setFailed(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    reader(agent, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setProvider(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reader, agent, requestKey]);

  const nextReset = provider?.allowances
    .map((allowance) => allowance.resetsAt)
    .filter(
      (value): value is number => value !== undefined && value > Date.now(),
    )
    .sort((a, b) => a - b)[0];
  useEffect(() => {
    if (nextReset === undefined) return;
    const delay = Math.min(
      Math.max(nextReset - Date.now() + 1000, 1000),
      2_147_000_000,
    );
    const timer = window.setTimeout(reload, delay);
    return () => window.clearTimeout(timer);
  }, [nextReset, reload]);

  if (!selected) return null;
  return (
    <UsageMeterView
      agentName={selected.agent.name}
      provider={provider}
      run={selected.run}
      failed={failed}
      loading={loading}
      onRefresh={reload}
    />
  );
}

export function UsageMeterView({
  agentName,
  provider,
  run,
  failed,
  loading,
  onRefresh,
}: Readonly<{
  agentName: string;
  provider: ProviderUsageSnapshot | undefined;
  run: RunUsage | undefined;
  failed: boolean;
  loading: boolean;
  onRefresh(): void;
}>) {
  const now = Date.now();
  const contextPercent =
    run?.contextUsed !== undefined &&
    run.contextSize !== undefined &&
    run.contextSize > 0
      ? Math.min(100, (run.contextUsed / run.contextSize) * 100)
      : undefined;
  const primary = provider?.allowances[0];
  const remaining = primary && allowanceRemaining(primary);
  const stale =
    failed ||
    (provider !== undefined &&
      (provider.freshness === "stale" ||
        now - provider.observedAt >= STALE_MS));
  const freshness = failed
    ? "Unavailable"
    : provider?.freshness === "unavailable"
      ? "Limited"
      : stale
        ? "Stale"
        : provider
          ? "Live"
          : "Loading";
  return (
    <details className={styles.root}>
      <summary className={styles.summary}>
        <span className={styles.title}>{provider?.provider ?? agentName}</span>
        {contextPercent !== undefined && (
          <span>{percent(contextPercent)} context</span>
        )}
        {provider?.account?.plan && <span>{provider.account.plan}</span>}
        {remaining !== undefined && <span>{percent(remaining)} remaining</span>}
        {primary?.resetsAt && <span>{resetLabel(primary.resetsAt, now)}</span>}
        <span className={stale ? styles.warning : styles.detail}>
          {freshness}
        </span>
      </summary>
      <div className={styles.panel}>
        {contextPercent !== undefined && (
          <Meter
            label="Context"
            value={contextPercent}
            detail={`${compactNumber.format(run?.contextUsed ?? 0)} of ${compactNumber.format(run?.contextSize ?? 0)} tokens`}
          />
        )}
        {provider?.allowances.map((allowance) => (
          <Meter
            key={allowance.id}
            label={allowance.label}
            value={allowance.usedPercent}
            detail={resetLabel(allowance.resetsAt, now)}
          />
        ))}
        <div className={styles.facts}>
          <span>Account</span>
          <span>
            {provider?.account?.state === "signed-in"
              ? (provider.account.plan ?? "Signed in")
              : provider?.account?.state === "signed-out"
                ? "Signed out"
                : "Unknown"}
          </span>
          {provider?.credits && (
            <>
              <span>Credits</span>
              <span>
                {provider.credits.unlimited
                  ? "Unlimited"
                  : (provider.credits.balance ?? "Unknown")}
              </span>
            </>
          )}
        </div>
        {(provider?.reason || failed) && (
          <p className={styles.notice}>
            {failed ? "Usage could not be refreshed." : provider?.reason}
          </p>
        )}
        <Button
          size="caption"
          variant="subtle"
          loading={loading}
          onClick={onRefresh}
        >
          Refresh usage
        </Button>
      </div>
    </details>
  );
}

function Meter({
  label,
  value,
  detail,
}: Readonly<{
  label: string;
  value: number | undefined;
  detail: string | undefined;
}>) {
  return (
    <div className={styles.meter}>
      <div className={styles.meterLabel}>
        <span>{label}</span>
        <span>
          {value === undefined ? "Unknown" : `${percent(value)} used`}
        </span>
      </div>
      {value !== undefined && (
        <div
          className={styles.track}
          role="progressbar"
          aria-label={`${label} used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(value)}
        >
          <span className={styles.fill} style={{ width: `${value}%` }} />
        </div>
      )}
      {detail && <span className={styles.detail}>{detail}</span>}
    </div>
  );
}
