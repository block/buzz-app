import {
  useCallback,
  useId,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { LockIcon, RobotIcon } from "../../shared/design-system/icons";
import styles from "./MessageCard.module.css";

/** The frame a message shown inside another message sits in: a forward, or
 * the message a link names. `label` names what kind it is, as "Forwarded"
 * does; `opens` marks a card whose surface opens what it shows. */
export function MessageCard({
  label,
  fill = false,
  opens = false,
  children,
  ...props
}: Omit<ComponentPropsWithoutRef<"section">, "role"> & {
  label?: ReactNode;
  fill?: boolean;
  opens?: boolean;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: This labelled message group is content, not a fieldset of form controls.
    <section
      role="group"
      className={styles.card}
      data-fill={fill || undefined}
      data-opens={opens || undefined}
      {...props}
    >
      {label && <span className="text-label-sm">{label}</span>}
      {children}
    </section>
  );
}

/** A card's time, as a full date. */
export function messageCardTime(date: Date) {
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Avatar, author and time, then the conversation it was sent in, with a
 * lock when that conversation is private. */
export function MessageCardByline({
  avatar,
  author,
  agent = false,
  time,
  source,
  locked,
}: {
  avatar: ReactNode;
  author: ReactNode;
  agent?: boolean;
  time: ReactNode;
  source: ReactNode;
  locked: boolean;
}) {
  return (
    <>
      <div className={styles.byline}>
        {avatar}
        <span className={`${styles.byline} text-label-sm`}>
          {agent && <RobotIcon size={14} aria-label="Agent" />} {author}
        </span>
        <span className="text-body-sm text-subtle">{time}</span>
      </div>
      <span className={`${styles.source} text-body-sm text-subtle`}>
        {locked && <LockIcon size={14} aria-hidden="true" />} {source}
      </span>
    </>
  );
}

/** The message, collapsed past its height limit behind a fade and a button
 * that shows the rest. Focus inside shows it all, so no focused link hides. */
export function MessageCardBody({
  compact = false,
  children,
}: {
  compact?: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  // Collapse by rendered height so wrapped prose and code follow the same limit.
  const [overflows, setOverflows] = useState(false);
  const measureBody = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const measure = () =>
      setOverflows(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <div
        id={contentId}
        className={styles.body}
        data-compact={compact || undefined}
        data-expanded={expanded || undefined}
        data-overflows={overflows || undefined}
        ref={measureBody}
        onFocusCapture={() => setExpanded(true)}
      >
        {children}
      </div>
      {(overflows || expanded) && (
        <Button
          size="inline"
          variant="subtle"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show full message"}
        </Button>
      )}
    </>
  );
}
