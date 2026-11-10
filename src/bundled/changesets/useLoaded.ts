import { useEffect, useReducer, useState } from "react";

type Loaded<T> = { value?: T; error?: string };

/** Runs `load` again whenever `deps` change, and on `retry`. Without a `load`
 * there is nothing to read. */
export function useLoaded<T>(
  load: (() => Promise<T>) | undefined,
  deps: readonly unknown[],
) {
  const [attempt, retry] = useReducer((count: number) => count + 1, 0);
  const [state, setState] = useState<Loaded<T>>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: Callers list what `load` reads.
  useEffect(() => {
    setState({});
    if (!load) return;
    let live = true;
    load().then(
      (value) => live && setState({ value }),
      (error) =>
        live &&
        setState({
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return () => {
      live = false;
    };
  }, [...deps, attempt]);
  return { ...state, retry };
}
