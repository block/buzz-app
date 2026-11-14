import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ConversationListToggle,
  ConversationListVisibility,
} from "../../features/conversation/ConversationListToggle";
import { ResizableSidebar } from "../../features/channel-navigation/ResizableSidebar";
import type { ListColumn as ListColumnState } from "./list-column";
import styles from "./ListColumn.module.css";

/**
 * The shell's list column: a section's full list beside the page. The page
 * stays mounted whether or not the list shows, and page headers reach the
 * toggle through ConversationListVisibility.
 */
export function ListColumn({
  scope,
  list,
  setOpen,
  title,
  label = title,
  fill,
  content,
  children,
}: {
  /** Community/viewer workspace whose saved list width applies. */
  scope: string;
  /** Unset on pages that list no conversations: only the page renders. */
  list: ListColumnState | undefined;
  setOpen(open: boolean, animate?: boolean): void;
  title: string;
  /** Names the list and its page together. */
  label?: string | undefined;
  /** Nothing is selected: a narrow window gives the list the whole width. */
  fill: boolean;
  content: ReactNode;
  children: ReactNode;
}) {
  const controls = useId();
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  const page = useRef<HTMLElement>(null);
  const motion = useRef<Animation | null>(null);
  const prior = useRef<
    { open: boolean; left: number; narrow: boolean } | undefined
  >(undefined);
  const open = !!list?.open;
  const animate = !!list?.animate;
  // Follow the available width, including sidebar changes and enlarged text.
  useLayoutEffect(() => {
    if (!frame) return;
    const measure = () => {
      if (!frame.clientWidth) return;
      if (
        prior.current &&
        page.current &&
        motion.current?.playState !== "running" &&
        motion.current?.playState !== "paused"
      )
        prior.current.left = page.current.getBoundingClientRect().left;
      setNarrow(
        frame.clientWidth <
          48 * parseFloat(getComputedStyle(document.documentElement).fontSize),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frame]);
  // Reflow once, then move the page from its previous visual position. Keeping
  // its text unscaled avoids per-frame layout work and reverses from mid-flight.
  useLayoutEffect(() => {
    const element = page.current;
    if (!element || !list) return;
    const previous = prior.current;
    const transform = getComputedStyle(element).transform;
    const shift =
      motion.current && transform !== "none"
        ? new DOMMatrixReadOnly(transform).m41
        : 0;
    motion.current?.cancel();
    motion.current = null;
    const left = element.getBoundingClientRect().left;
    prior.current = { open, left, narrow };
    if (
      !previous ||
      previous.open === open ||
      !animate ||
      narrow ||
      previous.narrow ||
      document.documentElement.hasAttribute("data-keyboard-input") ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const offset = previous.left + shift - left;
    if (!offset) return;
    const tokens = getComputedStyle(element);
    motion.current = element.animate(
      [
        { transform: `translateX(${offset}px)` },
        { transform: "translateX(0px)" },
      ],
      {
        duration: parseFloat(
          tokens.getPropertyValue(open ? "--time-panel-enter" : "--time-fast"),
        ),
        easing: tokens.getPropertyValue("--ease-enter").trim(),
      },
    );
  }, [list, open, animate, narrow]);
  useLayoutEffect(() => () => motion.current?.cancel(), []);
  const visibility = useMemo(
    () => (list ? { open, animate, label: title, controls, setOpen } : null),
    [list, open, animate, title, controls, setOpen],
  );
  return (
    <ConversationListVisibility value={visibility}>
      <section
        ref={setFrame}
        className={styles.frame}
        aria-label={list ? label : undefined}
        data-detail-workspace={list ? "" : undefined}
        data-narrow={narrow || undefined}
      >
        <div
          className={styles.columns}
          data-list-open={open}
          data-list-animate={animate ? "" : undefined}
          data-list-fill={fill || undefined}
        >
          {list && (
            <ResizableSidebar
              scope={`${scope}:collection-list`}
              defaultWidth={352}
              className={styles.list ?? ""}
              id={controls}
              aria-hidden={!open}
              inert={!open}
            >
              {content}
              <div className={styles.dismiss}>
                <ConversationListToggle inList />
              </div>
            </ResizableSidebar>
          )}
          <section
            ref={page}
            className={styles.page}
            aria-label={list ? "Conversation detail" : undefined}
            data-list-page=""
          >
            {children}
          </section>
        </div>
      </section>
    </ConversationListVisibility>
  );
}
