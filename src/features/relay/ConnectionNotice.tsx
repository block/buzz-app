import { useEffect, useRef, useState } from "react";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { RECOVERY_NOTICE_DELAY_MS } from "./recovery";
import { RECOVERY_TITLE, useRecovery } from "./RecoveryNotice";
import type { RelaySnapshot } from "./service";

type Connection = Pick<
  RelaySnapshot,
  "status" | "cached" | "retrying" | "session"
>;

/** True while the connection itself is in trouble in a way that clears without
 * anyone acting: the community connection failed and is retrying, or the app
 * runs from its saved copy (cached/offline), where every attempt that has not
 * yet failed again is "connecting". A denial or a failure the service does not
 * retry is not trouble here; the surface that shows it owns its Try again. */
export function connectionInTrouble(
  connection: Pick<RelaySnapshot, "status" | "cached" | "retrying">,
) {
  return (
    (connection.status === "error" && !!connection.retrying) ||
    (!!connection.cached && connection.status === "connecting")
  );
}

/** True while a connection attempt is under way. Between two failed attempts
 * the status reads "connecting", which must not restart the quiet delay. */
function connectionAttempting(connection: Pick<RelaySnapshot, "status">) {
  return connection.status === "connecting";
}

/** True once the connection has been in trouble for `delay` without a break.
 * It stays true through the attempts between failures and clears as soon as
 * the connection is ready, denied or disconnected. */
export function useConnectionTrouble(
  connection: Pick<RelaySnapshot, "status" | "cached" | "retrying">,
  delay = RECOVERY_NOTICE_DELAY_MS,
) {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const trouble = connectionInTrouble(connection);
  const attempting = connectionAttempting(connection);
  useEffect(() => {
    if (trouble) {
      timer.current ??= setTimeout(() => setShown(true), delay);
      return;
    }
    if (attempting) return;
    clearTimeout(timer.current);
    timer.current = undefined;
    setShown(false);
  }, [trouble, attempting, delay]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      timer.current = undefined;
    },
    [],
  );
  return shown;
}

/** The one notice for a connection that is not working, on every page. It
 * covers the community connection (cached/offline mode, a failing connect)
 * and, once connected, the failed reads recovery retries. Both feed one
 * toast, so it is never shown twice, and it clears when the connection is
 * back. Recovery retries on its own, so it offers no button. */
export function ConnectionNotice({ connection }: { connection: Connection }) {
  const { shown: recovering } = useRecovery(connection.session?.recovery);
  const disconnected = useConnectionTrouble(connection);
  if (!recovering && !disconnected) return null;
  return (
    <ToastNotice
      title={RECOVERY_TITLE}
      description="Retrying automatically."
      tone="info"
    />
  );
}
