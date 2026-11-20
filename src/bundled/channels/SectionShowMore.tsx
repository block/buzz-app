import { CaretDownIcon, CaretUpIcon } from "../../shared/design-system/icons";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import type { SectionCap } from "./sidebar-section-caps";
import styles from "./Channels.module.css";

/** Show more and Show fewer below a capped section's rows, starting at the
 * row titles. They share a line when it fits and stack otherwise. */
export function SectionShowMore({
  sectionKey,
  title,
  cap,
  more,
  fewer,
}: {
  sectionKey: string;
  title: string;
  cap: SectionCap;
  more(): void;
  fewer(): void;
}) {
  if (!cap.hidden && !cap.foldable) return null;
  return (
    <div className={styles.sectionShowMore} data-section-show-more={sectionKey}>
      {cap.hidden > 0 && (
        <NavigationItem
          variant="text"
          data-show-more-expand=""
          label={`Show ${cap.next} more`}
          aria-label={`Show ${cap.next} more in ${title}`}
          trailing={<CaretDownIcon size={14} aria-hidden="true" />}
          onClick={more}
        />
      )}
      {cap.foldable && (
        <NavigationItem
          variant="text"
          data-show-more-fold=""
          label="Show fewer"
          aria-label={`Show fewer in ${title}`}
          trailing={<CaretUpIcon size={14} aria-hidden="true" />}
          onClick={fewer}
        />
      )}
    </div>
  );
}
