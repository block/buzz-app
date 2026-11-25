import { namingGuidelinesUrl } from "./channel-naming-policy";
import styles from "./NamingGuidelinesLink.module.css";

/** The "How channel names work" link, when the build sets a guide address. */
export function NamingGuidelinesLink() {
  const url = namingGuidelinesUrl();
  if (!url) return null;
  return (
    <a className={styles.link} href={url} target="_blank" rel="noreferrer">
      How channel names work
    </a>
  );
}
