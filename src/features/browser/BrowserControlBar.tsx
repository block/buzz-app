import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import type {
  BrowserControl,
  BrowserControlGrant,
  BrowserStatus,
} from "./platform";
import styles from "./BrowserHostView.module.css";

/** Grants last only for this mounted view, even when its guest is parked. */
export function BrowserControlBar({
  control,
  sessionId,
  status,
  agentName,
  eligible = false,
  unavailable = "Choose a local agent in this conversation.",
  picker,
}: {
  control: BrowserControl;
  sessionId: string;
  status?: BrowserStatus;
  agentName?: string | undefined;
  eligible?: boolean;
  unavailable?: string;
  picker?: ReactNode;
}) {
  const [grant, setGrant] = useState<BrowserControlGrant>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  useEffect(() => {
    return () => {
      generation.current++;
      void control.revoke(sessionId).catch(() => undefined);
    };
  }, [control, sessionId]);

  useEffect(() => {
    if (
      grant &&
      !pending &&
      (status?.control_revision ?? -1) >= grant.revision &&
      !status?.control_granted
    ) {
      setGrant(undefined);
      void control.revoke(sessionId).catch(() => undefined);
    }
  }, [grant, pending, status, control, sessionId]);

  useEffect(() => {
    if (!eligible) {
      generation.current++;
      setGrant(undefined);
      setPending(false);
      void control.revoke(sessionId).catch(() => undefined);
    }
  }, [eligible, control, sessionId]);

  async function change(allow: boolean) {
    const current = ++generation.current;
    setPending(true);
    setError(undefined);
    try {
      let next: BrowserControlGrant | undefined;
      if (allow) next = await control.grant(sessionId);
      else await control.revoke(sessionId);
      if (generation.current === current) setGrant(next);
    } catch (failure) {
      if (generation.current === current) setError(String(failure));
    } finally {
      if (generation.current === current) setPending(false);
    }
  }

  return (
    <section className={styles.control} aria-label="Browser agent control">
      {picker}
      <div className={styles.controlActions}>
        <Button
          size="sm"
          variant="subtle"
          disabled={pending || !eligible}
          onClick={() => void change(true)}
        >
          Allow agent control
        </Button>
        <Button size="sm" variant="subtle" onClick={() => void change(false)}>
          Take control
        </Button>
      </div>
      {grant ? (
        <>
          <p className="text-body-sm" role="status">
            Browser shared with {agentName}
          </p>
          <p className="text-body-sm">
            Take control stops new actions; it cannot undo actions already sent.
            Allow again after hiding this browser.
          </p>
        </>
      ) : (
        <p className="text-body-sm">
          {eligible
            ? `Allow ${agentName} to read and use this browser in this conversation.`
            : unavailable}
        </p>
      )}
      {error ? (
        <p className="text-body-sm" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
