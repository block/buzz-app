import { useCallback, useEffect, useRef, useState } from "react";

/** Closing/reopening or retiring the menu invalidates its pending UI completion. */
export function useChannelReadAction() {
  const generation = useRef(0);
  const [state, setState] = useState<{ pending: boolean; error?: string }>();
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const reset = useCallback(() => {
    generation.current++;
    setState(undefined);
  }, []);
  async function run(action: () => Promise<unknown>, completed: () => void) {
    const attempt = generation.current;
    setState({ pending: true });
    try {
      await action();
      if (attempt === generation.current) completed();
    } catch (error) {
      if (attempt === generation.current)
        setState({
          pending: false,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  }
  return { state, reset, run };
}
