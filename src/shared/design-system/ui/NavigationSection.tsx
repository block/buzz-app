import { type ReactNode, type RefObject, useLayoutEffect, useRef } from "react";

export function NavigationSection({
  label,
  action,
  children,
}: {
  label?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      data-buzz-ui=""
      className="navigation-section"
      data-headingless={!label || undefined}
    >
      {(label || action) && (
        <NavigationSectionHeading actions={action}>
          {label && <h2 className="navigation-section-label">{label}</h2>}
        </NavigationSectionHeading>
      )}
      <div className="navigation-section-rows">{children}</div>
    </section>
  );
}

export type NavigationSectionTrailing = {
  accessory?: ReactNode;
  metadata?: ReactNode;
};

/**
 * One heading row: the label fills the available width and the actions hug the
 * trailing edge. Use "overlay" to keep the label width on hover. Use
 * "in-flow" when overlap would cover the label or its controls.
 *
 * `disclosure` headings collapse their section. Their label is the feature's
 * own disclosure trigger, which keeps the row's inset as its hit area and
 * focus ring. Quiet parts, `revealActions` or any descendant marked
 * `data-navigation-reveal` such as a chevron, appear on hover, keyboard focus,
 * and while a menu or popover from the heading is open. On touch, actions stay
 * visible beside the label. A stable trailing slot keeps its accessory mounted
 * when metadata changes. Metadata sets the hover target for an overlay reveal.
 * Plain `revealActions` that would cover the label wrap below it, and keep that
 * row while hidden, so revealing them never changes the height.
 */
export function NavigationSectionHeading({
  actions,
  disclosure = false,
  revealActions = false,
  trailing,
  children,
}: {
  actions?: ReactNode;
  disclosure?: boolean;
  revealActions?: boolean | "overlay" | "in-flow";
  trailing?: NavigationSectionTrailing | undefined;
  children?: ReactNode;
}) {
  const { accessory, metadata } = trailing ?? {};
  const hasMetadata = metadata != null && typeof metadata !== "boolean";
  const reserveSpace =
    hasMetadata || (accessory != null && typeof accessory !== "boolean");
  const swap = hasMetadata && !!actions && revealActions;
  const heading = useRef<HTMLDivElement>(null);
  const actionsBox = useRef<HTMLDivElement>(null);
  // Only plain revealed actions can wrap; an overlay or trailing slot keeps
  // its own space.
  useActionsRow(
    heading,
    actionsBox,
    revealActions === true && !!actions && !trailing,
  );
  return (
    <div
      ref={heading}
      className="navigation-section-heading"
      data-disclosure={disclosure || undefined}
    >
      <div className="navigation-section-heading-label">{children}</div>
      {!trailing && actions && (
        <div
          ref={actionsBox}
          className="navigation-section-heading-actions"
          data-navigation-reveal={revealActions || undefined}
        >
          {actions}
        </div>
      )}
      {trailing && (reserveSpace || actions) && (
        <div
          className="navigation-section-heading-trailing"
          data-reserve-space={reserveSpace || undefined}
          data-has-metadata={hasMetadata || undefined}
        >
          {accessory}
          {(hasMetadata || actions) && (
            <div
              className="navigation-section-heading-actions"
              data-has-metadata={hasMetadata || undefined}
              data-navigation-reveal={
                (!reserveSpace && revealActions) || undefined
              }
            >
              {hasMetadata && (
                <div
                  className="navigation-section-heading-metadata"
                  data-navigation-reveal-rest={swap || undefined}
                >
                  {metadata}
                </div>
              )}
              {actions && (
                <div
                  className="navigation-section-heading-buttons"
                  data-navigation-reveal={
                    (reserveSpace && revealActions) || undefined
                  }
                >
                  {actions}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Marks a heading whose revealed actions wrap below the label, so CSS keeps
 * their row while they are hidden. It asks layout itself: lay the actions out
 * as revealed, see whether they wrap, and restore it, all before paint.
 */
function useActionsRow(
  headingRef: RefObject<HTMLDivElement | null>,
  actionsRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
) {
  useLayoutEffect(() => {
    const heading = headingRef.current;
    const actions = actionsRef.current;
    if (
      !enabled ||
      !heading ||
      !actions ||
      typeof ResizeObserver === "undefined"
    )
      return;
    const label = heading.firstElementChild as HTMLElement;
    const measure = () => {
      // A hidden heading has no layout to ask; keep the last answer, so it
      // shows again at its old height instead of a reserved row for a frame.
      if (!heading.getClientRects().length) return;
      heading.setAttribute("data-actions-measure", "");
      const wraps =
        actions.getBoundingClientRect().top >=
        label.getBoundingClientRect().bottom - 0.5;
      heading.removeAttribute("data-actions-measure");
      heading.toggleAttribute("data-actions-row", wraps);
    };
    // Hidden buttons keep their size, so text scale reaches them too.
    const resize = new ResizeObserver(measure);
    const observe = () => {
      resize.disconnect();
      resize.observe(heading);
      for (const button of actions.children) resize.observe(button);
      measure();
    };
    const mutations = new MutationObserver(observe);
    mutations.observe(actions, { childList: true });
    observe();
    return () => {
      resize.disconnect();
      mutations.disconnect();
      heading.removeAttribute("data-actions-row");
    };
  }, [headingRef, actionsRef, enabled]);
}
