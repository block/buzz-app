import {
  Children,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
  type Ref,
} from "react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { CaretUpIcon } from "../../shared/design-system/icons";
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
}) {
  const ownTrigger = useRef<HTMLButtonElement>(null);
  const button = trigger ?? ownTrigger;
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    // The summary and icon replace one another when expansion changes.
    void expanded;
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    button.current?.focus({ preventScroll: true });
  }, [expanded, button]);
  const toggle = () => {
    if (!interactive) return;
    restoreFocus.current = true;
    onToggle();
  };
  return (
    <div
      ref={container}
      className={styles.standaloneActivity}
      data-contained-history=""
    >
      <div
        className={styles.activityGroupHeader}
        data-expanded={expanded || undefined}
      >
        {expanded ? (
          <>
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
            <IconButton
              ref={button}
              data-activity-summary=""
              aria-expanded
              aria-label={label}
              title="Collapse activity history"
              tabIndex={interactive ? undefined : -1}
              icon={<CaretUpIcon aria-hidden="true" />}
              onClick={toggle}
            />
          </>
        ) : (
          <div className={styles.audienceRow}>
            <div className={styles.audienceEntry}>
              <button
                ref={button}
                type="button"
                data-buzz-ui=""
                data-activity-summary=""
                className={styles.audienceLine}
                aria-expanded={false}
                aria-label={label}
                tabIndex={interactive ? undefined : -1}
                onClick={toggle}
              >
                {icon}
                <span className={styles.audiencePreviewText}>{summary}</span>
              </button>
            </div>
          </div>
        )}
        {actions && (
          <div
            hidden={!expanded}
            className={expanded ? "flex basis-full justify-end" : undefined}
          >
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
