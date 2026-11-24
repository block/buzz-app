import { Children, type ReactNode, type RefObject, type Ref } from "react";
import { CaretDownIcon, CaretUpIcon } from "../../shared/design-system/icons";
import styles from "./Messages.module.css";

/** The conversation's existing activity disclosure, shared by history and outcomes. */
export function ActivityDisclosure({
  expanded,
  onToggle,
  label,
  summary,
  icon,
  children,
  actions,
  trigger,
  container,
  interactive = true,
  expandedSummary,
  coordination = false,
}: {
  expanded: boolean;
  onToggle: () => void;
  label: string;
  summary: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  trigger?: RefObject<HTMLButtonElement | null> | undefined;
  container?: Ref<HTMLDivElement> | undefined;
  interactive?: boolean;
  expandedSummary?: ReactNode;
  coordination?: boolean;
}) {
  return (
    <div
      ref={container}
      className={styles.standaloneActivity}
      data-contained-history=""
    >
      <div
        className={styles.activityGroupHeader}
        data-expanded={expanded || undefined}
        data-coordination={coordination || undefined}
      >
        <div
          className={styles.audienceRow}
          data-collapse={expanded || undefined}
        >
          <div className={styles.audienceEntry}>
            <button
              ref={trigger}
              type="button"
              data-buzz-ui=""
              data-activity-summary=""
              className={styles.audienceLine}
              data-collapse={expanded || undefined}
              aria-expanded={expanded}
              aria-label={label}
              tabIndex={interactive ? undefined : -1}
              onClick={(event) => {
                if (!interactive) return;
                // One persistent header keeps pointer and keyboard focus in place.
                event.currentTarget.focus({ preventScroll: true });
                onToggle();
              }}
            >
              {expanded ? (
                <CaretUpIcon size={16} aria-hidden="true" />
              ) : coordination ? (
                <CaretDownIcon size={16} aria-hidden="true" />
              ) : (
                icon
              )}
              <span className={styles.audiencePreviewText}>
                {expanded ? "Collapse" : summary}
              </span>
            </button>
          </div>
        </div>
        {actions && <div hidden={!expanded}>{actions}</div>}
      </div>
      {expanded && (
        <div
          className={styles.containedActivityHistory}
          data-activity-details=""
        >
          {Children.toArray(expandedSummary).length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {expandedSummary}
            </div>
          )}
          {children}
        </div>
      )}
    </div>
  );
}
