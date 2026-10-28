import { useEffect, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Input } from "../../shared/design-system/ui/Input";
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
}: {
  control: BrowserControl;
  sessionId: string;
  status?: BrowserStatus;
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
      (status?.control_revision ?? -1) >= grant.revision &&
      !status?.control_granted
    )
      setGrant(undefined);
  }, [grant, status]);

  async function change(allow: boolean) {
    const current = ++generation.current;
    setPending(true);
    setError(undefined);
    try {
      let next: BrowserControlGrant | undefined;
      if (allow) next = await control.grant(sessionId);
      else await control.revoke(sessionId);
      if (generation.current === current) setGrant(next);
      else if (allow) await control.revoke(sessionId);
    } catch (failure) {
      if (generation.current === current) setError(String(failure));
    } finally {
      if (generation.current === current) setPending(false);
    }
  }

  return (
    <section className={styles.control} aria-label="Browser agent control">
      <div className={styles.controlActions}>
        <Button
          size="sm"
          variant="subtle"
          disabled={pending}
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
          <Input
            aria-label="Browser control token"
            value={grant.token}
            readOnly
          />
          <p className="text-body-sm">
            Share this token with your agent in a private chat. Take control
            stops new actions; it cannot undo actions already sent. Allow again
            after hiding this browser.
          </p>
        </>
      ) : (
        <p className="text-body-sm">
          Agent control is off. Allow it only for a browser you want your agent
          to read and use.
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
