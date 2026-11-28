import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { LinkPreviewProps } from "../../features/conversation/contracts";
import type { Loader, Page } from "./loader";
import { domainOf, splitHost } from "./safety";
import styles from "./LinkPreview.module.css";

function Media({ loader, image }: { loader: Loader; image: string }) {
  const [src, setSrc] = useState(() => loader.peekImage(image));
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    let live = true;
    setBroken(false);
    setSrc(loader.peekImage(image));
    const lease = loader.image(image);
    void lease.src.then((blob) => live && setSrc(blob));
    return () => {
      live = false;
      lease.release();
    };
  }, [loader, image]);
  if (src === null || broken) return null;
  return (
    <span className={styles.media}>
      {src && (
        <img
          src={src}
          alt=""
          decoding="async"
          onError={() => setBroken(true)}
        />
      )}
    </span>
  );
}

/** Every card has the same height from its first frame, whether its page
 * is loading, read, or unreadable, so a preview never moves the reader. */
export function LinkPreview({
  url,
  open,
  loader,
}: LinkPreviewProps & { loader: Loader }) {
  const [page, setPage] = useState<Page | null | undefined>(() =>
    loader.peek(url),
  );
  useEffect(() => {
    let live = true;
    setPage(loader.peek(url));
    const lease = loader.page(url);
    void lease.value.then((found) => live && setPage(found));
    return () => {
      live = false;
      lease.release();
    };
  }, [loader, url]);
  const domain = domainOf(url);
  const siteName =
    page?.siteName && page.siteName.toLowerCase() !== domain.toLowerCase()
      ? page.siteName
      : undefined;
  return (
    <a
      className={styles.card}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-busy={page === undefined || undefined}
      onClick={(event) => {
        // Tauri's external-link opener skips Command-clicks.
        if (event.metaKey && event.button === 0 && isTauri()) {
          event.preventDefault();
          void invoke("plugin:opener|open_url", { url }).catch(() => {});
          return;
        }
        if (
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey &&
          open()
        )
          event.preventDefault();
      }}
    >
      <span className={styles.body}>
        <span className={styles.site}>
          {siteName && (
            <span className={styles.siteName}>
              <bdi>{siteName}</bdi>
              <span>{"\u00a0·\u00a0"}</span>
            </span>
          )}
          <Domain domain={domain} />
        </span>
        {page ? (
          <span className={styles.title}>{page.title}</span>
        ) : (
          <span className={`${styles.title} ${styles.fallback}`}>
            {bareUrl(url)}
          </span>
        )}
        {page?.description && (
          <span className={styles.description}>{page.description}</span>
        )}
      </span>
      {page?.image && <Media loader={loader} image={page.image} />}
    </a>
  );
}

const bareUrl = (url: string) => url.replace(/^https:\/\//i, "");

function Domain({ domain }: { domain: string }) {
  const { subdomains, name, suffix } = splitHost(domain);
  return (
    <bdi className={styles.domain} dir="ltr" title={domain}>
      {subdomains && <span className={styles.subdomains}>{subdomains}</span>}
      <span className={styles.registered}>
        <span>{name}</span>
        <span>{suffix}</span>
      </span>
    </bdi>
  );
}
