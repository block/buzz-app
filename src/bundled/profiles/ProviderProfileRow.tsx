import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RelaySession } from "../../features/relay/session";
import { resolveProviderProfile } from "./provider-profile";
import { profileTarget } from "../../features/profiles/target";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import styles from "./ProviderProfileRow.module.css";
import { CaretRightIcon } from "../../shared/design-system/icons";

/** Resolve provider identities against this community, never display-name guesses. */
export function ProviderProfileRow({
  title,
  value,
  username,
  session,
  open,
  children,
  className,
}: {
  children?: ReactNode;
  className?: string | undefined;
  title: string;
  value: string;
  username: string;
  session: RelaySession;
  open: (target: string) => unknown;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const active = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => active.current?.abort(), []);
  const visit = async () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError(undefined);
    try {
      const pubkey = await resolveProviderProfile(
        session,
        username,
        controller.signal,
      );
      const target = profileTarget(pubkey);
      if (!target) throw new Error("Invalid profile identity");
      open(target);
    } catch {
      if (!controller.signal.aborted)
        setError("Profile unavailable in this community");
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  };
  return (
    <div className={className ? styles.custom : undefined}>
      <div className={`${styles.row} ${className ?? ""}`}>
        {children ?? (
          <PreferenceRow
            title={title}
            subtitle={
              <span className="text-body-sm text-secondary">{value}</span>
            }
            trailing={<CaretRightIcon size={16} />}
          />
        )}
        <button
          type="button"
          className={styles.open}
          disabled={pending}
          onClick={() => void visit()}
          aria-label={`Open ${value}’s profile`}
        />
      </div>
      {error && (
        <p role="status" className="text-body-sm text-secondary">
          {error}
        </p>
      )}
    </div>
  );
}
