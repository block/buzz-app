import { useCallback, useEffect, useRef, useState } from "react";
import type { ChannelQueries } from "../relay/contracts";

/** After its segment lands, a jump must reveal its row within this time. */
const DISPLAY_DEADLINE = 5_000;

type Target = Readonly<{ messageId: string; signal: AbortSignal }>;

/**
 * One date jump at a time: each jump aborts the last. A located row becomes the
 * reveal target until the next jump or `cancel`. A failed seek, a seek without a
 * row, or a reveal that misses the deadline calls `onError`; aborts are silent.
 */
export function useDateJump(
  channels: ChannelQueries,
  channelId: string,
  onError: () => void,
) {
  const [state, setState] = useState<{ pending: boolean; target?: Target }>({
    pending: false,
  });
  const current = useRef<
    { controller: AbortController; deadline?: number } | undefined
  >(undefined);
  const report = useRef(onError);
  report.current = onError;
  const stop = useCallback(() => {
    const jump = current.current;
    current.current = undefined;
    if (!jump) return;
    clearTimeout(jump.deadline);
    jump.controller.abort();
  }, []);
  useEffect(() => stop, [stop]);
  const jump = useCallback(
    (from: number) => {
      const seek = channels.seek;
      if (!seek) return;
      stop();
      const controller = new AbortController();
      const jump: { controller: AbortController; deadline?: number } = {
        controller,
      };
      current.current = jump;
      setState({ pending: true });
      const fail = () => {
        if (current.current !== jump) return;
        stop();
        setState({ pending: false });
        report.current();
      };
      seek(channelId, from, controller.signal).then(
        (messageId) => {
          if (current.current !== jump) return;
          if (!messageId) return fail();
          jump.deadline = window.setTimeout(fail, DISPLAY_DEADLINE);
          setState({
            pending: false,
            target: { messageId, signal: controller.signal },
          });
        },
        () => fail(),
      );
    },
    [channels, channelId, stop],
  );
  const revealed = useCallback(() => {
    clearTimeout(current.current?.deadline);
  }, []);
  const cancel = useCallback(() => {
    if (!current.current) return;
    stop();
    setState({ pending: false });
  }, [stop]);
  return {
    jump,
    cancel,
    revealed,
    pending: state.pending,
    target: state.target,
  };
}
