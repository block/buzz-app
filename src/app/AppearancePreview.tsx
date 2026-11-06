import type { MessageDensity, MessageWidth } from "../shared/theme/service";
import styles from "./AppearancePreview.module.css";

/** Decorative app sketch using the same semantic colors as the live interface. */
export function AppearancePreview({
  messageWidth,
  density,
}: {
  messageWidth: MessageWidth;
  density: MessageDensity;
}) {
  return (
    <figure className={styles.preview} aria-label="Appearance preview">
      <div className={styles.scene} inert aria-hidden="true">
        <div className={styles.sidebar}>
          <div className={styles.workspace}>
            <i />
            <span />
          </div>
          <div className={styles.nav}>
            <span />
          </div>
          <div className={styles.nav} data-selected>
            <span />
          </div>
          <div className={styles.nav}>
            <span />
          </div>
        </div>
        <div className={styles.conversation}>
          <div className={styles.heading}>
            <span />
          </div>
          <div
            className={styles.messageColumn}
            data-message-width={messageWidth}
            data-message-density={density}
          >
            <div className={styles.messages}>
              <div className={styles.received}>
                <i className={styles.avatar} />
                <div className={styles.bubble}>
                  <span />
                  <span />
                  <span className={styles.link} />
                </div>
              </div>
              <div className={styles.sent}>
                <i className={styles.avatar} />
                <div className={styles.bubble} data-own>
                  <span />
                  <span />
                </div>
              </div>
            </div>
            <div className={styles.composer}>
              <span />
              <i />
            </div>
          </div>
        </div>
      </div>
      <figcaption className="sr-only">
        Illustrated preview of your current mode, accent, contrast,{" "}
        {messageWidth} message width, and {density} message density.
      </figcaption>
    </figure>
  );
}
