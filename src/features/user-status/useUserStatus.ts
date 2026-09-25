import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { UserStatuses } from "../relay/user-status";

export function useUserStatus(
  statuses: UserStatuses | undefined,
  userId: string,
) {
  useEffect(() => statuses?.watch([userId]), [statuses, userId]);
  const subscribe = useCallback(
    (listener: () => void) => statuses?.subscribe(listener) ?? (() => {}),
    [statuses],
  );
  const get = useCallback(
    () => statuses?.snapshot().get(userId),
    [statuses, userId],
  );
  return useSyncExternalStore(subscribe, get, get);
}
