import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  type CommunityCounts,
  CountsUnavailable,
  installCount,
  readCounts,
  upvoteCount,
  VOTE_TYPE,
  withRecord,
  writeRecord,
} from "./community-counts";
import type { Recorder } from "./recorder";

export type CountsState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "unavailable"; message: string }>
  | Readonly<{ status: "ready"; counts: CommunityCounts }>;

const noRelay = {
  subscribe: () => () => {},
  snapshot: () => undefined,
};

/** The selected community's plugin counts, by plugin id, and the viewer's
 * upvotes. The recorder keeps the viewer's install records. */
export function useCommunityCounts(
  relay: RelayData | undefined,
  recorder: Recorder | undefined,
  version: number,
) {
  const snapshot = useSyncExternalStore(
    relay?.subscribe ?? noRelay.subscribe,
    relay?.snapshot ?? noRelay.snapshot,
  );
  const session: RelaySession | undefined =
    snapshot?.status === "ready" ? snapshot.session : undefined;
  const [state, setState] = useState<CountsState>({ status: "loading" });
  const [recording, setRecording] = useState(
    () => recorder?.recording() ?? false,
  );
  const [written, setWritten] = useState(0);
  const [failed, setFailed] = useState(false);
  const writes = useRef(0);
  const latest = useRef<{
    session?: RelaySession | undefined;
    counts?: CommunityCounts | undefined;
  }>({});

  const show = useCallback((counts: CommunityCounts) => {
    latest.current.counts = counts;
    setState({ status: "ready", counts });
  }, []);

  useEffect(
    () => recorder?.subscribe(() => setWritten((count) => count + 1)),
    [recorder],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: A new version or recorder write reads the counts again.
  useEffect(() => {
    if (latest.current.session !== session) latest.current = { session };
    if (!session) {
      setState({
        status: "unavailable",
        message: "Plugin counts appear once Buzz is connected to a community.",
      });
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    if (!latest.current.counts) setState({ status: "loading" });
    const started = writes.current;
    void (async () => {
      try {
        const counts = await readCounts(session, signal);
        if (signal.aborted || latest.current.session !== session) return;
        // A vote finished while this read was out; read again past it.
        if (writes.current !== started) {
          setWritten((count) => count + 1);
          return;
        }
        recorder?.sawChannel(counts.channel);
        show(counts);
      } catch (error) {
        if (signal.aborted || latest.current.counts) return;
        setState({
          status: "unavailable",
          message:
            error instanceof CountsUnavailable
              ? error.message
              : "Buzz couldn't read this community's plugin counts.",
        });
      }
    })();
    return () => controller.abort();
  }, [session, show, version, written]);

  useEffect(() => {
    if (version) void recorder?.sync().catch(() => {});
  }, [recorder, version]);

  const vote = useCallback(
    async (id: string, on: boolean) => {
      const { session: current, counts } = latest.current;
      if (!recorder || !current || !counts) return false;
      try {
        const wrote = await recorder.write(async (session) => {
          if (session !== current) return false;
          await writeRecord(current, counts.channel, VOTE_TYPE, id, on);
          return true;
        });
        if (!wrote) return false;
      } catch {
        return false;
      } finally {
        writes.current++;
      }
      if (latest.current.session !== current) return false;
      show(withRecord(latest.current.counts ?? counts, VOTE_TYPE, id, on));
      return true;
    },
    [recorder, show],
  );

  /** Turning recording off withdraws every install and upvote the viewer
   * recorded here; turning it on records what is installed again. */
  const changeRecording = useCallback(
    async (on: boolean) => {
      setRecording(on);
      setFailed(false);
      try {
        await recorder?.setRecording(on);
      } catch {
        setFailed(true);
      }
    },
    [recorder],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: Each community keeps its own choice.
  useEffect(() => {
    setRecording(recorder?.recording() ?? false);
    setFailed(false);
  }, [recorder, session]);

  const counts = state.status === "ready" ? state.counts : undefined;
  return {
    state,
    session,
    recording,
    /** The last recording change didn't finish; it is retried. */
    failed,
    changeRecording,
    vote,
    installs: (id: string) => installCount(counts?.tally, id),
    upvotes: (id: string) => upvoteCount(counts?.tally, id),
    installers: (id: string) => [...(counts?.tally.installers.get(id) ?? [])],
    voted: (id: string) => !!counts?.myVotes.has(id),
    mine: (id: string) => !!counts?.myInstalls.has(id),
  };
}

export type CommunityCountsView = ReturnType<typeof useCommunityCounts>;
