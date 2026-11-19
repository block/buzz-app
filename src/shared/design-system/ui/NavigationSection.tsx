import type { ReactNode } from "react";

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

/**
 * The label fills the available width and the actions hug the trailing edge.
 *
 * `disclosure` headings collapse their section. Their label is the feature's
 * own disclosure trigger, which keeps the row's inset as its hit area and
 * focus ring. Quiet parts, `revealActions` or any descendant marked
 * `data-navigation-reveal` such as a chevron, appear on hover, keyboard focus,
 * while a menu from the heading is open or one of them has focus, and always
 * on touch. A heading with an accessory keeps the action space so its controls
 * stay in place. Optional metadata sets the footprint of the trailing hover
 * target. On pointer devices, quiet actions can overlay an adjacent accessory.
 * On touch and when there is no accessory, the slot fits the full action strip.
 * Other headings give that space to the label until actions appear.
 */
export function NavigationSectionHeading({
  actions,
  disclosure = false,
  revealActions = false,
  reserveActionSpace = false,
  accessory,
  metadata,
  children,
}: {
  actions?: ReactNode;
  disclosure?: boolean;
  revealActions?: boolean;
  reserveActionSpace?: boolean;
  accessory?: ReactNode;
  metadata?: ReactNode;
  children?: ReactNode;
}) {
  const hasMetadata = metadata != null && typeof metadata !== "boolean";
  const swap = hasMetadata && !!actions && revealActions;
  return (
    <div
      className="navigation-section-heading"
      data-disclosure={disclosure || undefined}
    >
      <div className="navigation-section-heading-label">{children}</div>
      {(accessory || hasMetadata || actions) && (
        <div
          className="navigation-section-heading-trailing"
          data-reserve-space={hasMetadata || reserveActionSpace || undefined}
          data-has-metadata={hasMetadata || undefined}
        >
          {accessory}
          {(hasMetadata || actions) && (
            <div
              className="navigation-section-heading-actions"
              data-has-metadata={hasMetadata || undefined}
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
                  data-navigation-reveal={revealActions || undefined}
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
