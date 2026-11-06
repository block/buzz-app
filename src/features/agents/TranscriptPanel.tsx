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
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
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

/** `read` for `key`: on open, on `refresh`, when `again` or `working`
 * changes, every {@link LIVE_READ_MS} while working, and on each step the
 * agent reports. Automatic reads wait while the window is hidden and run once
 * it shows. One read runs at a time; asking during one reads once more after
 * it, and a change of `again` replaces it. The last result for `key` stays
 * while the next is read, never another key's. */
export function useLiveTranscript<T>(
  read: (signal: AbortSignal) => Promise<T | undefined>,
  key: string,
  again: string,
  working: boolean,
  agentKey: string,
) {
  const agents = useContext(AgentsContext);
  const [shown, setShown] = useState<Shown<T>>({ key });
  const [loading, setLoading] = useState(true);
  const latest = useRef({ read, key, again });
  latest.current = { read, key, again };
  const running = useRef<
    { key: string; again: string; abort: AbortController } | undefined
  >(undefined);
  /** Asked for during the running read. */
  const queued = useRef(false);
  /** Asked for while the window was hidden. */
  const owed = useRef(false);
  /** Starts a read, or queues one; `auto` waits for the window to show.
   * Returns whether a read started. */
  const request = useCallback((auto: boolean): boolean => {
    if (auto && document.hidden) {
      owed.current = true;
      return false;
    }
    const { read, key, again } = latest.current;
    const current = running.current;
    if (current?.key === key && current.again === again) {
      queued.current = true;
      return false;
    }
    current?.abort.abort();
    const abort = new AbortController();
    running.current = { key, again, abort };
    queued.current = false;
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
      if (!(queued.current && request(true))) setLoading(false);
    };
    read(abort.signal).then(
      (transcript) => settle({ transcript: transcript ?? null }),
      (error: unknown) =>
        settle({
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return true;
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new key, new read inputs, or a turn starting or ending reads again.
  useEffect(() => void request(true), [key, again, working]);
  useEffect(() => {
    const shows = () => {
      if (document.hidden || !owed.current) return;
      owed.current = false;
      request(true);
    };
    document.addEventListener("visibilitychange", shows);
    return () => {
      document.removeEventListener("visibilitychange", shows);
      running.current?.abort.abort();
      running.current = undefined;
    };
  }, [request]);
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => request(true), LIVE_READ_MS);
    const stopSteps = agents?.subscribeSteps(agentKey, () => request(true));
    return () => {
      clearInterval(timer);
      stopSteps?.();
    };
  }, [working, agents, agentKey, request]);
  return {
    shown: shown.key === key ? shown : ({ key } as Shown<T>),
    loading,
    refresh: () => void request(false),
  };
}

/** One conversation's transcript as an agent type reads it, kept current
 * while the agent works, under a header whose Refresh stays in view. */
export function TranscriptPanel<T extends Transcript>({
  agent,
  read,
  readKey,
  readAgain = "",
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
  /** Inputs that only make `read` read again, keeping what it shows. */
  readAgain?: string;
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
    readAgain,
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
              onClick={refresh}
              icon={<ArrowsClockwiseIcon size="1rem" aria-hidden="true" />}
            />
          }
        />
      </div>
      <LoadingRegion
        pending={loading}
        label={transcript === undefined ? reading : "Refreshing transcript…"}
        statusVisibility={
          transcript === undefined ? "visible" : "screen-reader"
        }
        feedback={
          error !== undefined && (
            <p role="alert" className="m-0">
              {failed}: {error}
            </p>
          )
        }
      >
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
        ) : (
          transcript === null && missing
        )}
      </LoadingRegion>
    </div>
  );
}
