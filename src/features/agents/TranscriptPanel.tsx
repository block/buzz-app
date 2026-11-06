import {
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { ArrowsClockwiseIcon } from "../../shared/design-system/icons";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import activityStyles from "./ActivityLayout.module.css";
import { ActivityTranscript } from "./ActivityTranscript";
import type { Transcript } from "./activity-transcript";
import { AgentsContext } from "./react";
import type { AgentViewProps } from "./service";

/** How often an open transcript is read again while its agent works. */
export const LIVE_READ_MS = 2500;

type Shown<T> = Readonly<{
  key: string;
  /** null: the agent type has no transcript for it. */
  transcript?: T | null;
  error?: string;
}>;

/** `read` for `key`: on open, on `refresh`, when `working` changes, every
 * {@link LIVE_READ_MS} while working and the window shows, and on each step
 * the agent reports. One read runs at a time; asking during one reads once
 * more after it. The last result stays while the next is read, never another
 * key's. */
export function useLiveTranscript<T>(
  read: (signal: AbortSignal) => Promise<T | undefined>,
  key: string,
  working: boolean,
  agentKey: string,
) {
  const agents = useContext(AgentsContext);
  const [shown, setShown] = useState<Shown<T>>({ key });
  const [loading, setLoading] = useState(true);
  const latest = useRef({ read, key });
  latest.current = { read, key };
  const running = useRef<{ key: string; abort: AbortController } | undefined>(
    undefined,
  );
  const again = useRef(false);
  const request = useCallback(() => {
    const { read, key } = latest.current;
    if (running.current?.key === key) {
      again.current = true;
      return;
    }
    running.current?.abort.abort();
    const abort = new AbortController();
    running.current = { key, abort };
    again.current = false;
    setLoading(true);
    const settle = (next: Omit<Shown<T>, "key">) => {
      if (abort.signal.aborted) return;
      running.current = undefined;
      setShown(
        (prior): Shown<T> =>
          next.error !== undefined && prior.key === key
            ? { ...prior, error: next.error }
            : { key, ...next },
      );
      if (again.current) request();
      else setLoading(false);
    };
    read(abort.signal).then(
      (transcript) => settle({ transcript: transcript ?? null }),
      (error: unknown) =>
        settle({
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new key or a turn starting or ending reads again.
  useEffect(request, [key, working]);
  useEffect(
    () => () => {
      running.current?.abort.abort();
      running.current = undefined;
    },
    [],
  );
  useEffect(() => {
    if (!working) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const schedule = () => {
      clearInterval(timer);
      timer = document.hidden ? undefined : setInterval(request, LIVE_READ_MS);
    };
    const shows = () => {
      if (!document.hidden) request();
      schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", shows);
    const stopSteps = agents?.subscribeSteps(agentKey, () => {
      if (!document.hidden) request();
    });
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", shows);
      stopSteps?.();
    };
  }, [working, agents, agentKey, request]);
  return {
    shown: shown.key === key ? shown : ({ key } as Shown<T>),
    loading,
    refresh: request,
  };
}

/** One conversation's transcript as an agent type reads it, kept current
 * while the agent works, under a header whose Refresh stays in view. */
export function TranscriptPanel<T extends Transcript>({
  agent,
  read,
  readKey,
  working,
  reading,
  missing,
  failed,
  notes,
}: {
  agent: AgentViewProps["agent"];
  /** The agent type's read; resolves undefined when it has no transcript. */
  read: (signal: AbortSignal) => Promise<T | undefined>;
  /** What `read` reads; another key never shows this one's result. */
  readKey: string;
  working: boolean;
  /** Shown before the first read settles. */
  reading: string;
  /** Shown when the agent type has no transcript for it. */
  missing: ReactNode;
  /** Leads the error, as "Could not read the … session". */
  failed: string;
  /** Shown above the oldest loaded turn. */
  notes?: (transcript: T) => ReactNode;
}) {
  const { shown, loading, refresh } = useLiveTranscript(
    read,
    readKey,
    working,
    agent.key,
  );
  const { transcript, error } = shown;
  return (
    <div className={activityStyles.transcript}>
      <div className={activityStyles.transcriptHeader}>
        <InlineHeader
          title="Transcript"
          actions={
            <IconButton
              hint="familiar"
              aria-label="Refresh transcript"
              title="Refresh transcript"
              loading={loading}
              onClick={refresh}
              icon={<ArrowsClockwiseIcon size="1rem" aria-hidden="true" />}
            />
          }
        />
      </div>
      {transcript !== undefined && loading && (
        <span role="status" className="sr-only">
          Refreshing transcript…
        </span>
      )}
      {error !== undefined && (
        <p role="alert" className="m-0">
          {failed}: {error}
        </p>
      )}
      {transcript ? (
        <ActivityTranscript
          transcript={transcript}
          agentName={agent.name}
          agentKey={agent.key}
          agentPicture={agent.picture}
          community={agent.relay}
          state={() => (working ? "working" : undefined)}
          before={notes?.(transcript)}
        />
      ) : transcript === null ? (
        missing
      ) : (
        error === undefined && (
          <p role="status" className="m-0">
            {reading}
          </p>
        )
      )}
    </div>
  );
}
