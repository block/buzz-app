/**
 * PROTOTYPE: the app icons in the top bar, where the vertical dock was, so
 * the workspace gets the dock's width back. When they don't all fit, the rest
 * wait behind •••. Hovering ••• (or moving focus into the row) slides them out
 * while Search folds to its icon; leaving puts both back. It is a hover state,
 * never a saved one.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react";
import { DotsThreeIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { PageNavigation } from "./PageNavigation";
import styles from "./TopPages.module.css";

/** Tile and gap, in rem, as TopPages.module.css lays them out. */
const TILE_REM = 2;
const GAP_REM = 0.25;
/** Long enough to cross the gap between ••• and the icons it revealed. */
const LEAVE_MS = 220;

type Props = Omit<ComponentProps<typeof PageNavigation>, "placement"> & {
  /** Search folds to its icon while the row is expanded. */
  onExpandedChange?(expanded: boolean): void;
};

export function TopPages({ onExpandedChange, ...props }: Props) {
  const nav = useRef<HTMLElement>(null);
  const count = props.pages.length;
  const [fit, setFit] = useState(count);
  const [expanded, setExpandedState] = useState(false);
  const expandedRef = useRef(false);
  const leaving = useRef<number | undefined>(undefined);
  const setExpanded = (next: boolean) => {
    window.clearTimeout(leaving.current);
    if (expandedRef.current === next) return;
    expandedRef.current = next;
    setExpandedState(next);
    onExpandedChange?.(next);
  };
  const collapseSoon = () => {
    window.clearTimeout(leaving.current);
    leaving.current = window.setTimeout(() => setExpanded(false), LEAVE_MS);
  };
  useEffect(() => () => window.clearTimeout(leaving.current), []);
  // How many icons fit beside Search at its full width. Measured only while
  // collapsed: expanding widens this row because Search gives up its room.
  useLayoutEffect(() => {
    const element = nav.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      // Not laid out (hidden, or no layout engine): show every icon.
      if (expandedRef.current || element.clientWidth === 0) return;
      const rem = Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      const step = (TILE_REM + GAP_REM) * rem;
      const available = element.clientWidth + GAP_REM * rem;
      const all = Math.floor(available / step);
      // Room for every icon, or for some of them and •••.
      setFit(all >= count ? count : Math.max(1, all - 1));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [count]);
  const overflow = fit < count;
  // The open app always shows, swapped into the last visible slot.
  let pages = props.pages;
  const open = pages.findIndex((page) => page.key === props.selected);
  const current = pages[open];
  if (overflow && current && open >= fit) {
    const rest = pages.filter((page) => page !== current);
    pages = [...rest.slice(0, fit - 1), current, ...rest.slice(fit - 1)];
  }
  // Nothing hides once everything fits again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a change in overflow collapses the row.
  useEffect(() => {
    if (!overflow && expandedRef.current) setExpanded(false);
  }, [overflow]);
  return (
    <nav
      ref={nav}
      aria-label="Apps dock"
      className={styles.pages}
      data-overflow={overflow || undefined}
      data-expanded={expanded || undefined}
      style={
        {
          "--top-pages-visible": overflow && !expanded ? fit : count,
        } as CSSProperties
      }
      onPointerLeave={() => expandedRef.current && collapseSoon()}
      onPointerEnter={() => window.clearTimeout(leaving.current)}
      onFocus={() => overflow && setExpanded(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setExpanded(false);
      }}
    >
      <div className={styles.strip}>
        <PageNavigation {...props} pages={pages} placement="top" />
      </div>
      {overflow && (
        <span className={styles.more}>
          <IconButton
            variant="ghost"
            size="sm"
            aria-label="More pages"
            title={expanded ? undefined : "More pages"}
            aria-expanded={expanded}
            // Hidden icons are reachable without hover: focus or a press shows them.
            onPointerEnter={() => setExpanded(true)}
            onClick={() => setExpanded(!expandedRef.current)}
            icon={<DotsThreeIcon aria-hidden="true" size={16} />}
          />
        </span>
      )}
    </nav>
  );
}
