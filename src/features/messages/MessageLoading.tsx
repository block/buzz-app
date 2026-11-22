import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import styles from "./Messages.module.css";
import loading from "./MessageLoading.module.css";

/** Read placeholders share message geometry; announcements retain the quiet
 * delay, for screen readers only. */
export function MessageLoading({
  label = "Loading messages…",
}: {
  label?: string;
}) {
  return (
    <div className={styles.threadLoading}>
      <LoadingRegion pending label={label} statusVisibility="screen-reader">
        <div
          className={loading.messages}
          aria-hidden="true"
          data-message-loading=""
        >
          {[0, 1, 2].map((row) => (
            <div key={row} className={loading.row}>
              <span className={`${loading.box} ${loading.avatar}`} />
              <div className={loading.body}>
                <span className={`${loading.box} ${loading.name}`} />
                <span className={`${loading.box} ${loading.text}`} />
                <span className={`${loading.box} ${loading.tail}`} />
              </div>
            </div>
          ))}
        </div>
      </LoadingRegion>
    </div>
  );
}
