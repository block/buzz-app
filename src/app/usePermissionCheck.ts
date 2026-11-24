import { useState } from "react";

// A native read often returns the state already shown before the next paint.
// Hold loading briefly so an explicit check is visibly acknowledged.
const MINIMUM_CHECK_MS = 500;

export function usePermissionCheck<Result>(
  check: () => Promise<Result>,
  onComplete?: (result: Result) => void,
) {
  const [checking, setChecking] = useState(false);
  const run = () => {
    setChecking(true);
    void Promise.all([
      check(),
      new Promise((resolve) => setTimeout(resolve, MINIMUM_CHECK_MS)),
    ])
      .then(([result]) => onComplete?.(result))
      .finally(() => setChecking(false));
  };
  return [checking, run] as const;
}
