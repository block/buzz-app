import type { ReactNode } from "react";
import { ClipboardTextIcon } from "../../shared/design-system/icons";
import styles from "../../shared/InlineReference.module.css";
import {
  sessionReferenceTarget,
  sessionReferenceTitle,
} from "./session-reference";

/** Inert shared artwork; the editor or message anchor owns all interaction. */
export function SessionReferenceLabel({
  href,
  label,
  fallback = null,
}: {
  href: string;
  label: string;
  fallback?: ReactNode;
}) {
  const title = sessionReferenceTitle(href, label);
  const rootId =
    title === undefined
      ? undefined
      : sessionReferenceTarget(href)?.threadRootId;
  if (!rootId) return fallback;
  return (
    <span
      data-buzz-ui
      data-link-kind="session"
      className={styles.session}
      title={`Session · ${rootId}: ${title}`}
    >
      <span className={styles.sessionIcon}>
        <ClipboardTextIcon size={16} aria-hidden="true" />
      </span>
      <span className={styles.sessionLabel}>
        Session · {rootId.slice(0, 8)}
      </span>
      <span className={styles.sessionTitle}>{title}</span>
    </span>
  );
}
